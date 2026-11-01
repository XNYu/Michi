import Foundation
import Combine
import CryptoKit
import MichiCore

struct NativeComponentRuntimeTiming: Equatable {
    /// Source and page-data refresh while visible.
    var refresh: TimeInterval = 10
    /// Per host call; frees the slot and answers the worker.
    var call: TimeInterval = Double(ComponentSandbox.hostCallTimeoutMilliseconds) / 1000
    /// From session install to the first `rendered`.
    var firstRender: TimeInterval = Double(ComponentSandbox.timeoutMilliseconds) / 1000
    var previewDebounce: TimeInterval = 0.35
    var capability = NativeComponentCapabilityTiming()
}

/// Durable marker for a `write.rows` call. A scoped pending record is written
/// *before* the request and upgraded to unknown when the outcome cannot be
/// trusted. It holds only the scope, a request identity, a time and a
/// version — never arguments, tokens or credentials. While a file exists,
/// the host refuses new writes. Unknown records are never cleared
/// automatically; a confirmed pending record is cleared only when the
/// request identity still matches.
final class NativeComponentWriteGuardStore: @unchecked Sendable {
    static let persistFailureMessage = "The write could not be recorded locally, so it was not submitted."
    static let concurrentFailureMessage = "A previous database write is unconfirmed. Check the data and acknowledge it before writing again."
    private static let lock = NSLock()
    let directory: URL?

    init(directory: URL? = nil) {
        self.directory = directory ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
            .appendingPathComponent("Michi/ComponentWriteGuards.v1", isDirectory: true)
    }

    static func scope(api: MichiAPI, workspaceID: String, componentID: String, host: JSONValue) -> JSONValue {
        [
            "connection": .string(api.baseURL.absoluteString),
            "credential": .string(api.credentialIdentityFingerprint),
            "workspaceId": .string(workspaceID),
            "componentId": .string(componentID),
            "host": host,
        ]
    }

    /// Random request identity. Not a capability token and not derived from
    /// the write payload.
    static func makeRequestID() -> String {
        (0..<16).map { _ in String(format: "%02x", UInt8.random(in: 0...255)) }.joined()
    }

    private func fileURL(scope: JSONValue) -> URL? {
        guard let directory, let data = ComponentSandbox.canonicalData(scope) else { return nil }
        let hash = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        return directory.appendingPathComponent(hash + ".json")
    }

    /// A record that exists but cannot be verified still blocks (fails closed).
    func isBlocked(scope: JSONValue) -> Bool {
        Self.lock.lock(); defer { Self.lock.unlock() }
        guard let url = fileURL(scope: scope), FileManager.default.fileExists(atPath: url.path) else { return false }
        return true
    }

    /// Fails closed if a marker for this scope already exists or cannot be
    /// persisted and verified. The request is not sent in those cases.
    func reserve(scope: JSONValue, requestID: String, at: Double, version: Int) throws {
        Self.lock.lock(); defer { Self.lock.unlock() }
        guard let directory, let url = fileURL(scope: scope) else {
            throw NativeFailure(Self.persistFailureMessage)
        }
        if FileManager.default.fileExists(atPath: url.path) {
            throw NativeFailure(Self.concurrentFailureMessage)
        }
        try writeLocked(url: url, directory: directory, scope: scope, requestID: requestID, at: at, version: version, state: "pending")
    }

    /// Upgrades this request to a sticky unknown marker. Another screen's or
    /// a newer request's file is left untouched.
    func markUnknown(scope: JSONValue, requestID: String, at: Double, version: Int) throws {
        Self.lock.lock(); defer { Self.lock.unlock() }
        guard let directory, let url = fileURL(scope: scope) else {
            throw NativeFailure("Local storage is unavailable, so the unconfirmed write is kept only until the app closes.")
        }
        if FileManager.default.fileExists(atPath: url.path) {
            guard let current = try? readLocked(url: url), ComponentSandbox.sameID(current.requestID, requestID) else { return }
        }
        try writeLocked(url: url, directory: directory, scope: scope, requestID: requestID, at: at, version: version, state: "unknown")
    }

    /// Writes an unknown marker for this scope. Prefer `markUnknown` when a
    /// request identity exists so a later confirmation can match.
    func record(scope: JSONValue, at: Double, version: Int) throws {
        try markUnknown(scope: scope, requestID: Self.makeRequestID(), at: at, version: version)
    }

    /// Removes this scope's file only when it still names `requestID` and is
    /// still pending. Unknown markers and another request's file stay.
    @discardableResult
    func clearMatching(scope: JSONValue, requestID: String) throws -> Bool {
        Self.lock.lock(); defer { Self.lock.unlock() }
        guard let url = fileURL(scope: scope), FileManager.default.fileExists(atPath: url.path) else { return false }
        guard let current = try? readLocked(url: url),
              ComponentSandbox.sameID(current.requestID, requestID),
              current.state == "pending" else { return false }
        try FileManager.default.removeItem(at: url)
        return true
    }

    /// Explicit acknowledgement. Removes this scope's file even when the
    /// record is unreadable.
    func clear(scope: JSONValue) throws {
        Self.lock.lock(); defer { Self.lock.unlock() }
        guard let url = fileURL(scope: scope), FileManager.default.fileExists(atPath: url.path) else { return }
        try FileManager.default.removeItem(at: url)
    }

    private struct Record {
        var requestID: String
        var state: String
    }

    private func writeLocked(url: URL, directory: URL, scope: JSONValue, requestID: String, at: Double, version: Int, state: String) throws {
        guard !requestID.isEmpty, requestID.utf8.count <= 128, state == "pending" || state == "unknown" else {
            throw NativeFailure(Self.persistFailureMessage)
        }
        let record: JSONValue = [
            "format": 2, "scope": scope, "at": .number(at), "version": .number(Double(version)),
            "requestId": .string(requestID), "state": .string(state),
        ]
        guard let data = ComponentSandbox.canonicalData(record) else { throw NativeFailure(Self.persistFailureMessage) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try data.write(to: url, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        let handle = try FileHandle(forWritingTo: url)
        defer { try? handle.close() }
        try handle.synchronize()
        guard let stored = try? readLocked(url: url),
              ComponentSandbox.sameID(stored.requestID, requestID),
              stored.state == state else {
            throw NativeFailure(Self.persistFailureMessage)
        }
    }

    private func readLocked(url: URL) throws -> Record {
        let payload = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: url))
        let requestID = payload["requestId"].optionalString ?? ""
        let state: String
        if payload["format"] == 2, payload["state"].optionalString == "pending" || payload["state"].optionalString == "unknown" {
            state = payload["state"].stringValue
        } else {
            state = "unknown"
        }
        return Record(requestID: requestID, state: state)
    }
}

/// Loads pinned or active source, mints a capability only for a visible,
/// foreground, writable host, and gates every worker on its own channel,
/// generation and grant. Preview never touches the capability service.
///
/// - Every session starts as a candidate and must render within the deadline;
///   side effects are refused until then.
/// - Host, component or pin changes retire the worker before anything else.
///   Props or binding changes re-mint and post an `update`; a renewal of the
///   same grant changes nothing the worker sees.
/// - Page hosts receive `{...read.host, databases}` read through the
///   capability for the granted `databaseId`/`databaseIds` (at most 20).
/// - A `write.rows` call is reserved on disk before it is sent, at most once.
///   An unknown outcome stays recorded across stop/restart/reopen until
///   acknowledged. A confirmed pending marker is cleared only for that
///   request identity.
@MainActor final class NativeComponentRuntimeModel: ObservableObject {
    static let readOnlyMessage = "This host is read-only, so the component is paused."
    static let unconfirmedWriteMessage = "A database write is unconfirmed. It was not submitted again. Check the data, then acknowledge it to allow new writes."
    static let blockedWriteMessage = "A previous database write is unconfirmed. Check the data and acknowledge it before writing again."
    static let unknownWriteReply = "The write outcome is unknown. It was not submitted again."
    static let persistWriteMarkerMessage = NativeComponentWriteGuardStore.persistFailureMessage
    static let timedOutReply = "Component request timed out"

    let api: MichiAPI
    let workspaceID: String
    let preview: Bool
    @Published private(set) var host: JSONValue
    @Published private(set) var componentID: String
    @Published private(set) var pinnedVersion: Int?
    @Published private(set) var props: JSONValue
    @Published private(set) var data: JSONValue
    @Published private(set) var bindingKey: JSONValue
    @Published private(set) var readOnly: Bool
    @Published private(set) var name = "Component"
    @Published private(set) var version = 0
    @Published private(set) var code = ""
    @Published private(set) var grantedProps: JSONValue = [:]
    @Published private(set) var pageData: JSONValue?
    @Published private(set) var height: Int
    @Published private(set) var loading = false
    @Published private(set) var stopped = false
    @Published private(set) var error: String?
    @Published private(set) var notice: String?
    @Published private(set) var unconfirmedWrite: String?
    @Published private(set) var session: NativeComponentSandboxSession?
    @Published private(set) var presentedVersion = 0
    @Published private(set) var visible = false
    @Published private(set) var foreground = true
    let capability: NativeComponentCapabilityModel
    /// Fires after a message is queued. The outbox itself is not published, so
    /// draining it never mutates observable state.
    let outboxSignal = PassthroughSubject<Void, Never>()
    private(set) var outbox: [(channel: String, message: JSONValue)] = []
    /// Refreshed by the host view on every evaluation; side effects use the
    /// latest value, and a nil handler refuses the request locally.
    var onNavigatePage: ((String) -> Void)?
    var onAskDraft: ((String) -> Void)?
    var onDatabaseChanged: (() -> Void)?
    private(set) var theme: [String: String]

    private enum SourceState { case unknown, ready, disabled, missing }
    private enum ErrorOrigin { case none, source, pageData, render }
    private struct PendingCall {
        let serial: Int
        let id: Int
        let method: String
        let args: JSONValue
        let host: JSONValue
        let channel: String
        let generation: Int
        let authority: Int
        let version: Int
        let guardScope: JSONValue
        let requestID: String
        let onDatabaseChanged: (() -> Void)?
    }

    private var sourceState: SourceState = .unknown
    private var errorOrigin: ErrorOrigin = .none
    private var generation = 0
    private var sourceGeneration = 0
    private var sourceTask: Task<Void, Never>?
    private var refreshTask: Task<Void, Never>?
    private var renderDeadline: Task<Void, Never>?
    private var previewTask: Task<Void, Never>?
    private var pageDataTask: Task<Void, Never>?
    private var pageDataSerial = 0
    private var pageDataAgain = false
    private var callSerial = 0
    /// Serials of calls not yet answered or expired. A worker may reuse an id
    /// after its reply, so a stale deadline must never touch the newer call.
    private var openCalls: Set<Int> = []
    private var outstandingWrites: Set<Int> = []
    private var hostCallTasks: [Int: Task<Void, Never>] = [:]
    private let timing: NativeComponentRuntimeTiming
    private let writeGuards: NativeComponentWriteGuardStore
    private let now: () -> Date

    init(api: MichiAPI, workspaceID: String, host: JSONValue, componentID: String, pinnedVersion: Int?,
         props: JSONValue, data: JSONValue, bindingKey: JSONValue = .null, readOnly: Bool = false, preview: Bool = false,
         initialHeight: Int? = nil, theme: [String: String] = ComponentSandbox.theme(palette: "monokai"),
         timing: NativeComponentRuntimeTiming = NativeComponentRuntimeTiming(),
         writeGuards: NativeComponentWriteGuardStore = NativeComponentWriteGuardStore(),
         now: @escaping () -> Date = Date.init) {
        self.api = api; self.workspaceID = workspaceID; self.host = host; self.componentID = componentID
        self.pinnedVersion = pinnedVersion; self.props = props; self.data = data; self.bindingKey = bindingKey
        self.readOnly = readOnly; self.preview = preview; self.theme = theme; self.timing = timing
        self.writeGuards = writeGuards; self.now = now
        let minimum = preview ? ComponentSandbox.previewHeightMin : ComponentSandbox.heightMin
        let maximum = preview ? ComponentSandbox.previewHeightMax : ComponentSandbox.heightMax
        self.height = ComponentSandbox.clampHeight(Double(initialHeight ?? minimum), min: minimum, max: maximum)
        capability = NativeComponentCapabilityModel(api: api, workspaceID: workspaceID, timing: timing.capability, now: now)
        capability.onTokenChange = { [weak self] token in self?.capabilityChanged(token) }
        capability.onSignal = { [weak self] signal in self?.capabilitySignaled(signal) }
        if !preview { loadWriteGuard() }
    }

    var hostKind: ComponentSandbox.HostKind? { ComponentSandbox.parseHost(host)?.kind }
    var isRunning: Bool { session?.live == true && !stopped }
    var showsSandbox: Bool { !stopped && session != nil }
    /// Model error, or the capability's mint failure while nothing is running.
    var displayError: String? {
        if let error { return error }
        return session == nil && !loading && !stopped ? capability.error : nil
    }
    private var isPageHost: Bool { hostKind == .pageBlock }
    private var shouldRun: Bool { !stopped && visible && foreground && (preview || !readOnly) }

    // MARK: Lifecycle

    /// Same as the host appearing.
    func start() { appear() }

    func appear() {
        visible = true
        if preview { installPreviewIfNeeded(); return }
        resume(forceSource: false)
    }

    func disappear() {
        visible = false
        previewTask?.cancel(); previewTask = nil
        if preview { retireSession(); return }
        suspend()
    }

    /// Only `.background` pauses; transient `.inactive` (Control Center,
    /// alerts, Face ID) keeps the component running.
    func enterBackground() {
        guard foreground else { return }
        foreground = false
        if preview { retireSession(); return }
        suspend()
    }

    func enterForeground() {
        guard !foreground else { return }
        foreground = true
        if preview { installPreviewIfNeeded(); return }
        resume(forceSource: true)
    }

    func stop() {
        stopped = true
        suspend()
        notice = "This component was stopped. Use Restart to run it again."
    }

    /// Runs again from fresh source and a fresh grant. An unconfirmed write
    /// stays recorded until acknowledged.
    func restart() {
        stopped = false
        error = nil
        errorOrigin = .none
        notice = nil
        presentedVersion = 0
        if preview {
            retireSession()
            installPreviewIfNeeded()
            return
        }
        suspend()
        resume(forceSource: true)
    }

    /// Cancels timers, waits for in-flight source/page/host-call work, then
    /// drains capability mint/revoke. Production `deinit` still revokes any
    /// leftover token. Tests must await this before invalidating the session.
    func shutdown() async {
        let source = sourceTask
        let page = pageDataTask
        let calls = Array(hostCallTasks.values)
        suspend()
        await source?.value
        await page?.value
        for task in calls { await task.value }
        await capability.shutdown()
    }

    func applyHost(host: JSONValue, componentID: String, pinnedVersion: Int?, props: JSONValue, data: JSONValue,
                   bindingKey: JSONValue = .null, readOnly: Bool) {
        let scopeChanged = !ComponentSandbox.sameJSON(host, self.host) || !ComponentSandbox.sameID(componentID, self.componentID)
        let pinChanged = pinnedVersion != self.pinnedVersion
        let propsChanged = !ComponentSandbox.sameJSON(props, self.props)
        let bindingChanged = !ComponentSandbox.sameJSON(bindingKey, self.bindingKey)
        let dataChanged = !ComponentSandbox.sameJSON(data, self.data)
        let readOnlyChanged = readOnly != self.readOnly
        guard scopeChanged || pinChanged || propsChanged || bindingChanged || dataChanged || readOnlyChanged else { return }
        self.host = host; self.componentID = componentID; self.pinnedVersion = pinnedVersion
        self.props = props; self.data = data; self.bindingKey = bindingKey; self.readOnly = readOnly
        if preview {
            if propsChanged, var current = session, !current.isRetained {
                current.props = props
                session = current
                if current.ready { post(current.outboundUpdate(), channel: current.channel) }
            }
            return
        }
        if scopeChanged || pinChanged {
            // The old worker must not continue under the new host's grant.
            suspend()
            session = nil
            code = ""; version = 0; name = "Component"; grantedProps = [:]; pageData = nil
            sourceState = .unknown
            presentedVersion = 0
            if errorOrigin != .none { error = nil; errorOrigin = .none }
            if scopeChanged { loadWriteGuard() }
            resume(forceSource: true)
            return
        }
        if readOnlyChanged {
            if readOnly {
                suspend()
                error = Self.readOnlyMessage
                return
            }
            if error == Self.readOnlyMessage { error = nil }
            resume(forceSource: false)
            return
        }
        guard shouldRun, sourceState == .ready else { return }
        if propsChanged || bindingChanged { activate() }
        if dataChanged, hostKind == .databaseView, var current = session, !current.isRetained,
           !ComponentSandbox.sameJSON(current.data, data) {
            current.data = data
            session = current
            if current.ready { post(current.outboundUpdate(), channel: current.channel) }
        }
    }

    /// Not published: called from the host view's body on every evaluation.
    func updateHandlers(navigate: ((String) -> Void)?, draft: ((String) -> Void)?, databaseChanged: (() -> Void)?) {
        onNavigatePage = navigate
        onAskDraft = draft
        onDatabaseChanged = databaseChanged
    }

    /// A changed saved height is applied without overwriting later worker resize calls.
    func applyConfiguredHeight(_ value: Int?) {
        let minimum = preview ? ComponentSandbox.previewHeightMin : ComponentSandbox.heightMin
        let maximum = preview ? ComponentSandbox.previewHeightMax : ComponentSandbox.heightMax
        height = ComponentSandbox.clampHeight(Double(value ?? minimum), min: minimum, max: maximum)
    }

    func applyTheme(_ next: [String: String]) {
        theme = next
        guard var current = session, !current.isRetained, current.theme != next else { return }
        current.theme = next
        session = current
        if current.ready { post(current.outboundTheme(), channel: current.channel) }
    }

    /// Root signal for page events; refreshes page data now instead of waiting
    /// for the next tick.
    func pageChanged() {
        guard isPageHost, !preview else { return }
        refreshPageData()
    }

    func acknowledgeUnconfirmedWrite() {
        guard unconfirmedWrite != nil else { return }
        do {
            try writeGuards.clear(scope: guardScope)
            unconfirmedWrite = nil
        } catch {
            notice = "The unconfirmed write marker could not be cleared: \(error.localizedDescription)"
        }
    }

    // MARK: Preview

    func installPreviewSource(name: String, code: String, version: Int) {
        previewTask?.cancel(); previewTask = nil
        let changed = !ComponentSandbox.sameID(code, self.code) || version != self.version
        self.name = name
        self.code = code
        self.version = version
        guard preview, shouldRun else { return }
        if changed || session.map(\.isRetained) ?? true { installPreviewSession() }
    }

    /// Debounced draft edits. Never reads the server source.
    func updatePreviewSource(name: String, code: String, version: Int) {
        guard preview else { return }
        previewTask?.cancel()
        let wait = timing.previewDebounce
        previewTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(max(0, wait) * 1_000_000_000))
            guard !Task.isCancelled, let self else { return }
            self.installPreviewSource(name: name, code: code, version: version)
        }
    }

    private func installPreviewIfNeeded() {
        guard preview, shouldRun, !code.isEmpty else { return }
        if let current = session, !current.isRetained { return }
        installPreviewSession()
    }

    private func installPreviewSession() {
        retireSession()
        guard !code.isEmpty else { return }
        if errorOrigin == .render { error = nil; errorOrigin = .none }
        generation += 1
        session = NativeComponentSandboxSession.start(
            generation: generation, preview: true, hasCapability: false, code: code, props: props,
            data: ComponentSandbox.previewData, theme: theme, height: height,
            minHeight: ComponentSandbox.previewHeightMin, maxHeight: ComponentSandbox.previewHeightMax
        )
        startRenderDeadline(generation: generation)
    }

    // MARK: Sandbox transport

    /// Channel the attached outer document should run. A session already bound
    /// to a document this view did not load (a recreated web view) is
    /// replaced, so a worker's state never continues in another document.
    func sandboxChannel(loaded: String?) -> String? {
        guard let current = session, !current.isRetained else { return loaded }
        if let loaded, ComponentSandbox.sameID(loaded, current.channel) { return loaded }
        if current.document != nil {
            if preview { installPreviewSession() }
            else if shouldRun, capability.token != nil { installSession(data: current.data) }
            else { retireSession() }
            return session.flatMap { $0.isRetained ? nil : $0.channel }
        }
        return current.channel
    }

    /// Messages queued for `channel`; everything else is stale and dropped.
    func drainOutbox(channel: String?) -> [JSONValue] {
        let pending = outbox
        outbox.removeAll()
        guard let channel else { return [] }
        return pending.filter { ComponentSandbox.sameID($0.channel, channel) }.map { $0.message }
    }

    func sandboxFailed(channel: String, message: String) {
        guard let current = session, ComponentSandbox.sameID(current.channel, channel), !current.isRetained else { return }
        fail(message)
    }

    func handleSandboxMessage(_ value: JSONValue, channel: String, document: String) {
        guard !stopped, shouldRun, var current = session, ComponentSandbox.sameID(current.channel, channel) else { return }
        let event = current.acceptIncoming(value, document: document, now: now())
        session = current
        switch event {
        case .ignore:
            break
        case .wrapperInit:
            post(current.outboundInit(), channel: current.channel)
        case .load:
            post(current.outboundLoad(), channel: current.channel)
        case .stop(let message):
            fail(message)
        case .fail(let message):
            if current.isRetained {
                renderDeadline?.cancel()
                post(current.outboundFreeze(), channel: current.channel)
                fail("The component could not start: \(message)")
            } else {
                error = message
            }
        case .rendered:
            renderDeadline?.cancel()
            presentedVersion = version
            if errorOrigin == .render { error = nil; errorOrigin = .none }
        case .timeout:
            break
        case .reply(let id, let ok, let value, let failure):
            post(ComponentSandbox.resultMessage(channel: current.channel, id: id, ok: ok, value: value, error: failure), channel: current.channel)
        case .hostCall(let id, let method, let args):
            dispatchHostCall(id: id, method: method, args: args, session: current)
        case .resize(let next, let id):
            height = next
            post(ComponentSandbox.resultMessage(channel: current.channel, id: id, ok: true, value: ["height": .number(Double(next))]), channel: current.channel)
        }
    }

    static func resolvedVersion(component: JSONValue, pinnedVersion: Int?) -> Int? {
        if let pinnedVersion { return pinnedVersion >= 1 ? pinnedVersion : nil }
        let active = ComponentSandbox.safeInteger(component["activeVersion"])
        return active.map { $0 >= 1 ? $0 : nil } ?? nil
    }

    static func missingSource(_ error: Error) -> Bool {
        guard let failure = error as? MichiAPIError, let status = failure.statusCode else { return false }
        return status == 401 || status == 403 || (status == 404 && (failure.code == "not_found" || failure.code == nil))
    }

    /// `props.databaseId` then `props.databaseIds`: exact-byte unique, at most 20.
    static func pageDatabaseIDs(_ props: JSONValue) -> [String] {
        var ids: [String] = []
        var seen = Set<Data>()
        func add(_ value: JSONValue) {
            guard let id = value.optionalString, ComponentSandbox.isID(value), seen.insert(Data(id.utf8)).inserted else { return }
            ids.append(id)
        }
        add(props["databaseId"])
        props["databaseIds"].arrayValue.forEach(add)
        return Array(ids.prefix(20))
    }

    // MARK: Running

    private var guardScope: JSONValue {
        NativeComponentWriteGuardStore.scope(api: api, workspaceID: workspaceID, componentID: componentID, host: host)
    }

    private func loadWriteGuard() {
        unconfirmedWrite = writeGuards.isBlocked(scope: guardScope) ? Self.unconfirmedWriteMessage : nil
    }

    private func resume(forceSource: Bool) {
        guard shouldRun, !preview else {
            if readOnly, !stopped, !preview { error = Self.readOnlyMessage }
            return
        }
        startRefreshLoop()
        if forceSource || sourceState != .ready || code.isEmpty { loadSource() } else { activate() }
    }

    /// Drops everything that can act: worker, grant, reads and timers.
    private func suspend() {
        sourceGeneration += 1
        sourceTask?.cancel(); sourceTask = nil
        refreshTask?.cancel(); refreshTask = nil
        cancelPageData()
        retireSession()
        capability.stop()
        loading = false
    }

    private func fail(_ message: String) {
        if preview {
            retireSession()
            error = message
            errorOrigin = .render
            return
        }
        stopped = true
        suspend()
        error = message
        errorOrigin = .render
        notice = nil
    }

    private func retireSession() {
        renderDeadline?.cancel(); renderDeadline = nil
        guard var current = session, !current.isRetained else { return }
        current.retain()
        session = current
        post(current.outboundFreeze(), channel: current.channel)
    }

    private func activate() {
        guard shouldRun, !preview, sourceState == .ready, !code.isEmpty, version >= 1 else { return }
        capability.configure(componentID: componentID, version: version, host: host, props: props, bindingKey: bindingKey,
                             enabled: true, preview: false)
        if let token = capability.token { tokenReady(token) }
    }

    private func capabilityChanged(_ token: NativeComponentCapabilityToken?) {
        guard let token else {
            if var current = session, !current.isRetained, current.hasCapability {
                current.hasCapability = false
                session = current
            }
            return
        }
        tokenReady(token)
    }

    private func tokenReady(_ token: NativeComponentCapabilityToken) {
        guard shouldRun, !preview, sourceState == .ready, token.version == version,
              ComponentSandbox.sameID(token.componentID, componentID), ComponentSandbox.sameJSON(token.host, host) else { return }
        grantedProps = token.props
        if var current = session, !current.isRetained {
            let propsChanged = !ComponentSandbox.sameJSON(current.props, token.props)
            current.hasCapability = true
            current.props = token.props
            session = current
            if propsChanged, current.ready { post(current.outboundUpdate(), channel: current.channel) }
            if isPageHost { refreshPageData() }
            return
        }
        if isPageHost { refreshPageData() } else { installSession(data: data) }
    }

    private func capabilitySignaled(_ signal: NativeComponentCapabilitySignal) {
        guard !preview, shouldRun else { return }
        switch signal {
        case .sourceMissing(let message):
            // No immediate re-read: the next refresh tick (10 s) re-checks the
            // source and mints at most once, so a gone host never loops.
            retireSession()
            cancelPageData()
            capability.pause(reason: nil)
            error = message.isEmpty ? NativeComponentCapabilityError.disabled.errorDescription : message
            errorOrigin = .source
        case .sourceChanged:
            loadSource()
        }
    }

    private func installSession(data sessionData: JSONValue) {
        guard let token = capability.token else { return }
        retireSession()
        generation += 1
        session = NativeComponentSandboxSession.start(
            generation: generation, preview: false, hasCapability: true, code: code, props: token.props,
            data: sessionData, theme: theme, height: height
        )
        startRenderDeadline(generation: generation)
    }

    private func startRenderDeadline(generation captured: Int) {
        renderDeadline?.cancel()
        let wait = timing.firstRender
        renderDeadline = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(max(0, wait) * 1_000_000_000))
            guard !Task.isCancelled, let self, var current = self.session, current.generation == captured else { return }
            guard case .timeout = current.firstRenderTimedOut() else { return }
            self.session = current
            self.post(current.outboundFreeze(), channel: current.channel)
            self.fail("The component did not render within \(Int(wait.rounded())) seconds. Use Restart to try again.")
        }
    }

    // MARK: Source

    private func startRefreshLoop() {
        guard refreshTask == nil, !preview else { return }
        let interval = timing.refresh
        refreshTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: UInt64(max(0.01, interval) * 1_000_000_000))
                guard !Task.isCancelled, let self else { return }
                guard self.shouldRun, self.sourceState != .missing else {
                    self.refreshTask = nil
                    return
                }
                self.loadSource()
                if self.isPageHost, self.sourceState == .ready { self.refreshPageData() }
            }
        }
    }

    private func loadSource() {
        guard !preview, shouldRun else { return }
        guard sourceTask == nil else { return }
        sourceGeneration += 1
        let captured = sourceGeneration
        if code.isEmpty { loading = true }
        sourceTask = Task { [weak self] in
            await self?.readSource(generation: captured)
        }
    }

    private func readSource(generation captured: Int) async {
        let componentID = self.componentID, pinnedVersion = self.pinnedVersion, workspaceID = self.workspaceID
        defer { if captured == sourceGeneration { sourceTask = nil } }
        do {
            let library = try await api.request("/workspaces/\(MichiAPI.pathSegment(workspaceID))/components")
            try Task.checkCancellation()
            guard captured == sourceGeneration else { return }
            guard case .array(let items) = library["items"] else {
                throw NativeComponentCapabilityError.unavailable("The component library could not be read.")
            }
            let matches = items.filter { ComponentSandbox.sameID($0["id"].stringValue, componentID) }
            guard matches.count <= 1 else { throw NativeComponentCapabilityError.unavailable("The component library has duplicate identities.") }
            guard let match = matches.first else { sourceMissing(NativeComponentCapabilityError.disabled.errorDescription!); return }
            let component = try NativeComponentContract.component(match, workspaceID: workspaceID, owner: nil, expectedID: componentID)
            guard component["enabled"] == true else { sourceDisabled(); return }
            guard let target = NativeComponentRuntimeModel.resolvedVersion(component: component, pinnedVersion: pinnedVersion),
                  target <= component["versions"].intValue else {
                throw NativeComponentCapabilityError.unavailable("Choose an existing immutable version.")
            }
            if sourceState == .ready, target == version, !code.isEmpty {
                // Versions are immutable: the running worker keeps its state.
                name = component["name"].stringValue
                loading = false
                clearError(.source)
                activate()
                return
            }
            let path = "/components/\(MichiAPI.pathSegment(componentID))" + FeatureAPI.query([("workspaceId", workspaceID), ("version", String(target))])
            let loaded = try NativeComponentContract.version(try await api.request(path), componentID: componentID, number: target)
            try Task.checkCancellation()
            guard captured == sourceGeneration else { return }
            sourceInstalled(name: component["name"].stringValue, version: target, code: loaded["code"].stringValue)
        } catch is CancellationError {
            return
        } catch {
            guard captured == sourceGeneration else { return }
            loading = false
            if NativeComponentRuntimeModel.missingSource(error) {
                sourceMissing(NativeComponentCapabilityError.disabled.errorDescription!)
            } else if code.isEmpty || sourceState != .ready {
                self.error = error.localizedDescription
                errorOrigin = .source
            }
        }
    }

    private func sourceInstalled(name: String, version target: Int, code next: String) {
        let changed = target != version || !ComponentSandbox.sameID(next, code)
        self.name = name
        loading = false
        sourceState = .ready
        clearError(.source)
        if changed {
            retireSession()
            cancelPageData()
            pageData = nil
            version = target
            code = next
        }
        activate()
    }

    private func sourceDisabled() {
        sourceState = .disabled
        loading = false
        retireSession()
        cancelPageData()
        capability.pause(reason: nil)
        error = NativeComponentCapabilityError.disabled.errorDescription
        errorOrigin = .source
    }

    /// Deleted, not authorized, or gone: stop polling until restart or appear.
    private func sourceMissing(_ message: String) {
        sourceState = .missing
        loading = false
        retireSession()
        cancelPageData()
        capability.pause(reason: nil)
        error = message
        errorOrigin = .source
    }

    private func clearError(_ origin: ErrorOrigin) {
        if errorOrigin == origin { error = nil; errorOrigin = .none }
    }

    // MARK: Page data

    private func cancelPageData() {
        pageDataSerial += 1
        pageDataTask?.cancel(); pageDataTask = nil
        pageDataAgain = false
    }

    private func refreshPageData() {
        guard isPageHost, !preview, shouldRun, sourceState == .ready, let token = capability.token else { return }
        if pageDataTask != nil { pageDataAgain = true; return }
        pageDataSerial += 1
        let serial = pageDataSerial
        let authority = capability.authority, version = self.version, host = self.host
        let ids = Self.pageDatabaseIDs(token.props)
        pageDataTask = Task { [weak self] in
            guard let capability = self?.capability else { return }
            let result = await Self.readPageData(capability: capability, ids: ids, host: host)
            guard let self, serial == self.pageDataSerial else { return }
            self.pageDataTask = nil
            self.finishPageData(result, authority: authority, version: version, host: host)
            if self.pageDataAgain {
                self.pageDataAgain = false
                self.refreshPageData()
            }
        }
    }

    private static func readPageData(capability: NativeComponentCapabilityModel, ids: [String], host: JSONValue) async -> Result<JSONValue, Error> {
        do {
            let hostData = try await capability.call(method: "read.host", args: [], host: host)
            var databases: [String: JSONValue] = [:]
            for id in ids where databases[id] == nil {
                try Task.checkCancellation()
                databases[id] = try await capability.call(method: "read.database", args: [.string(id)], host: host)
            }
            var fields: [String: JSONValue]
            if case .object(let object) = hostData { fields = object } else { fields = ["host": hostData] }
            fields["databases"] = .object(databases)
            return .success(.object(fields))
        } catch {
            return .failure(error)
        }
    }

    private func finishPageData(_ result: Result<JSONValue, Error>, authority: Int, version: Int, host: JSONValue) {
        guard shouldRun, sourceState == .ready, capability.authority == authority, capability.token != nil,
              version == self.version, ComponentSandbox.sameJSON(host, self.host) else { return }
        switch result {
        case .failure(let failure):
            if session.map(\.isRetained) ?? true {
                error = "The component's page data could not be read: \(failure.localizedDescription)"
                errorOrigin = .pageData
            }
        case .success(let value):
            pageData = value
            clearError(.pageData)
            if var current = session, !current.isRetained {
                guard !ComponentSandbox.sameJSON(current.data, value) else { return }
                current.data = value
                session = current
                if current.ready { post(current.outboundUpdate(), channel: current.channel) }
            } else {
                installSession(data: value)
            }
        }
    }

    // MARK: Host calls

    private func dispatchHostCall(id: Int, method: String, args: JSONValue, session current: NativeComponentSandboxSession) {
        func refuse(_ message: String) {
            guard finishCall(id: id, channel: current.channel, generation: current.generation) else { return }
            post(ComponentSandbox.resultMessage(channel: current.channel, id: id, ok: false, error: message), channel: current.channel)
        }
        if method == "write.rows" {
            if hostKind != .databaseView { return refuse(NativeComponentCapabilityError.pageWrite.errorDescription!) }
            if unconfirmedWrite != nil || writeGuards.isBlocked(scope: guardScope) {
                if unconfirmedWrite == nil { unconfirmedWrite = Self.unconfirmedWriteMessage }
                return refuse(Self.blockedWriteMessage)
            }
        }
        if method == "navigate.page", onNavigatePage == nil { return refuse("Navigation is unavailable here") }
        if method == "ask.draft", onAskDraft == nil { return refuse("Draft requests are unavailable here") }
        var requestID = ""
        if method == "write.rows" {
            requestID = NativeComponentWriteGuardStore.makeRequestID()
            do {
                try writeGuards.reserve(scope: guardScope, requestID: requestID, at: now().timeIntervalSince1970 * 1000, version: version)
            } catch {
                let message = error.localizedDescription
                if message == Self.blockedWriteMessage || writeGuards.isBlocked(scope: guardScope) {
                    unconfirmedWrite = Self.unconfirmedWriteMessage
                }
                return refuse(message.isEmpty ? Self.persistWriteMarkerMessage : message)
            }
        }
        callSerial += 1
        let call = PendingCall(
            serial: callSerial, id: id, method: method, args: args, host: host, channel: current.channel,
            generation: current.generation, authority: capability.authority, version: version, guardScope: guardScope,
            requestID: requestID, onDatabaseChanged: method == "write.rows" ? onDatabaseChanged : nil
        )
        openCalls.insert(call.serial)
        if method == "write.rows" { outstandingWrites.insert(call.serial) }
        let wait = timing.call
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(max(0, wait) * 1_000_000_000))
            self?.expireCall(call)
        }
        let capability = capability
        let guards = writeGuards
        let task = Task { [weak self] in
            let outcome: Result<JSONValue, Error>
            do { outcome = .success(try await capability.call(method: call.method, args: call.args, host: call.host)) }
            catch { outcome = .failure(error) }
            if let self {
                self.finishHostCall(call, outcome)
            } else {
                Self.settleWriteWithoutHost(call, outcome, guards: guards)
            }
        }
        hostCallTasks[call.serial] = task
    }

    private func finishCall(id: Int, channel: String, generation: Int) -> Bool {
        guard var current = session, current.generation == generation, ComponentSandbox.sameID(current.channel, channel) else { return false }
        let deliverable = current.finishCall(id: id)
        session = current
        return deliverable
    }

    /// Frees the slot and answers the worker. A write still outstanding is
    /// unconfirmed from here on; it is never resent.
    private func expireCall(_ call: PendingCall) {
        guard openCalls.remove(call.serial) != nil else { return }
        if call.method == "write.rows", outstandingWrites.contains(call.serial) { markUnconfirmedWrite(call) }
        guard finishCall(id: call.id, channel: call.channel, generation: call.generation) else { return }
        post(ComponentSandbox.resultMessage(channel: call.channel, id: call.id, ok: false, error: Self.timedOutReply), channel: call.channel)
    }

    private func finishHostCall(_ call: PendingCall, _ outcome: Result<JSONValue, Error>) {
        hostCallTasks[call.serial] = nil
        var ok = false
        var value: JSONValue?
        var failure: String?
        switch outcome {
        case .success(let result):
            if call.method == "write.rows" {
                let stillOutstanding = outstandingWrites.remove(call.serial) != nil
                if NativeComponentCapabilityModel.confirmedWrite(result) {
                    ok = true
                    value = result
                    // Confirmed changes refresh the original host even if the
                    // worker that asked is gone.
                    if NativeComponentCapabilityModel.writeChanged(result) { call.onDatabaseChanged?() }
                    if stillOutstanding { clearMatchingWrite(call) }
                } else {
                    markUnconfirmedWrite(call)
                    failure = Self.unknownWriteReply
                }
            } else {
                ok = true
                value = result
            }
        case .failure(let error):
            if call.method == "write.rows" {
                let stillOutstanding = outstandingWrites.remove(call.serial) != nil
                if NativeComponentCapabilityModel.writeOutcomeUnknown(error) {
                    markUnconfirmedWrite(call)
                    failure = Self.unknownWriteReply
                } else {
                    if stillOutstanding { clearMatchingWrite(call) }
                    failure = error.localizedDescription
                }
            } else {
                failure = error.localizedDescription
            }
        }
        guard openCalls.remove(call.serial) != nil,
              finishCall(id: call.id, channel: call.channel, generation: call.generation),
              shouldRun, capability.authority == call.authority, let current = session else { return }
        var navigate: ((String) -> Void)?
        var draft: ((String) -> Void)?
        if ok, call.method == "navigate.page" {
            navigate = onNavigatePage
            if navigate == nil || current.mode != .active { ok = false; value = nil; failure = "Navigation is unavailable here" }
        }
        if ok, call.method == "ask.draft" {
            draft = onAskDraft
            if draft == nil || current.mode != .active { ok = false; value = nil; failure = "Draft requests are unavailable here" }
        }
        post(ComponentSandbox.resultMessage(channel: call.channel, id: call.id, ok: ok, value: value, error: failure), channel: call.channel)
        guard ok, let value else { return }
        if let navigate, let pageID = value["pageId"].optionalString ?? call.args.arrayValue.first?.optionalString, !pageID.isEmpty {
            navigate(pageID)
        }
        if let draft, let text = call.args.arrayValue.first?.optionalString { draft(text) }
    }

    /// Durable write settlement when the host was deallocated. The worker is
    /// gone; the marker and captured refresh must still run.
    private static func settleWriteWithoutHost(_ call: PendingCall, _ outcome: Result<JSONValue, Error>,
                                              guards: NativeComponentWriteGuardStore) {
        guard call.method == "write.rows", !call.requestID.isEmpty else { return }
        let at = Date().timeIntervalSince1970 * 1000
        switch outcome {
        case .success(let result):
            if NativeComponentCapabilityModel.confirmedWrite(result) {
                if NativeComponentCapabilityModel.writeChanged(result) { call.onDatabaseChanged?() }
                _ = try? guards.clearMatching(scope: call.guardScope, requestID: call.requestID)
            } else {
                try? guards.markUnknown(scope: call.guardScope, requestID: call.requestID, at: at, version: call.version)
            }
        case .failure(let error):
            if NativeComponentCapabilityModel.writeOutcomeUnknown(error) {
                try? guards.markUnknown(scope: call.guardScope, requestID: call.requestID, at: at, version: call.version)
            } else {
                _ = try? guards.clearMatching(scope: call.guardScope, requestID: call.requestID)
            }
        }
    }

    private func markUnconfirmedWrite(_ call: PendingCall) {
        outstandingWrites.remove(call.serial)
        var saved = true
        do {
            try writeGuards.markUnknown(scope: call.guardScope, requestID: call.requestID,
                                        at: now().timeIntervalSince1970 * 1000, version: call.version)
        } catch { saved = false }
        guard ComponentSandbox.sameJSON(call.guardScope, guardScope) else { return }
        unconfirmedWrite = Self.unconfirmedWriteMessage + (saved ? "" : " It could not be saved on this device.")
    }

    private func clearMatchingWrite(_ call: PendingCall) {
        do { _ = try writeGuards.clearMatching(scope: call.guardScope, requestID: call.requestID) }
        catch { return }
        guard ComponentSandbox.sameJSON(call.guardScope, guardScope), !writeGuards.isBlocked(scope: call.guardScope) else { return }
        unconfirmedWrite = nil
    }

    private func post(_ message: JSONValue, channel: String) {
        outbox.append((channel: channel, message: message))
        if outbox.count > 512 { outbox.removeFirst(outbox.count - 512) }
        outboxSignal.send()
    }
}
