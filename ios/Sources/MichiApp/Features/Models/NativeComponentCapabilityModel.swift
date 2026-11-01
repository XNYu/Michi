import Foundation
import Combine
import MichiCore

struct NativeComponentCapabilityToken: Equatable {
    var capability: String
    var expiresAt: Double
    var componentID: String
    var version: Int
    var host: JSONValue
    var props: JSONValue
}

enum NativeComponentCapabilityError: LocalizedError, Equatable {
    case preview
    case paused
    case unavailable(String)
    case reserved(String)
    case pageWrite
    case stale
    case disabled

    var errorDescription: String? {
        switch self {
        case .preview: return "This capability is unavailable"
        case .paused: return "Component source unavailable"
        case .unavailable(let message): return message
        case .reserved(let message): return message
        case .pageWrite: return "This component host cannot write database rows."
        case .stale: return "Component host changed"
        case .disabled: return "This component is disabled or unavailable."
        }
    }
}

/// A mint or call outcome the runtime must act on. Nothing is replayed.
enum NativeComponentCapabilitySignal: Equatable {
    /// 401/403/404 mint: the component, version, or host is gone or not allowed.
    case sourceMissing(String)
    /// 409 mint or call: the pinned/active version or binding no longer matches.
    case sourceChanged(String)
}

struct NativeComponentCapabilityTiming: Equatable {
    /// Wait before minting again when no current token exists.
    var retry: TimeInterval = 10
    var minimumRetry: TimeInterval = 1
    /// Renew this long before expiry.
    var renewLead: TimeInterval = 20
}

/// Every token this host was given and has not revoked yet. Revoking is
/// idempotent; `deinit` revokes the rest so a torn-down host leaves no live
/// token behind. Holds no reference back to the model.
///
/// Production teardown uses `deinit` (fire-and-forget DELETE on a live
/// session). Tests and any caller that will invalidate the session must
/// `await drain()` first so those DELETEs finish while `URLSession` is valid.
final class NativeComponentCapabilityRevoker: @unchecked Sendable {
    private let lock = NSLock()
    private let api: MichiAPI
    private var live: [Data: String] = [:]
    private var outgoing: [Task<Void, Never>] = []
    private var draining = false

    init(api: MichiAPI) { self.api = api }

    var liveCount: Int { lock.lock(); defer { lock.unlock() }; return live.count }

    func track(_ capability: String) {
        guard !capability.isEmpty else { return }
        lock.lock()
        let closing = draining
        if !closing { live[Data(capability.utf8)] = capability }
        lock.unlock()
        if closing { enqueue(capability) }
    }

    func revoke(_ capability: String) {
        lock.lock(); let removed = live.removeValue(forKey: Data(capability.utf8)); lock.unlock()
        if let removed { enqueue(removed) }
    }

    /// Sends every remaining token and waits for every in-flight DELETE.
    /// Safe to call more than once. After this returns, `deinit` has nothing
    /// left to start, so a later `URLSession` invalidation cannot crash.
    func drain() async {
        while true {
            let (remaining, started) = takeLiveAndStartedForDrain()
            for capability in remaining { enqueue(capability) }
            let batch = takeDrainBatch(started)
            if batch.isEmpty { return }
            for task in batch { await task.value }
        }
    }

    /// Snapshot under the lock only. `drain` awaits outside this helper.
    private func takeLiveAndStartedForDrain() -> (remaining: [String], started: [Task<Void, Never>]) {
        lock.lock()
        draining = true
        let remaining = Array(live.values)
        live.removeAll()
        let started = outgoing
        outgoing.removeAll()
        lock.unlock()
        return (remaining, started)
    }

    /// Collects DELETEs enqueued after the snapshot. Lock is not held across await.
    private func takeDrainBatch(_ started: [Task<Void, Never>]) -> [Task<Void, Never>] {
        lock.lock()
        let batch = started + outgoing
        outgoing.removeAll()
        lock.unlock()
        return batch
    }

    deinit {
        lock.lock()
        let remaining = Array(live.values)
        live.removeAll()
        lock.unlock()
        // Production guarantee: a torn-down host still revokes. These tasks
        // are not stored on self. Callers that invalidate the session must
        // drain first; otherwise this is the same fire-and-forget DELETE.
        for capability in remaining {
            Task.detached { [api] in
                await Self.send(api: api, capability)
            }
        }
    }

    private func enqueue(_ capability: String) {
        let task = Task.detached { [api] in
            await Self.send(api: api, capability)
        }
        lock.lock(); outgoing.append(task); lock.unlock()
    }

    private static func send(api: MichiAPI, _ capability: String) async {
        _ = try? await api.request("/component-capabilities/\(MichiAPI.pathSegment(capability))", method: "DELETE")
    }
}

/// URLSession mint/call/revoke. A failed call is never replayed. Preview,
/// disabled and paused scopes never mint.
///
/// `authority` changes whenever the grant a worker acts under changes: a new
/// identity (component, version, host, props, binding), a stop or pause, or a
/// renewal that returns different granted props. A renewal of the same grant
/// rotates the token but keeps `authority`, so it never reloads the worker.
@MainActor final class NativeComponentCapabilityModel: ObservableObject {
    let api: MichiAPI
    let workspaceID: String
    let revoker: NativeComponentCapabilityRevoker
    @Published private(set) var token: NativeComponentCapabilityToken?
    @Published private(set) var error: String?
    @Published private(set) var paused = false
    private(set) var scope: Data?
    private(set) var identity: Data?
    private(set) var authority = 0
    var onTokenChange: ((NativeComponentCapabilityToken?) -> Void)?
    var onSignal: ((NativeComponentCapabilitySignal) -> Void)?
    private var generation = 0
    private var target: Target?
    private var mintingGeneration: Int?
    private var mintTask: Task<Void, Never>?
    private var renewTask: Task<Void, Never>?
    private var invalidated: Data?
    private let timing: NativeComponentCapabilityTiming
    private let now: () -> Date

    private struct Target {
        var componentID: String
        var version: Int
        var host: JSONValue
        var props: JSONValue
    }

    init(api: MichiAPI, workspaceID: String, timing: NativeComponentCapabilityTiming = NativeComponentCapabilityTiming(),
         now: @escaping () -> Date = Date.init) {
        self.api = api; self.workspaceID = workspaceID; self.timing = timing; self.now = now
        revoker = NativeComponentCapabilityRevoker(api: api)
    }

    var hasCapability: Bool { token.map { !$0.capability.isEmpty } == true }

    /// Same identity bytes keep the current token or mint. Anything else stops,
    /// revokes, and mints for the new identity. Enabling clears `paused`.
    func configure(componentID: String, version: Int, host: JSONValue, props: JSONValue, bindingKey: JSONValue = .null,
                   enabled: Bool, preview: Bool) {
        let nextScope = Self.scopeKey(workspaceID: workspaceID, componentID: componentID, version: version, host: host)
        let nextIdentity = Self.identityKey(scope: nextScope, props: props, bindingKey: bindingKey, enabled: enabled, preview: preview)
        if let identity, let nextIdentity, identity == nextIdentity { return }
        stop()
        scope = nextScope
        identity = nextIdentity
        guard enabled, !preview, version >= 1, ComponentSandbox.isID(.string(componentID)),
              ComponentSandbox.parseHost(host) != nil, nextIdentity != nil, ComponentSandbox.bounded(props) else {
            if preview { error = nil }
            else if !enabled { error = NativeComponentCapabilityError.disabled.errorDescription }
            else { error = "This component host is not supported." }
            return
        }
        paused = false
        target = Target(componentID: componentID, version: version, host: host, props: props)
        startMint(generation: generation)
    }

    func pause(reason: String? = NativeComponentCapabilityError.paused.errorDescription) {
        stop(reason: reason, keepError: true)
        paused = true
    }

    /// Ends the current grant: revokes the token, cancels renewal, and forgets
    /// the identity so the next `configure` always mints again.
    func stop(reason: String? = nil, keepError: Bool = false) {
        generation += 1
        authority += 1
        renewTask?.cancel(); renewTask = nil
        target = nil
        identity = nil
        scope = nil
        invalidated = nil
        let previous = token
        token = nil
        if !keepError { error = reason }
        else if let reason { error = reason }
        if let previous { revoker.revoke(previous.capability) }
        onTokenChange?(nil)
    }

    /// Ends the grant, waits for an already-started mint to install-or-revoke,
    /// then drains every DELETE. Production `deinit` still revokes anything
    /// left if this is never called. Tests must await this before invalidating
    /// the transport session.
    func shutdown() async {
        stop()
        let mint = mintTask
        mintTask = nil
        await mint?.value
        await revoker.drain()
    }

    func call(method: String, args: JSONValue, host: JSONValue) async throws -> JSONValue {
        if paused { throw NativeComponentCapabilityError.paused }
        guard let current = token, !current.capability.isEmpty else {
            throw NativeComponentCapabilityError.unavailable(error ?? NativeComponentCapabilityError.preview.errorDescription!)
        }
        guard ComponentSandbox.sameJSON(host, current.host) else { throw NativeComponentCapabilityError.stale }
        let prepared = try NativeComponentCapabilityModel.prepareCall(method: method, args: args, host: host)
        let capturedGeneration = generation
        do {
            return try await invoke(token: current, call: prepared)
        } catch {
            handleCallFailure(error, token: current, generation: capturedGeneration)
            throw error
        }
    }

    static func scopeKey(workspaceID: String, componentID: String, version: Int, host: JSONValue) -> Data? {
        ComponentSandbox.canonicalData([
            "workspaceId": .string(workspaceID), "componentId": .string(componentID),
            "version": .number(Double(version)), "host": host,
        ])
    }

    static func identityKey(scope: Data?, props: JSONValue, bindingKey: JSONValue, enabled: Bool, preview: Bool) -> Data? {
        guard let scope, let rest = ComponentSandbox.canonicalData([
            "props": props, "bindingKey": bindingKey, "enabled": .bool(enabled), "preview": .bool(preview),
        ]) else { return nil }
        return scope + Data([0]) + rest
    }

    static func prepareCall(method: String, args: JSONValue, host: JSONValue) throws -> JSONValue {
        guard ComponentSandbox.methods.contains(method) else { throw NativeComponentCapabilityError.reserved("This capability is unavailable") }
        guard case .array(let values) = args, values.count <= 20, (ComponentSandbox.byteCount(args) ?? .max) <= 64_000 else {
            throw NativeComponentCapabilityError.reserved("Invalid component arguments")
        }
        let parsedHost = ComponentSandbox.parseHost(host)
        switch method {
        case "read.host":
            guard values.isEmpty else { throw NativeComponentCapabilityError.reserved("Invalid read.host arguments") }
            return ["method": "read.host", "args": []]
        case "read.database":
            if values.count == 1, let resource = values[0].optionalString, ComponentSandbox.isID(.string(resource)) {
                return ["method": "read.database", "resourceId": .string(resource), "args": []]
            }
            if values.isEmpty, parsedHost?.kind == .databaseView {
                return ["method": "read.database", "args": []]
            }
            throw NativeComponentCapabilityError.reserved("Invalid read.database arguments")
        case "write.rows":
            guard parsedHost?.kind == .databaseView else { throw NativeComponentCapabilityError.pageWrite }
            guard values.count == 1, case .array(let ops) = values[0], ops.count <= 200 else {
                throw NativeComponentCapabilityError.reserved("Invalid write.rows arguments")
            }
            return ["method": "write.rows", "args": args]
        case "resize":
            guard values.count == 1, ComponentSandbox.safeInteger(values[0]) != nil else {
                throw NativeComponentCapabilityError.reserved("Height must be a number")
            }
            return ["method": "resize", "args": args]
        case "navigate.page":
            guard values.count == 1, let page = values[0].optionalString, !page.isEmpty, page.utf16.count <= 200 else {
                throw NativeComponentCapabilityError.reserved("Invalid navigate.page arguments")
            }
            return ["method": "navigate.page", "args": args]
        case "ask.draft":
            guard values.count == 1, let draft = values[0].optionalString, !draft.isEmpty, draft.utf16.count <= ComponentSandbox.draftCharacters else {
                throw NativeComponentCapabilityError.reserved("Invalid ask.draft arguments")
            }
            return ["method": "ask.draft", "args": args]
        default:
            throw NativeComponentCapabilityError.reserved("This capability is unavailable")
        }
    }

    /// The echo must match the request byte for byte; the granted props are the
    /// host-owned persisted props and are used exactly as returned.
    static func parseMint(_ payload: JSONValue, componentID: String, version: Int, host: JSONValue) throws -> NativeComponentCapabilityToken {
        guard let capability = payload["capability"].optionalString,
              capability.utf8.count >= ComponentSandbox.capabilityMinimumLength, capability.utf8.count <= 4_096,
              let expires = payload["expiresAt"].featureOptionalNumber, expires.isFinite, expires > 0,
              let echoedID = payload["componentId"].optionalString, ComponentSandbox.sameID(echoedID, componentID),
              ComponentSandbox.safeInteger(payload["version"]) == version,
              ComponentSandbox.sameJSON(payload["host"], host),
              case .object = payload["props"], ComponentSandbox.bounded(payload["props"]) else {
            throw NativeComponentCapabilityError.unavailable("The component capability could not be verified.")
        }
        return NativeComponentCapabilityToken(capability: capability, expiresAt: expires, componentID: componentID, version: version, host: host, props: payload["props"])
    }

    static func writeChanged(_ result: JSONValue) -> Bool {
        ["applied", "proposed"].contains { key in
            if case .array(let items) = result[key] { return !items.isEmpty }
            return false
        }
    }

    /// A `write.rows` result the backend is known to produce. Anything else is
    /// an unconfirmed outcome.
    static func confirmedWrite(_ result: JSONValue) -> Bool {
        guard case .object = result else { return false }
        return ["applied", "proposed", "rejected"].allSatisfy { key in
            if case .array = result[key] { return true }
            return false
        }
    }

    /// True when a `write.rows` request may have been applied without a
    /// trustworthy answer: no response, cancellation, timeout, 408, 5xx, a 3xx,
    /// or an unreadable 2xx. Local refusals and other 4xx answers were not applied.
    static func writeOutcomeUnknown(_ error: Error) -> Bool {
        if error is NativeComponentCapabilityError { return false }
        if error is CancellationError { return true }
        guard let failure = error as? MichiAPIError else { return true }
        guard let status = failure.statusCode else {
            let unsent = [MichiAPIError.Code.invalidConfiguration, MichiAPIError.Code.invalidPath,
                          MichiAPIError.Code.invalidRequest, MichiAPIError.Code.insecureURL]
            return !unsent.contains(failure.code ?? "")
        }
        if status == 408 { return true }
        return !(400..<500).contains(status)
    }

    static func mintMissing(_ error: Error) -> Bool {
        guard let failure = error as? MichiAPIError, let status = failure.statusCode else { return false }
        return status == 401 || status == 403 || status == 404
    }

    static func mintConflict(_ error: Error) -> Bool {
        guard let failure = error as? MichiAPIError, failure.statusCode == 409 else { return false }
        return failure.message != "Component capability service is busy"
    }

    static func hostChanged(_ error: Error) -> Bool {
        guard let failure = error as? MichiAPIError else { return false }
        return failure.statusCode == 409 && failure.message == "Component host changed"
    }

    static func versionChanged(_ error: Error) -> Bool {
        guard let failure = error as? MichiAPIError else { return false }
        return failure.statusCode == 409 && failure.message == "Component version changed"
    }

    private func handleCallFailure(_ error: Error, token captured: NativeComponentCapabilityToken, generation capturedGeneration: Int) {
        guard capturedGeneration == generation, !paused, let current = token,
              ComponentSandbox.sameID(current.capability, captured.capability) else { return }
        if ComponentSandbox.isExpiredCapability(error) || Self.hostChanged(error) {
            let key = Data(captured.capability.utf8)
            guard invalidated != key else { return }
            invalidated = key
            token = nil
            self.error = Self.hostChanged(error) ? "Component host changed; renewing" : "Component capability expired; renewing"
            revoker.revoke(captured.capability)
            onTokenChange?(nil)
            startMint(generation: generation)
        } else if Self.versionChanged(error) {
            let message = error.localizedDescription
            stop(reason: message, keepError: true)
            onSignal?(.sourceChanged(message))
        }
    }

    private func startMint(generation captured: Int) {
        guard let target, mintingGeneration != captured else { return }
        mintingGeneration = captured
        mintTask = Task { [weak self] in
            await self?.mint(generation: captured, target: target)
        }
    }

    private func mint(generation captured: Int, target: Target) async {
        defer { if mintingGeneration == captured { mintingGeneration = nil } }
        do {
            let payload = try await api.request("/component-capabilities", method: "POST", body: [
                "workspaceId": .string(workspaceID), "componentId": .string(target.componentID),
                "version": .number(Double(target.version)), "host": target.host, "props": target.props,
            ])
            // Tracked before verification, so a rejected or late token is revoked too.
            let minted = payload["capability"].optionalString ?? ""
            revoker.track(minted)
            let next: NativeComponentCapabilityToken
            do {
                next = try NativeComponentCapabilityModel.parseMint(payload, componentID: target.componentID, version: target.version, host: target.host)
            } catch {
                revoker.revoke(minted)
                throw error
            }
            guard captured == generation, !paused else {
                revoker.revoke(next.capability)
                return
            }
            let previous = token
            if let previous, !ComponentSandbox.sameJSON(previous.props, next.props) { authority += 1 }
            token = next
            error = nil
            invalidated = nil
            if let previous, !ComponentSandbox.sameID(previous.capability, next.capability) { revoker.revoke(previous.capability) }
            onTokenChange?(next)
            scheduleRenew(generation: captured, expiresAt: next.expiresAt)
        } catch is CancellationError {
            return
        } catch {
            guard captured == generation, !paused else { return }
            self.error = error.localizedDescription
            if Self.mintMissing(error) {
                onSignal?(.sourceMissing(error.localizedDescription))
                return
            }
            if Self.mintConflict(error) { onSignal?(.sourceChanged(error.localizedDescription)) }
            guard captured == generation, !paused else { return }
            scheduleRetry(generation: captured)
        }
    }

    private func scheduleRetry(generation captured: Int) {
        let remaining = token.map { ($0.expiresAt - now().timeIntervalSince1970 * 1000) / 1000 } ?? 0
        let delay = remaining > 0 ? min(timing.retry, max(timing.minimumRetry, remaining)) : timing.retry
        schedule(after: delay, generation: captured)
    }

    private func scheduleRenew(generation captured: Int, expiresAt: Double) {
        let wait = max(timing.minimumRetry, (expiresAt - now().timeIntervalSince1970 * 1000) / 1000 - timing.renewLead)
        schedule(after: wait, generation: captured)
    }

    /// Only the wait is cancellable; a started mint always completes so that a
    /// token the server issued is either installed or revoked.
    private func schedule(after delay: TimeInterval, generation captured: Int) {
        renewTask?.cancel()
        renewTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(max(0, delay) * 1_000_000_000))
            guard !Task.isCancelled, let self, captured == self.generation, !self.paused else { return }
            self.startMint(generation: captured)
        }
    }

    private func invoke(token: NativeComponentCapabilityToken, call: JSONValue) async throws -> JSONValue {
        let route = "/component-capabilities/\(MichiAPI.pathSegment(token.capability))"
        let payload = try await api.request(route, method: "POST", body: call)
        guard case .object(let fields) = payload, fields.keys.contains("result") else {
            throw MichiAPIError(statusCode: 200, code: MichiAPIError.Code.invalidResponse,
                                message: "The component service returned an unexpected response.")
        }
        return payload["result"]
    }
}
