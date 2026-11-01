import Foundation

/// Byte-compatible custom-component sandbox protocol. User source is never
/// concatenated into this document; it is only posted into the worker.
public enum ComponentSandbox {
    public static let timeoutMilliseconds = 10_000
    public static let channelMinimum = 24
    public static let channelMaximum = 128
    public static let methods = ["read.host", "read.database", "write.rows", "resize", "navigate.page", "ask.draft"]
    public static let themeVariables = [
        "--term-bg", "--term-surface", "--term-alt", "--term-alt2", "--term-line", "--term-line-s",
        "--term-fg", "--term-mid", "--term-muted", "--term-faint",
        "--term-accent", "--term-accent-f", "--term-select", "--term-select-f", "--term-digest", "--term-digest-f",
        "--term-mauve", "--term-mauve-f", "--term-danger", "--term-danger-text", "--ui-font", "--font-mono",
    ]
    public static let heightMin = 80
    public static let heightMax = 1_600
    public static let draftCharacters = 8_000
    public static let codeBytes = 200_000
    public static let propsBytes = 64_000
    public static let schemaProperties = 64
    public static let hostCallsPerSecond = 20
    public static let maxInFlightCalls = 8
    public static let hostCallTimeoutMilliseconds = 10_000
    public static let capabilityMinimumLength = 64
    public static let iframeSandbox = "allow-scripts"
    public static let messageHandlerName = "michiComponent"
    public static let previewData: JSONValue = ["sample": true, "value": 12, "label": "Example"]
    public static let previewHeightMin = 120
    public static let previewHeightMax = 520
    /// Bridge budgets applied while converting a WebKit message, before any
    /// other check. The native envelope adds one level above the message.
    public static let inboundMaxDepth = 22
    public static let inboundMaxNodes = 20_000
    public static let inboundMaxStringUnits = 64_000
    public static let inboundMaxTotalStringUnits = 256_000
    /// The srcdoc runner inherits this policy in addition to its own, and its
    /// Blob Worker inherits both, so every source the runner needs is listed.
    /// Only native-owned script runs in the outer realm; nothing may connect.
    public static let outerContentSecurityPolicy = [
        "default-src 'none'", "script-src 'unsafe-inline' 'unsafe-eval'", "worker-src blob:",
        "child-src blob: about:", "frame-src about:", "style-src 'unsafe-inline'",
        "img-src data: blob:", "font-src data:", "connect-src 'none'", "media-src 'none'",
        "object-src 'none'", "base-uri 'none'", "form-action 'none'",
    ].joined(separator: "; ")

    public enum HostKind: String, Equatable, Sendable {
        case pageBlock = "page_block"
        case databaseView = "database_view"
    }

    public struct Host: Equatable, Sendable {
        public var kind: HostKind
        public var pageID: String?
        public var blockID: String?
        public var databaseID: String?
        public var viewID: String?

        public init(kind: HostKind, pageID: String? = nil, blockID: String? = nil, databaseID: String? = nil, viewID: String? = nil) {
            self.kind = kind; self.pageID = pageID; self.blockID = blockID; self.databaseID = databaseID; self.viewID = viewID
        }

        public var json: JSONValue {
            switch kind {
            case .pageBlock:
                return ["kind": "page_block", "pageId": .string(pageID ?? ""), "blockId": .string(blockID ?? "")]
            case .databaseView:
                return ["kind": "database_view", "databaseId": .string(databaseID ?? ""), "viewId": .string(viewID ?? "")]
            }
        }

        public var fingerprint: String {
            switch kind {
            case .pageBlock: return "page_block:\(pageID ?? ""):\(blockID ?? "")"
            case .databaseView: return "database_view:\(databaseID ?? ""):\(viewID ?? "")"
            }
        }
    }

    public enum MessageType: String, Equatable, Sendable {
        case load = "michi-component:load"
        case update = "michi-component:update"
        case theme = "michi-component:theme"
        case rendered = "michi-component:rendered"
        case freeze = "michi-component:freeze"
        case call = "michi-component:call"
        case result = "michi-component:result"
        case error = "michi-component:error"
        case wrapperInit = "michi-component:wrapper-init"
        case wrapperReady = "michi-component:wrapper-ready"
        case wrapperLoad = "michi-component:wrapper-load"
    }

    public struct Message: Equatable, Sendable {
        public var type: MessageType
        public var channel: String
        public var code: String?
        public var props: JSONValue?
        public var data: JSONValue?
        public var theme: [String: String]?
        public var id: Int?
        public var method: String?
        public var args: JSONValue?
        public var ok: Bool?
        public var value: JSONValue?
        public var error: String?
        public var message: String?

        public var json: JSONValue {
            var fields: [String: JSONValue] = ["type": .string(type.rawValue), "channel": .string(channel)]
            if let code { fields["code"] = .string(code) }
            if let props { fields["props"] = props }
            if let data { fields["data"] = data }
            if let theme { fields["theme"] = .object(theme.mapValues(JSONValue.string)) }
            if let id { fields["id"] = .number(Double(id)) }
            if let method { fields["method"] = .string(method) }
            if let args { fields["args"] = args }
            if let ok { fields["ok"] = .bool(ok) }
            if let value { fields["value"] = value }
            if let error { fields["error"] = .string(error) }
            if let message { fields["message"] = .string(message) }
            return .object(fields)
        }
    }

    public enum DocumentError: LocalizedError {
        case missing
        public var errorDescription: String? { "The bundled component sandbox document could not be loaded." }
    }

    public static func makeChannel(bytes: [UInt8]? = nil) -> String {
        let values = bytes ?? (0..<24).map { _ in UInt8.random(in: 0...255) }
        return values.map { String(format: "%02x", $0) }.joined()
    }

    public static func isChannel(_ value: String) -> Bool {
        value.utf8.count >= channelMinimum && value.utf8.count <= channelMaximum
    }

    public static func isThemeValue(_ value: String) -> Bool {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return !trimmed.isEmpty && value.utf8.count <= 300
            && value.range(of: #"url\s*\(|image-set|expression|@import|[;{}<>\\]"#, options: [.regularExpression, .caseInsensitive]) == nil
    }

    public static func parseTheme(_ value: JSONValue) -> [String: String]? {
        guard case .object(let fields) = value else { return nil }
        var theme: [String: String] = [:]
        for (key, entry) in fields {
            guard themeVariables.contains(key), let text = entry.optionalString, isThemeValue(text) else { return nil }
            theme[key] = text
        }
        return theme
    }

    public static func parseHost(_ value: JSONValue) -> Host? {
        guard case .object(let fields) = value else { return nil }
        let keys = Set(fields.keys)
        if value["kind"].stringValue == HostKind.pageBlock.rawValue {
            guard keys == ["kind", "pageId", "blockId"], isID(value["pageId"]), isID(value["blockId"]) else { return nil }
            return Host(kind: .pageBlock, pageID: value["pageId"].stringValue, blockID: value["blockId"].stringValue)
        }
        if value["kind"].stringValue == HostKind.databaseView.rawValue {
            guard keys == ["kind", "databaseId", "viewId"], isID(value["databaseId"]), isID(value["viewId"]) else { return nil }
            return Host(kind: .databaseView, databaseID: value["databaseId"].stringValue, viewID: value["viewId"].stringValue)
        }
        return nil
    }

    public static func parseHostConfig(_ value: JSONValue) -> (componentID: String, pinnedVersion: Int?, props: JSONValue, height: Int?)? {
        guard case .object(let fields) = value, Set(fields.keys).isSubset(of: ["componentId", "pinnedVersion", "props", "height"]),
              isID(value["componentId"]), bounded(value["props"]), case .object = value["props"] else { return nil }
        let pin: Int?
        if value.objectValue.keys.contains("pinnedVersion") {
            guard let number = safeInteger(value["pinnedVersion"]), number >= 1 else { return nil }
            pin = number
        } else { pin = nil }
        let height: Int?
        if value.objectValue.keys.contains("height") {
            guard let number = safeInteger(value["height"]), number >= heightMin, number <= heightMax else { return nil }
            height = number
        } else { height = nil }
        return (value["componentId"].stringValue, pin, value["props"], height)
    }

    /// Handshake-only. Not accepted by `parseMessage`.
    public static func parseWrapperReady(_ value: JSONValue) -> String? {
        guard case .object(let fields) = value, fields.count == 2, value["type"].stringValue == MessageType.wrapperReady.rawValue,
              let channel = value["channel"].optionalString, isChannel(channel) else { return nil }
        return channel
    }

    public static func parseWrapperLoad(_ value: JSONValue) -> Bool {
        guard case .object(let fields) = value else { return false }
        return fields.count == 1 && value["type"].stringValue == MessageType.wrapperLoad.rawValue
    }

    /// The outer document wraps every native post as `{nonce, message}` with the
    /// nonce of its own load, so a late post from a replaced document is dropped.
    public static func parseEnvelope(_ value: JSONValue, nonce: String) -> JSONValue? {
        guard case .object(let fields) = value, fields.count == 2, !nonce.isEmpty,
              let received = value["nonce"].optionalString, sameID(received, nonce),
              case .object = value["message"] else { return nil }
        return value["message"]
    }

    public static func parseMessage(_ value: JSONValue) -> Message? {
        guard case .object(let fields) = value, let type = value["type"].optionalString,
              let channel = value["channel"].optionalString, isChannel(channel) else { return nil }
        func exact(_ keys: [String]) -> Bool { fields.keys.allSatisfy(keys.contains) }
        if (type == MessageType.rendered.rawValue || type == MessageType.freeze.rawValue) && exact(["type", "channel"]) {
            return Message(type: MessageType(rawValue: type)!, channel: channel)
        }
        if type == MessageType.load.rawValue && exact(["type", "channel", "code", "props", "data", "theme"]),
           let code = value["code"].optionalString, code.utf8.count <= codeBytes, case .object = value["props"],
           bounded(value["props"]), bounded(value["data"]) {
            let theme: [String: String]?
            if value.objectValue.keys.contains("theme") && !value["theme"].isNull {
                guard let parsed = parseTheme(value["theme"]) else { return nil }
                theme = parsed
            } else { theme = nil }
            return Message(type: .load, channel: channel, code: code, props: value["props"], data: value["data"], theme: theme)
        }
        if type == MessageType.update.rawValue && exact(["type", "channel", "props", "data"]),
           case .object = value["props"], bounded(value["props"]), bounded(value["data"]) {
            return Message(type: .update, channel: channel, props: value["props"], data: value["data"])
        }
        if type == MessageType.theme.rawValue && exact(["type", "channel", "theme"]), let theme = parseTheme(value["theme"]) {
            return Message(type: .theme, channel: channel, theme: theme)
        }
        if type == MessageType.call.rawValue && exact(["type", "channel", "id", "method", "args"]),
           let id = safeInteger(value["id"]), id > 0, methods.contains(value["method"].stringValue),
           case .array(let args) = value["args"], args.count <= 20, byteCount(value["args"]).map({ $0 <= 64_000 }) == true {
            return Message(type: .call, channel: channel, id: id, method: value["method"].stringValue, args: value["args"])
        }
        if type == MessageType.result.rawValue && exact(["type", "channel", "id", "ok", "value", "error"]),
           let id = safeInteger(value["id"]), id > 0, let ok = value["ok"].featureBool {
            if value.objectValue.keys.contains("error") {
                guard let error = value["error"].optionalString, error.utf8.count <= 2_000 else { return nil }
            }
            if value.objectValue.keys.contains("value") && !value["value"].isNull && !bounded(value["value"]) { return nil }
            return Message(type: .result, channel: channel, id: id, ok: ok, value: value.objectValue.keys.contains("value") ? value["value"] : nil,
                           error: value["error"].optionalString)
        }
        if type == MessageType.error.rawValue && exact(["type", "channel", "message"]),
           let message = value["message"].optionalString, message.utf8.count <= 2_000 {
            return Message(type: .error, channel: channel, message: message)
        }
        return nil
    }

    public static func wrapperInit(channel: String) -> JSONValue {
        ["type": .string(MessageType.wrapperInit.rawValue), "channel": .string(channel)]
    }

    public static func loadMessage(channel: String, code: String, props: JSONValue, data: JSONValue, theme: [String: String]?) -> JSONValue {
        var fields: [String: JSONValue] = [
            "type": .string(MessageType.load.rawValue), "channel": .string(channel), "code": .string(code),
            "props": props, "data": data,
        ]
        if let theme { fields["theme"] = .object(theme.mapValues(JSONValue.string)) }
        return .object(fields)
    }

    public static func updateMessage(channel: String, props: JSONValue, data: JSONValue) -> JSONValue {
        ["type": .string(MessageType.update.rawValue), "channel": .string(channel), "props": props, "data": data]
    }

    public static func themeMessage(channel: String, theme: [String: String]) -> JSONValue {
        ["type": .string(MessageType.theme.rawValue), "channel": .string(channel), "theme": .object(theme.mapValues(JSONValue.string))]
    }

    public static func freezeMessage(channel: String) -> JSONValue {
        ["type": .string(MessageType.freeze.rawValue), "channel": .string(channel)]
    }

    public static func resultMessage(channel: String, id: Int, ok: Bool, value: JSONValue? = nil, error: String? = nil) -> JSONValue {
        var fields: [String: JSONValue] = [
            "type": .string(MessageType.result.rawValue), "channel": .string(channel),
            "id": .number(Double(id)), "ok": .bool(ok),
        ]
        if let value { fields["value"] = value }
        if let error { fields["error"] = .string(String(error.prefix(1000))) }
        return .object(fields)
    }

    public static func bundledHTML() throws -> String {
        guard let url = Bundle.module.url(forResource: "ComponentSandbox", withExtension: "html") else { throw DocumentError.missing }
        let html = String(decoding: try Data(contentsOf: url), as: UTF8.self)
        guard html.hasPrefix("<!doctype html>"), html.contains("worker-src blob:"), html.contains("sandbox allow-scripts") else {
            throw DocumentError.missing
        }
        return html
    }

    public static func makeDocumentNonce() -> String { makeChannel() }

    /// Script evaluated by native to deliver one message to the runner. The
    /// nonce argument must match the outer document's own load nonce.
    public static let hostPostScript = "if (window.__michiHostPost) window.__michiHostPost(nonce, payload)"

    /// Native-owned outer document. The bundled runner is assigned as srcdoc;
    /// user source is never written into this HTML. Every native post is
    /// `{nonce, message}`; host posts with another nonce are ignored.
    public static func outerDocument(sandboxHTML: String, nonce: String = makeDocumentNonce()) -> String {
        let encoded = jsonString(sandboxHTML)
        let encodedNonce = jsonString(nonce)
        return """
        <!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
        <meta http-equiv="Content-Security-Policy" content="\(outerContentSecurityPolicy)">
        <style>html,body,#host{margin:0;width:100%;height:100%;background:transparent;overflow:hidden}iframe{border:0;display:block;width:100%;height:100%;background:transparent}</style>
        </head><body><div id="host"></div><script>
        (() => {
          'use strict';
          const sandboxHTML = \(encoded);
          const nonce = \(encodedNonce);
          const frame = document.createElement('iframe');
          frame.setAttribute('sandbox', '\(iframeSandbox)');
          frame.setAttribute('referrerpolicy', 'no-referrer');
          frame.setAttribute('title', 'Michi component sandbox');
          const host = document.getElementById('host');
          const handler = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.\(messageHandlerName);
          const postNative = message => { if (handler) handler.postMessage({nonce, message}); };
          window.__michiHostPost = function(expected, payload) {
            if (expected !== nonce || !payload || typeof payload !== 'object') return;
            const win = frame.contentWindow;
            if (win) win.postMessage(payload, '*');
          };
          frame.addEventListener('load', () => { postNative({type:'michi-component:wrapper-load'}); });
          addEventListener('message', event => {
            if (event.source !== frame.contentWindow || !event.data || typeof event.data !== 'object') return;
            postNative(event.data);
          });
          frame.srcdoc = sandboxHTML;
          host.appendChild(frame);
        })();
        </script></body></html>
        """
    }

    /// `name -> sources` for the first occurrence of each directive.
    public static func cspDirectives(_ policy: String) -> [String: [String]] {
        var result: [String: [String]] = [:]
        for part in policy.split(separator: ";") {
            let tokens = part.split(whereSeparator: { $0 == " " || $0 == "\t" || $0 == "\n" }).map(String.init)
            guard let name = tokens.first?.lowercased(), result[name] == nil else { continue }
            result[name] = Array(tokens.dropFirst())
        }
        return result
    }

    /// Sources governing `directive` after CSP Level 3 fallback.
    public static func effectiveSources(_ directives: [String: [String]], for directive: String) -> [String] {
        let chain: [String]
        switch directive {
        case "worker-src": chain = ["worker-src", "child-src", "script-src", "default-src"]
        case "frame-src": chain = ["frame-src", "child-src", "default-src"]
        case "child-src", "script-src", "style-src", "img-src", "font-src", "connect-src", "media-src", "object-src":
            chain = [directive, "default-src"]
        default: chain = [directive]
        }
        for name in chain { if let sources = directives[name] { return sources } }
        return []
    }

    /// The runner's own meta policy.
    public static func innerContentSecurityPolicy(of html: String) -> String? {
        let marker = #"http-equiv="Content-Security-Policy" content=""#
        guard let start = html.range(of: marker), let end = html[start.upperBound...].firstIndex(of: "\"") else { return nil }
        return String(html[start.upperBound..<end])
    }

    /// Exact UTF-8 identity. `String ==` uses canonical equivalence, which
    /// would treat distinct opaque byte IDs as equal.
    public static func sameID(_ a: String, _ b: String) -> Bool { a.utf8.elementsEqual(b.utf8) }

    /// Sorted-key JSON bytes. Strings and keys keep their exact UTF-8.
    public static func canonicalData(_ value: JSONValue) -> Data? {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return try? encoder.encode(value)
    }

    /// Byte equality of canonical JSON; non-encodable values never compare equal.
    public static func sameJSON(_ a: JSONValue, _ b: JSONValue) -> Bool {
        guard let left = canonicalData(a), let right = canonicalData(b) else { return false }
        return left == right
    }

    public static func theme(palette: String, accent: String? = nil, uiFont: String = "Geist") -> [String: String] {
        let tokens = palettes[palette] ?? palettes["monokai"]!
        let theme: [String: String] = [
            "--term-bg": tokens.bg, "--term-surface": tokens.surface, "--term-alt": tokens.alt, "--term-alt2": tokens.alt2,
            "--term-line": tokens.line, "--term-line-s": tokens.lineS, "--term-fg": tokens.fg, "--term-mid": tokens.mid,
            "--term-muted": tokens.muted, "--term-faint": tokens.faint, "--term-accent": accent ?? tokens.accent,
            "--term-accent-f": tokens.accentF, "--term-select": tokens.select, "--term-select-f": tokens.selectF,
            "--term-digest": tokens.digest, "--term-digest-f": tokens.digestF, "--term-mauve": tokens.mauve,
            "--term-mauve-f": tokens.mauveF, "--term-danger": tokens.danger,
            "--term-danger-text": tokens.dark ? "color-mix(in srgb, \(tokens.danger) 55%, \(tokens.fg))" : tokens.danger,
            "--ui-font": "'\(uiFont)', system-ui, sans-serif",
            "--font-mono": "'Geist Mono', ui-monospace, monospace",
        ]
        return theme.filter { themeVariables.contains($0.key) && isThemeValue($0.value) }
    }

    /// Converts a WebKit message body under depth, node, and string budgets.
    /// Containers are sized before iteration, so hostile input is refused
    /// without recursing into it. Objects whose keys collide under Unicode
    /// canonical equivalence are refused instead of silently merged.
    public static func json(fromAny value: Any?) -> JSONValue? {
        var budget = InboundBudget()
        return convert(value, depth: 0, budget: &budget)
    }

    private struct InboundBudget {
        var nodes = 0
        var stringUnits = 0

        mutating func spend(nodes count: Int) -> Bool {
            guard count >= 0, count <= ComponentSandbox.inboundMaxNodes - nodes else { return false }
            nodes += count
            return true
        }

        mutating func spend(string text: String) -> Bool {
            let units = text.utf16.count
            guard units <= ComponentSandbox.inboundMaxStringUnits,
                  units <= ComponentSandbox.inboundMaxTotalStringUnits - stringUnits else { return false }
            stringUnits += units
            return true
        }
    }

    private static func convert(_ value: Any?, depth: Int, budget: inout InboundBudget) -> JSONValue? {
        guard depth <= inboundMaxDepth, budget.spend(nodes: 1) else { return nil }
        switch value {
        case nil, is NSNull: return .null
        case let json as JSONValue: return convert(json: json, depth: depth, budget: &budget)
        case let number as NSNumber:
            if CFGetTypeID(number) == CFBooleanGetTypeID() { return .bool(number.boolValue) }
            let double = number.doubleValue
            return double.isFinite ? .number(double) : nil
        case let text as String:
            return budget.spend(string: text) ? .string(text) : nil
        case let values as NSArray:
            guard values.count <= inboundMaxNodes - budget.nodes else { return nil }
            var items: [JSONValue] = []
            items.reserveCapacity(values.count)
            for item in values {
                guard let parsed = convert(item, depth: depth + 1, budget: &budget) else { return nil }
                items.append(parsed)
            }
            return .array(items)
        case let values as NSDictionary:
            guard values.count <= inboundMaxNodes - budget.nodes else { return nil }
            var fields: [String: JSONValue] = [:]
            for (rawKey, item) in values {
                guard let key = rawKey as? String, budget.spend(string: key), fields[key] == nil,
                      let parsed = convert(item, depth: depth + 1, budget: &budget) else { return nil }
                fields[key] = parsed
            }
            return .object(fields)
        default: return nil
        }
    }

    private static func convert(json value: JSONValue, depth: Int, budget: inout InboundBudget) -> JSONValue? {
        switch value {
        case .null, .bool: return value
        case .number(let number): return number.isFinite ? value : nil
        case .string(let text): return budget.spend(string: text) ? value : nil
        case .array(let items):
            guard depth < inboundMaxDepth || items.isEmpty, budget.spend(nodes: items.count) else { return nil }
            for item in items where convert(json: item, depth: depth + 1, budget: &budget) == nil { return nil }
            return value
        case .object(let fields):
            guard depth < inboundMaxDepth || fields.isEmpty, budget.spend(nodes: fields.count) else { return nil }
            for (key, item) in fields {
                guard budget.spend(string: key), convert(json: item, depth: depth + 1, budget: &budget) != nil else { return nil }
            }
            return value
        }
    }

    public static func any(from value: JSONValue) -> Any {
        switch value {
        case .object(let fields): return fields.mapValues { any(from: $0) }
        case .array(let items): return items.map { any(from: $0) }
        case .string(let text): return text
        case .number(let number): return number
        case .bool(let flag): return flag
        case .null: return NSNull()
        }
    }

    public static func isID(_ value: JSONValue) -> Bool {
        guard let text = value.optionalString else { return false }
        return !text.isEmpty && text.utf16.count <= 200
    }

    public static func safeInteger(_ value: JSONValue) -> Int? {
        guard case .number(let number) = value, number.isFinite, number.rounded(.down) == number,
              number >= Double(Int.min), number <= 9_007_199_254_740_991 else { return nil }
        return Int(number)
    }

    public static func bounded(_ value: JSONValue, depth: Int = 0) -> Bool {
        guard depth <= 20 else { return false }
        switch value {
        case .null, .bool: return true
        case .number(let number): return number.isFinite
        case .string(let text): return text.unicodeScalars.count <= propsBytes
        case .array(let items): return items.count <= 2_000 && items.allSatisfy { bounded($0, depth: depth + 1) }
        case .object(let fields):
            return fields.count <= schemaProperties
                && fields.allSatisfy { $0.key.utf16.count <= 200 && bounded($0.value, depth: depth + 1) }
                && (byteCount(value) ?? .max) <= propsBytes
        }
    }

    public static func byteCount(_ value: JSONValue) -> Int? {
        guard let data = try? JSONEncoder().encode(value) else { return nil }
        return data.count
    }

    public static func isExpiredCapability(_ error: Error) -> Bool {
        guard let failure = error as? MichiAPIError, failure.statusCode == 404, failure.code == "not_found" else { return false }
        return failure.message.range(of: #"^Component capability (?:expired|backend changed|was revoked|unavailable)$"#, options: .regularExpression) != nil
    }

    public static func clampHeight(_ value: Double, min: Int = heightMin, max: Int = heightMax) -> Int {
        Int(Swift.min(Double(max), Swift.max(Double(min), value.rounded())))
    }

    public static func jsonString(_ value: String) -> String {
        let data = try? JSONEncoder().encode(value)
        let encoded = data.flatMap { String(data: $0, encoding: .utf8) } ?? "\"\""
        return encoded.replacingOccurrences(of: "<", with: "\\u003c")
    }

    private struct Palette {
        var bg, surface, alt, alt2, line, lineS, fg, mid, muted, faint, accent, accentF, select, selectF, digest, digestF, mauve, mauveF, danger: String
        var dark: Bool
    }

    private static let palettes: [String: Palette] = [
        "bone": Palette(bg: "#fdfdfc", surface: "#ffffff", alt: "#efece5", alt2: "#e8e4d8", line: "#d8d2c4", lineS: "#b5ac98",
                        fg: "#1a1916", mid: "#5a544a", muted: "#70695d", faint: "#8c877c", accent: "#b8451f", accentF: "#f4dccf",
                        select: "#c48300", selectF: "#f8eccf", digest: "#2f6b4e", digestF: "#d7e7df", mauve: "#6d4aa8", mauveF: "#ebe4f6",
                        danger: "#a8261a", dark: false),
        "slate": Palette(bg: "#f3f4f6", surface: "#ffffff", alt: "#e5e7eb", alt2: "#d8dbe1", line: "#d1d5db", lineS: "#9ca3af",
                         fg: "#111827", mid: "#4b5563", muted: "#616876", faint: "#7d8491", accent: "#1a4d8f", accentF: "#dbeafe",
                         select: "#c48300", selectF: "#fef3c7", digest: "#2f6b4e", digestF: "#d1fae5", mauve: "#6d4aa8", mauveF: "#ede9fe",
                         danger: "#b91c1c", dark: false),
        "monokai": Palette(bg: "#272822", surface: "#2d2e28", alt: "#383930", alt2: "#3e3f38", line: "#49483e", lineS: "#75715e",
                           fg: "#f8f8f2", mid: "#c0c0b8", muted: "#a2a298", faint: "#868371", accent: "#66d9ef", accentF: "#12292e",
                           select: "#e6db74", selectF: "#2a2810", digest: "#a6e22e", digestF: "#1a2210", mauve: "#ae81ff", mauveF: "#1e1428",
                           danger: "#f92672", dark: true),
        "gruvbox": Palette(bg: "#282828", surface: "#2e2e2e", alt: "#3c3836", alt2: "#504945", line: "#504945", lineS: "#665c54",
                           fg: "#ebdbb2", mid: "#cabb9b", muted: "#afa088", faint: "#8d816f", accent: "#83a598", accentF: "#1e2826",
                           select: "#fabd2f", selectF: "#2a2410", digest: "#b8bb26", digestF: "#1e2210", mauve: "#d3869b", mauveF: "#281a20",
                           danger: "#fb4934", dark: true),
    ]
}

private extension JSONValue {
    var featureBool: Bool? { if case .bool(let value) = self { return value }; return nil }
}
