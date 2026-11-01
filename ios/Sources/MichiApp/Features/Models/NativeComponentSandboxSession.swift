import Foundation
import MichiCore

enum NativeComponentSandboxMode: String, Equatable {
    case active, candidate, retained
}

enum NativeComponentSandboxEvent: Equatable {
    case ignore
    case wrapperInit
    case load
    case stop(String)
    case fail(String)
    case rendered
    case timeout
    case reply(id: Int, ok: Bool, value: JSONValue?, error: String?)
    case hostCall(id: Int, method: String, args: JSONValue)
    case resize(Int, id: Int)
}

/// Channel, document, rate, and candidate/retain rules for one worker. Every
/// session starts as a candidate: side effects are refused until its first
/// render. A session binds to the first outer document that loads it, so a
/// late post from another document (or a reloaded one) never reaches it.
struct NativeComponentSandboxSession: Equatable {
    static let sideEffects: Set<String> = ["write.rows", "navigate.page", "ask.draft"]

    let channel: String
    let generation: Int
    let preview: Bool
    let minHeight: Int
    let maxHeight: Int
    var hasCapability: Bool
    var code = ""
    var props: JSONValue = [:]
    var data: JSONValue = [:]
    var theme: [String: String] = [:]
    private(set) var mode: NativeComponentSandboxMode = .candidate
    private(set) var document: String?
    private(set) var live = false
    private(set) var ready = false
    private(set) var rendered = false
    private(set) var inFlight: Set<Int> = []
    private(set) var callTimes: [Double] = []
    private(set) var height: Int

    private init(channel: String, generation: Int, preview: Bool, minHeight: Int, maxHeight: Int, hasCapability: Bool, height: Int) {
        self.channel = channel; self.generation = generation; self.preview = preview
        self.minHeight = minHeight; self.maxHeight = maxHeight; self.hasCapability = hasCapability; self.height = height
    }

    static func start(generation: Int, preview: Bool, hasCapability: Bool,
                      code: String, props: JSONValue, data: JSONValue, theme: [String: String],
                      height: Int?, minHeight: Int = ComponentSandbox.heightMin, maxHeight: Int = ComponentSandbox.heightMax,
                      channel: String = ComponentSandbox.makeChannel()) -> NativeComponentSandboxSession {
        var session = NativeComponentSandboxSession(
            channel: channel, generation: generation, preview: preview, minHeight: minHeight, maxHeight: maxHeight,
            hasCapability: preview ? false : hasCapability,
            height: ComponentSandbox.clampHeight(Double(height ?? minHeight), min: minHeight, max: maxHeight)
        )
        session.code = code
        session.props = props
        session.data = preview ? ComponentSandbox.previewData : data
        session.theme = theme
        return session
    }

    var pending: Int { inFlight.count }
    var isRetained: Bool { mode == .retained }
    var canSideEffect: Bool { mode == .active && !preview && hasCapability && live && ready }

    /// Ends the session for good: no more messages, calls, or replies.
    mutating func retain() {
        mode = .retained
        live = false
        ready = false
        hasCapability = false
        inFlight.removeAll()
    }

    mutating func acceptIncoming(_ value: JSONValue, document nonce: String, now: Date = Date()) -> NativeComponentSandboxEvent {
        guard mode != .retained, !nonce.isEmpty else { return .ignore }
        if ComponentSandbox.parseWrapperLoad(value) {
            guard let bound = document else {
                document = nonce
                return .wrapperInit
            }
            guard ComponentSandbox.sameID(bound, nonce) else { return .ignore }
            retain()
            return .stop("The component sandbox document changed. It has been stopped for safety.")
        }
        guard let bound = document, ComponentSandbox.sameID(bound, nonce) else { return .ignore }
        if !ready {
            guard let readyChannel = ComponentSandbox.parseWrapperReady(value), ComponentSandbox.sameID(readyChannel, channel) else { return .ignore }
            ready = true
            live = true
            return .load
        }
        guard live, let message = ComponentSandbox.parseMessage(value), ComponentSandbox.sameID(message.channel, channel) else { return .ignore }
        switch message.type {
        case .rendered:
            guard !rendered else { return .ignore }
            rendered = true
            if mode == .candidate { mode = .active }
            return .rendered
        case .error:
            let reason = String((message.message ?? "Component failed").prefix(1000))
            if mode == .candidate { retain() }
            return .fail(reason)
        case .call:
            return acceptCall(message, now: now)
        default:
            return .ignore
        }
    }

    mutating func acceptCall(_ message: ComponentSandbox.Message, now: Date) -> NativeComponentSandboxEvent {
        guard let id = message.id, let method = message.method, let args = message.args else { return .ignore }
        guard !inFlight.contains(id) else {
            return .reply(id: id, ok: false, value: nil, error: "A component request with this id is still pending")
        }
        let stamp = now.timeIntervalSince1970 * 1000
        callTimes = callTimes.filter { stamp - $0 < 1_000 }
        if callTimes.count >= ComponentSandbox.hostCallsPerSecond {
            return .reply(id: id, ok: false, value: nil, error: "Too many component requests. Try again shortly.")
        }
        callTimes.append(stamp)
        if method == "resize" {
            // Clamped in Double space: `Int(_:)` on an unbounded number traps.
            guard args.arrayValue.count == 1, case .number(let requested) = args.arrayValue[0], requested.isFinite else {
                return .reply(id: id, ok: false, value: nil, error: "Height must be a number")
            }
            height = ComponentSandbox.clampHeight(requested, min: minHeight, max: maxHeight)
            return .resize(height, id: id)
        }
        if Self.sideEffects.contains(method) && mode != .active {
            return .reply(id: id, ok: false, value: nil, error: "This component update is not active")
        }
        if preview || !hasCapability {
            return .reply(id: id, ok: false, value: nil, error: "This capability is unavailable")
        }
        if inFlight.count >= ComponentSandbox.maxInFlightCalls {
            return .reply(id: id, ok: false, value: nil, error: "Too many component requests are still pending")
        }
        inFlight.insert(id)
        return .hostCall(id: id, method: method, args: args)
    }

    /// Releases a call's slot. True only when this id was still waiting and the
    /// worker may receive its reply; a timed-out or retired call returns false.
    mutating func finishCall(id: Int) -> Bool {
        guard inFlight.remove(id) != nil else { return false }
        return live && mode != .retained
    }

    mutating func firstRenderTimedOut() -> NativeComponentSandboxEvent {
        guard mode != .retained, !rendered else { return .ignore }
        retain()
        return .timeout
    }

    func outboundLoad() -> JSONValue {
        ComponentSandbox.loadMessage(channel: channel, code: code, props: props, data: data, theme: theme.isEmpty ? nil : theme)
    }

    func outboundUpdate() -> JSONValue {
        ComponentSandbox.updateMessage(channel: channel, props: props, data: data)
    }

    func outboundTheme() -> JSONValue {
        ComponentSandbox.themeMessage(channel: channel, theme: theme)
    }

    func outboundFreeze() -> JSONValue {
        ComponentSandbox.freezeMessage(channel: channel)
    }

    func outboundInit() -> JSONValue {
        ComponentSandbox.wrapperInit(channel: channel)
    }
}
