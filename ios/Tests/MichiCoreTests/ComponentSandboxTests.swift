import XCTest
@testable import MichiCore

final class ComponentSandboxTests: XCTestCase {
    private let channel = String(repeating: "a", count: 32)

    func testBundledHTMLMatchesWorkerCSPAndOmitsNetworkAndSecrets() throws {
        let html = try ComponentSandbox.bundledHTML()
        XCTAssertTrue(html.hasPrefix("<!doctype html>"))
        XCTAssertTrue(html.contains("default-src 'none'"))
        XCTAssertTrue(html.contains("worker-src blob:"))
        XCTAssertTrue(html.contains("connect-src 'none'"))
        XCTAssertTrue(html.contains("sandbox allow-scripts"))
        XCTAssertTrue(html.contains("new Function(\"root\",\"props\",\"data\",\"call\",\"document\""))
        XCTAssertTrue(html.contains("michi-component:wrapper-init"))
        XCTAssertFalse(html.contains("Authorization"))
        XCTAssertFalse(html.contains("Bearer "))
        XCTAssertNil(html.range(of: #"https?://[a-z0-9.-]+"#, options: .regularExpression))
    }

    func testOuterDocumentWrapsExactSrcdocAndNeverEmbedsUserCode() throws {
        let inner = try ComponentSandbox.bundledHTML()
        let outer = ComponentSandbox.outerDocument(sandboxHTML: inner)
        XCTAssertTrue(outer.contains("sandbox"))
        XCTAssertTrue(outer.contains("allow-scripts"))
        XCTAssertTrue(outer.contains("__michiHostPost"))
        XCTAssertTrue(outer.contains(ComponentSandbox.messageHandlerName))
        let start = try XCTUnwrap(outer.range(of: "const sandboxHTML = "))
        let assignment = String(outer[start.upperBound...].prefix(while: { $0 != "\n" }))
        let literal = String(assignment.dropLast()) // trailing semicolon
        let decoded = try JSONDecoder().decode(String.self, from: Data(literal.utf8))
        XCTAssertTrue(decoded.utf8.elementsEqual(inner.utf8), "The embedded srcdoc must round-trip exactly")
        XCTAssertFalse(literal.lowercased().contains("</script"))
        XCTAssertTrue(outer.contains("\\u003c"))
        XCTAssertFalse(outer.contains("root.textContent = 'owned by the user'"))
        XCTAssertFalse(outer.contains("Authorization"))
    }

    func testParseRejectsExtraKeysShortChannelAndUnknownMethods() {
        let call: JSONValue = ["type": "michi-component:call", "channel": .string(channel), "id": 1, "method": "read.host", "args": []]
        XCTAssertEqual(ComponentSandbox.parseMessage(call)?.method, "read.host")
        XCTAssertNil(ComponentSandbox.parseMessage(call.merging(["extra": true])))
        XCTAssertNil(ComponentSandbox.parseMessage(call.merging(["method": "shell"])))
        XCTAssertNil(ComponentSandbox.parseMessage(call.merging(["channel": "short"])))
        XCTAssertNil(ComponentSandbox.parseMessage(["type": "michi-component:update", "channel": .string(channel), "props": [:],
            "data": ["rows": .array((0..<2_000).map { _ in ["text": .string(String(repeating: "x", count: 100))] })]]))
    }

    func testThemeAllowsKnownSafeValuesAndRejectsLoaderText() {
        let load: JSONValue = ["type": "michi-component:load", "channel": .string(channel), "code": "root.textContent=\"x\"", "props": [:], "data": [:]]
        let theme: JSONValue = ["--term-fg": "#eeeeee", "--term-danger-text": "color-mix(in srgb, #e06c75 55%, #eeeeee)", "--ui-font": "'Geist', system-ui, sans-serif"]
        XCTAssertNotNil(ComponentSandbox.parseMessage(load))
        XCTAssertNotNil(ComponentSandbox.parseMessage(load.merging(["theme": theme])))
        XCTAssertNotNil(ComponentSandbox.parseMessage(["type": "michi-component:theme", "channel": .string(channel), "theme": theme]))
        XCTAssertNil(ComponentSandbox.parseMessage(["type": "michi-component:theme", "channel": .string(channel)]))
        for bad in [
            JSONValue.object(["--term-composer-bg": "#fff"]),
            ["color": "red"],
            ["--term-bg": "url(https://t.example/a.png)"],
            ["--term-bg": "#fff; background: red"],
            ["--term-bg": "}body{"],
            ["--term-bg": ""],
            ["--term-bg": .string(String(repeating: "x", count: 301))],
            ["--term-bg": 1],
        ] as [JSONValue] {
            XCTAssertNil(ComponentSandbox.parseMessage(load.merging(["theme": bad])), bad.prettyPrinted)
            XCTAssertNil(ComponentSandbox.parseTheme(bad), bad.prettyPrinted)
        }
    }

    func testWrapperReadyIsExactlyTwoKeysAndNotAParsedMessage() {
        let ready: JSONValue = ["type": "michi-component:wrapper-ready", "channel": .string(channel)]
        XCTAssertEqual(ComponentSandbox.parseWrapperReady(ready), channel)
        XCTAssertNil(ComponentSandbox.parseMessage(ready))
        XCTAssertNil(ComponentSandbox.parseWrapperReady(ready.merging(["extra": true])))
        XCTAssertNil(ComponentSandbox.parseWrapperReady(["type": "michi-component:wrapper-ready", "channel": "short"]))
    }

    func testHostAndConfigParsersKeepExactKeysAndOpaqueIDs() {
        XCTAssertEqual(ComponentSandbox.parseHost(["kind": "page_block", "pageId": "page-1", "blockId": "block-1"])?.fingerprint, "page_block:page-1:block-1")
        XCTAssertEqual(ComponentSandbox.parseHost(["kind": "database_view", "databaseId": "db-1", "viewId": "view-1"])?.kind, .databaseView)
        XCTAssertNil(ComponentSandbox.parseHost(["kind": "page_block", "pageId": "page-1", "blockId": "block-1", "extra": true]))
        XCTAssertNil(ComponentSandbox.parseHost(["kind": "embed", "url": "https://example.com"]))
        let config = ComponentSandbox.parseHostConfig(["componentId": "pc-1", "pinnedVersion": 2, "props": ["n": 1], "height": 240])
        XCTAssertEqual(config?.componentID, "pc-1")
        XCTAssertEqual(config?.pinnedVersion, 2)
        XCTAssertEqual(config?.height, 240)
        XCTAssertNil(ComponentSandbox.parseHostConfig(["componentId": "pc-1", "pinnedVersion": 0, "props": [:]]))
    }

    func testChannelIsTwentyFourRandomBytesAndPreviewDataIsTheWebSample() {
        let bytes = Array(UInt8(0)..<24)
        XCTAssertEqual(ComponentSandbox.makeChannel(bytes: bytes), bytes.map { String(format: "%02x", $0) }.joined())
        XCTAssertEqual(ComponentSandbox.makeChannel().count, 48)
        XCTAssertEqual(ComponentSandbox.previewData, ["sample": true, "value": 12, "label": "Example"])
    }

    func testThemeTokensMatchKnownPalettesWithoutImportOrURL() {
        let theme = ComponentSandbox.theme(palette: "monokai", accent: "#66d9ef")
        XCTAssertEqual(theme["--term-bg"], "#272822")
        XCTAssertEqual(theme["--term-accent"], "#66d9ef")
        XCTAssertTrue(theme.values.allSatisfy(ComponentSandbox.isThemeValue))
        XCTAssertEqual(Set(theme.keys), Set(ComponentSandbox.themeVariables))
    }

    // MARK: Bridge conversion budgets (M2)

    func testBridgeConversionRefusesDeepNestingWithoutRecursingIntoIt() {
        var nested: Any = NSArray()
        for _ in 0..<10_000 { nested = NSArray(object: nested) }
        XCTAssertNil(ComponentSandbox.json(fromAny: nested))
        XCTAssertNil(ComponentSandbox.json(fromAny: ["nonce": "n", "message": nested] as NSDictionary))

        var shallow: Any = NSArray()
        for _ in 0..<ComponentSandbox.inboundMaxDepth { shallow = NSArray(object: shallow) }
        XCTAssertNotNil(ComponentSandbox.json(fromAny: shallow))
        XCTAssertNil(ComponentSandbox.json(fromAny: NSArray(object: shallow)))

        var deepJSON = JSONValue.array([])
        for _ in 0..<5_000 { deepJSON = .array([deepJSON]) }
        XCTAssertNil(ComponentSandbox.json(fromAny: deepJSON))
    }

    func testBridgeConversionRefusesWideArraysAndObjectsBeforeIterating() {
        let huge = NSArray(array: Array(repeating: NSNumber(value: 1), count: 1_000_000))
        XCTAssertNil(ComponentSandbox.json(fromAny: huge))
        let limit = ComponentSandbox.inboundMaxNodes
        XCTAssertNotNil(ComponentSandbox.json(fromAny: NSArray(array: Array(repeating: NSNumber(value: 1), count: limit - 1))))
        XCTAssertNil(ComponentSandbox.json(fromAny: NSArray(array: Array(repeating: NSNumber(value: 1), count: limit))))
        let wide = NSMutableDictionary()
        for index in 0...limit { wide.setObject(NSNumber(value: index), forKey: "k\(index)" as NSString) }
        XCTAssertNil(ComponentSandbox.json(fromAny: wide))
    }

    func testBridgeConversionBudgetsStringsAndRefusesNonFiniteOrUnknownTypes() {
        let longest = String(repeating: "x", count: ComponentSandbox.inboundMaxStringUnits)
        XCTAssertEqual(ComponentSandbox.json(fromAny: longest), .string(longest))
        XCTAssertNil(ComponentSandbox.json(fromAny: longest + "x"))
        let many = NSArray(array: Array(repeating: String(repeating: "y", count: 60_000), count: 5))
        XCTAssertNil(ComponentSandbox.json(fromAny: many), "the total string budget applies across the message")
        XCTAssertNil(ComponentSandbox.json(fromAny: NSNumber(value: Double.nan)))
        XCTAssertNil(ComponentSandbox.json(fromAny: NSNumber(value: Double.infinity)))
        XCTAssertNil(ComponentSandbox.json(fromAny: Date()))
        let numericKey = NSMutableDictionary()
        numericKey.setObject("integer key" as NSString, forKey: NSNumber(value: 1))
        XCTAssertNil(ComponentSandbox.json(fromAny: numericKey))
    }

    func testBridgeConversionRefusesCanonicallyCollidingKeys() {
        let colliding = NSMutableDictionary()
        colliding.setObject(NSNumber(value: 1), forKey: "\u{E9}" as NSString)
        colliding.setObject(NSNumber(value: 2), forKey: "e\u{301}" as NSString)
        XCTAssertEqual(colliding.count, 2, "Foundation keeps both byte-distinct keys")
        XCTAssertNil(ComponentSandbox.json(fromAny: colliding))
    }

    func testBridgeConversionKeepsAnOrdinaryEnvelopeExactly() {
        let operation: [String: Any] = ["op": "row.update", "id": "r1", "done": true, "note": NSNull()]
        let message: [String: Any] = [
            "type": "michi-component:call", "channel": channel, "id": 7, "method": "write.rows",
            "args": [[operation] as [Any]] as [Any],
        ]
        let body: [String: Any] = ["nonce": "n-1", "message": message]
        let expected: JSONValue = ["nonce": "n-1", "message": [
            "type": "michi-component:call", "channel": .string(channel), "id": 7, "method": "write.rows",
            "args": [[["op": "row.update", "id": "r1", "done": true, "note": .null]]],
        ]]
        XCTAssertEqual(ComponentSandbox.json(fromAny: body), expected)
        XCTAssertEqual(ComponentSandbox.json(fromAny: NSNumber(value: true)), .bool(true))
        XCTAssertEqual(ComponentSandbox.json(fromAny: NSNumber(value: 1)), .number(1))
    }

    // MARK: First-load CSP (M3)

    func testOuterPolicyAdmitsEverythingTheInheritingRunnerAndWorkerNeed() throws {
        let html = try ComponentSandbox.bundledHTML()
        let innerPolicy = try XCTUnwrap(ComponentSandbox.innerContentSecurityPolicy(of: html))
        let inner = ComponentSandbox.cspDirectives(innerPolicy)
        let outer = ComponentSandbox.cspDirectives(ComponentSandbox.outerContentSecurityPolicy)
        XCTAssertTrue(ComponentSandbox.effectiveSources(inner, for: "script-src").contains("'unsafe-eval'"))
        XCTAssertEqual(ComponentSandbox.effectiveSources(inner, for: "worker-src"), ["blob:"])
        // A srcdoc document enforces its parent's policy as well as its own, and
        // the Blob Worker inherits both: every source the runner uses must also
        // be allowed by the outer policy.
        for directive in ["script-src", "worker-src", "style-src", "img-src", "font-src"] {
            let needed = ComponentSandbox.effectiveSources(inner, for: directive).filter { $0 != "'none'" }
            let allowed = Set(ComponentSandbox.effectiveSources(outer, for: directive))
            XCTAssertFalse(needed.isEmpty, directive)
            for source in needed { XCTAssertTrue(allowed.contains(source), "\(directive) must allow \(source)") }
        }
        XCTAssertTrue(ComponentSandbox.effectiveSources(outer, for: "frame-src").contains("about:"), "the srcdoc frame itself")
    }

    func testOuterPolicyStillForbidsNetworkPluginsAndNavigation() throws {
        let policy = ComponentSandbox.outerContentSecurityPolicy
        let outer = ComponentSandbox.cspDirectives(policy)
        XCTAssertEqual(outer["default-src"], ["'none'"])
        for directive in ["connect-src", "media-src", "object-src", "base-uri", "form-action"] {
            XCTAssertEqual(outer[directive], ["'none'"], directive)
        }
        for source in outer.values.flatMap({ $0 }) {
            XCTAssertFalse(source.contains("http") || source.contains("*") || source == "'self'", source)
        }
        XCTAssertFalse(policy.contains("http"))
        XCTAssertFalse(policy.contains("*"))
        XCTAssertFalse(policy.contains("'self'"))
        let document = ComponentSandbox.outerDocument(sandboxHTML: try ComponentSandbox.bundledHTML(), nonce: "nonce-a")
        XCTAssertTrue(document.contains("content=\"\(policy)\""))
    }

    // MARK: Per-load nonce (S7)

    func testOuterDocumentTagsEveryPostWithItsNonceAndChecksHostPosts() {
        let outer = ComponentSandbox.outerDocument(sandboxHTML: "<p>runner</p>", nonce: "nonce-123")
        XCTAssertTrue(outer.contains("const nonce = \"nonce-123\";"))
        XCTAssertTrue(outer.contains("handler.postMessage({nonce, message})"))
        XCTAssertTrue(outer.contains("expected !== nonce"))
        XCTAssertEqual(ComponentSandbox.hostPostScript, "if (window.__michiHostPost) window.__michiHostPost(nonce, payload)")
        XCTAssertFalse(outer.contains("handler.postMessage(event.data)"), "runner messages are never forwarded unwrapped")
        XCTAssertNotEqual(ComponentSandbox.makeDocumentNonce(), ComponentSandbox.makeDocumentNonce())
    }

    func testEnvelopeAcceptsOnlyItsOwnExactNonce() {
        let message: JSONValue = ["type": "michi-component:wrapper-load"]
        XCTAssertEqual(ComponentSandbox.parseEnvelope(["nonce": "abc", "message": message], nonce: "abc"), message)
        XCTAssertNil(ComponentSandbox.parseEnvelope(["nonce": "abd", "message": message], nonce: "abc"))
        XCTAssertNil(ComponentSandbox.parseEnvelope(message, nonce: "abc"))
        XCTAssertNil(ComponentSandbox.parseEnvelope(["nonce": "abc", "message": message, "extra": 1], nonce: "abc"))
        XCTAssertNil(ComponentSandbox.parseEnvelope(["nonce": "abc", "message": "text"], nonce: "abc"))
        XCTAssertNil(ComponentSandbox.parseEnvelope(["nonce": "", "message": message], nonce: ""))
        XCTAssertNil(ComponentSandbox.parseEnvelope(["nonce": "\u{E9}", "message": message], nonce: "e\u{301}"))
    }

    // MARK: Exact identity (M10)

    func testIdentityComparisonsUseExactBytesNotCanonicalEquivalence() throws {
        let composed = "\u{E9}", decomposed = "e\u{301}"
        XCTAssertEqual(composed, decomposed, "Swift String equality is canonical")
        XCTAssertEqual(JSONValue.string(composed), JSONValue.string(decomposed))
        XCTAssertFalse(ComponentSandbox.sameID(composed, decomposed))
        XCTAssertTrue(ComponentSandbox.sameID("pc-1", "pc-1"))
        XCTAssertFalse(ComponentSandbox.sameJSON(["pageId": .string(composed)], ["pageId": .string(decomposed)]))
        XCTAssertFalse(ComponentSandbox.sameJSON(.object([composed: 1]), .object([decomposed: 1])))
        XCTAssertTrue(ComponentSandbox.sameJSON(["a": 1, "b": [true, "x"]], ["b": [true, "x"], "a": 1]))
        XCTAssertEqual(ComponentSandbox.canonicalData(["b": 1, "a": 2]), ComponentSandbox.canonicalData(["a": 2, "b": 1]))
        let text = ComponentSandbox.canonicalData(["b": 1, "a": 2]).flatMap { String(data: $0, encoding: .utf8) } ?? ""
        XCTAssertLessThan(try XCTUnwrap(text.range(of: "\"a\"")).lowerBound, try XCTUnwrap(text.range(of: "\"b\"")).lowerBound)
        XCTAssertFalse(ComponentSandbox.sameJSON(.number(.nan), .number(.nan)), "unencodable values never compare equal")
    }

    func testClampHeightIsTotalForAnyFiniteMagnitude() {
        XCTAssertEqual(ComponentSandbox.clampHeight(1e300), ComponentSandbox.heightMax)
        XCTAssertEqual(ComponentSandbox.clampHeight(-1e300), ComponentSandbox.heightMin)
        XCTAssertEqual(ComponentSandbox.clampHeight(1e19), ComponentSandbox.heightMax)
        XCTAssertEqual(ComponentSandbox.clampHeight(240.4), 240)
        XCTAssertEqual(ComponentSandbox.clampHeight(1e19, min: ComponentSandbox.previewHeightMin, max: ComponentSandbox.previewHeightMax), 520)
    }
}
