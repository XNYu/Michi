import Foundation
import XCTest
import MichiCore
#if canImport(Michi)
@testable import Michi
#else
@testable import MichiState
#endif

@MainActor final class NativeComponentCapabilityTests: XCTestCase {
    private let host: JSONValue = ["kind": "page_block", "pageId": "page-1", "blockId": "block-1"]
    private let viewHost: JSONValue = ["kind": "database_view", "databaseId": "db-1", "viewId": "view-1"]
    private let token = String(repeating: "c", count: 64)

    /// Close is registered first so teardown runs it last, after every drain.
    private func closing(_ transport: AppContractTransport) {
        addTeardownBlock { transport.close() }
    }

    private func draining(_ model: NativeComponentCapabilityModel) {
        addTeardownBlock { await model.shutdown() }
    }

    private func mintPayload(_ capability: String = String(repeating: "c", count: 64), host: JSONValue? = nil, props: JSONValue = [:]) -> JSONValue {
        ["capability": .string(capability), "expiresAt": .number(Date().timeIntervalSince1970 * 1000 + 120_000),
         "componentId": "pc-1", "version": 2, "host": host ?? self.host, "props": props]
    }

    func testPrepareCallUsesExactKeysAndForbidsPageWrites() throws {
        XCTAssertEqual(try NativeComponentCapabilityModel.prepareCall(method: "read.host", args: [], host: host), ["method": "read.host", "args": []])
        XCTAssertEqual(try NativeComponentCapabilityModel.prepareCall(method: "read.database", args: ["db-1"], host: host),
                       ["method": "read.database", "resourceId": "db-1", "args": []])
        XCTAssertThrowsError(try NativeComponentCapabilityModel.prepareCall(method: "write.rows", args: [[]], host: host)) { error in
            XCTAssertEqual(error as? NativeComponentCapabilityError, .pageWrite)
        }
        XCTAssertEqual(try NativeComponentCapabilityModel.prepareCall(method: "write.rows", args: [[["op": "row.add"]]], host: viewHost)["method"], "write.rows")
        XCTAssertThrowsError(try NativeComponentCapabilityModel.prepareCall(method: "shell", args: [], host: host))
        XCTAssertThrowsError(try NativeComponentCapabilityModel.prepareCall(method: "read.host", args: ["x"], host: host))
    }

    func testMintBodyIsExactAndPreviewNeverMints() async {
        let transport = AppContractTransport { request, _ in
            if request.method == "DELETE" {
                XCTAssertEqual(request.path, "/api/component-capabilities/\(self.token)")
                return .json(.null)
            }
            XCTAssertEqual(request.method, "POST")
            XCTAssertEqual(request.path, "/api/component-capabilities")
            XCTAssertEqual(Set(request.body.objectValue.keys), ["workspaceId", "componentId", "version", "host", "props"])
            XCTAssertEqual(request.body["workspaceId"], "workspace-1")
            XCTAssertEqual(request.body["componentId"], "pc-1")
            XCTAssertEqual(request.body["version"], 2)
            XCTAssertEqual(request.body["host"], self.host)
            return .json(self.mintPayload(), status: 201)
        }
        closing(transport)
        let model = NativeComponentCapabilityModel(api: transport.api, workspaceID: "workspace-1")
        draining(model)
        model.configure(componentID: "pc-1", version: 2, host: host, props: ["n": 1], enabled: true, preview: false)
        let deadline = Date().addingTimeInterval(2)
        while model.token == nil && Date() < deadline { try? await Task.sleep(for: .milliseconds(10)) }
        XCTAssertEqual(model.token?.capability, token)
        XCTAssertEqual(transport.requests.filter { $0.method == "POST" }.count, 1)

        let preview = NativeComponentCapabilityModel(api: transport.api, workspaceID: "workspace-1")
        draining(preview)
        preview.configure(componentID: "pc-1", version: 2, host: host, props: [:], enabled: true, preview: true)
        try? await Task.sleep(for: .milliseconds(30))
        XCTAssertNil(preview.token)
        XCTAssertEqual(transport.requests.filter { $0.method == "POST" }.count, 1)
    }

    func testExpiredCallRemintsAndNeverReplaysTheFailedWrite() async {
        var calls = 0
        let transport = AppContractTransport { request, _ in
            if request.path == "/api/component-capabilities" {
                let capability = calls == 0 ? self.token : String(repeating: "n", count: 64)
                return .json(self.mintPayload(capability, host: self.viewHost), status: 201)
            }
            calls += 1
            if calls == 1 {
                return .json(["error": ["code": "not_found", "message": "Component capability was revoked"]], status: 404)
            }
            return .json(["result": ["applied": [["id": "r1"]], "proposed": []]])
        }
        closing(transport)
        let model = NativeComponentCapabilityModel(api: transport.api, workspaceID: "workspace-1")
        draining(model)
        model.configure(componentID: "pc-1", version: 2, host: viewHost, props: [:], enabled: true, preview: false)
        let minted = Date().addingTimeInterval(2)
        while model.token?.capability != token && Date() < minted { try? await Task.sleep(for: .milliseconds(10)) }
        do {
            _ = try await model.call(method: "write.rows", args: [[["op": "row.update", "id": "r1"]]], host: viewHost)
            XCTFail("revoked write must fail")
        } catch {
            XCTAssertTrue(ComponentSandbox.isExpiredCapability(error) || (error as? MichiAPIError)?.statusCode == 404)
        }
        let renewed = Date().addingTimeInterval(2)
        while model.token?.capability != String(repeating: "n", count: 64) && Date() < renewed { try? await Task.sleep(for: .milliseconds(10)) }
        XCTAssertEqual(transport.requests.filter { $0.path.contains("/component-capabilities/") && $0.method == "POST" }.count, 1)
        _ = try? await model.call(method: "write.rows", args: [[["op": "row.update", "id": "r1", "explicit": true]]], host: viewHost)
        XCTAssertEqual(transport.requests.filter { $0.path.contains("/component-capabilities/") && $0.method == "POST" }.count, 2)
    }

    func testPauseAbortsMintRevokesAndRejectsRetainedCallWithoutHTTP() async {
        let transport = AppContractTransport { request, _ in
            if request.method == "POST" && request.path == "/api/component-capabilities" {
                return .delayedJSON(self.mintPayload(), status: 201, delay: 0.2)
            }
            return .json([:])
        }
        closing(transport)
        let model = NativeComponentCapabilityModel(api: transport.api, workspaceID: "workspace-1")
        draining(model)
        model.configure(componentID: "pc-1", version: 2, host: host, props: [:], enabled: true, preview: false)
        model.pause()
        do {
            _ = try await model.call(method: "read.host", args: [], host: host)
            XCTFail("paused call must fail locally")
        } catch {
            XCTAssertEqual(error as? NativeComponentCapabilityError, .paused)
        }
        try? await Task.sleep(for: .milliseconds(350))
        XCTAssertNil(model.token)
        XCTAssertFalse(transport.requests.contains { $0.path.contains("/component-capabilities/") && $0.method == "POST" && $0.path != "/api/component-capabilities" })
        XCTAssertTrue(transport.requests.contains { $0.method == "DELETE" })
    }

    func testLateMintAfterStopIsRevokedAndDoesNotBecomeCurrent() async {
        let transport = AppContractTransport { request, _ in
            if request.path == "/api/component-capabilities" { return .delayedJSON(self.mintPayload(), status: 201, delay: 0.2) }
            return .json([:])
        }
        closing(transport)
        let model = NativeComponentCapabilityModel(api: transport.api, workspaceID: "workspace-1")
        draining(model)
        model.configure(componentID: "pc-1", version: 2, host: host, props: [:], enabled: true, preview: false)
        model.stop()
        try? await Task.sleep(for: .milliseconds(350))
        XCTAssertNil(model.token)
        XCTAssertTrue(transport.requests.contains { $0.method == "DELETE" })
    }

    func testDisabledAndUnknownHostFailClosedWithoutMint() async {
        let transport = AppContractTransport { _, _ in .json(["error": ["code": "not_found"]], status: 404) }
        closing(transport)
        let model = NativeComponentCapabilityModel(api: transport.api, workspaceID: "workspace-1")
        draining(model)
        model.configure(componentID: "pc-1", version: 2, host: host, props: [:], enabled: false, preview: false)
        try? await Task.sleep(for: .milliseconds(30))
        XCTAssertTrue(transport.requests.isEmpty)
        model.configure(componentID: "pc-1", version: 2, host: ["kind": "embed"], props: [:], enabled: true, preview: false)
        try? await Task.sleep(for: .milliseconds(30))
        XCTAssertTrue(transport.requests.isEmpty)
    }

    func testMintResponseMustKeepExactIDsVersionHostAndTokenLength() {
        XCTAssertThrowsError(try NativeComponentCapabilityModel.parseMint(
            mintPayload("short", host: host), componentID: "pc-1", version: 2, host: host))
        XCTAssertThrowsError(try NativeComponentCapabilityModel.parseMint(
            mintPayload(token, host: host).merging(["componentId": "other"]), componentID: "pc-1", version: 2, host: host))
        XCTAssertNoThrow(try NativeComponentCapabilityModel.parseMint(mintPayload(), componentID: "pc-1", version: 2, host: host))
    }

    // MARK: Exact identity, grant lifecycle and failure handling

    private func number(_ index: Int) -> String { "cap-" + String(format: "%060d", index) }

    /// Mints a fresh 64-character token per request and echoes the request.
    private func echoingTransport(expiresIn: Double = 120, props: ((Int) -> JSONValue)? = nil,
                                  call: ((AppContractRequest) -> AppContractResponse)? = nil) -> AppContractTransport {
        AppContractTransport { request, history in
            if request.method == "DELETE" { return .json(.null) }
            if request.method == "POST" && request.path == "/api/component-capabilities" {
                let index = history.filter { $0.method == "POST" && $0.path == "/api/component-capabilities" }.count
                return .json(["capability": .string(self.number(index)),
                              "expiresAt": .number(Date().timeIntervalSince1970 * 1000 + expiresIn * 1000),
                              "componentId": request.body["componentId"], "version": request.body["version"],
                              "host": request.body["host"], "props": props?(index) ?? request.body["props"]], status: 201)
            }
            return call?(request) ?? .json(["result": ["ok": true]])
        }
    }

    private func mints(_ transport: AppContractTransport) -> Int {
        transport.requests.filter { $0.method == "POST" && $0.path == "/api/component-capabilities" }.count
    }

    private func calls(_ transport: AppContractTransport) -> Int {
        transport.requests.filter { $0.method == "POST" && $0.path.hasPrefix("/api/component-capabilities/") }.count
    }

    @discardableResult
    private func eventually(_ what: String, timeout: TimeInterval = 3, file: StaticString = #filePath, line: UInt = #line,
                            _ condition: () -> Bool) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition() {
            guard Date() < deadline else { XCTFail("Timed out waiting for \(what)", file: file, line: line); return false }
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
        return true
    }

    private let quick = NativeComponentCapabilityTiming(retry: 0.2, minimumRetry: 0.1, renewLead: 20)

    func testMintEchoMustMatchExactBytesNotCanonicalEquivalence() {
        let composedHost: JSONValue = ["kind": "page_block", "pageId": "p-\u{E9}", "blockId": "block-1"]
        let decomposedHost: JSONValue = ["kind": "page_block", "pageId": "p-e\u{301}", "blockId": "block-1"]
        let payload: JSONValue = ["capability": .string(token), "expiresAt": .number(Date().timeIntervalSince1970 * 1000 + 120_000),
                                  "componentId": "c-e\u{301}", "version": 2, "host": composedHost, "props": [:]]
        XCTAssertThrowsError(try NativeComponentCapabilityModel.parseMint(payload, componentID: "c-\u{E9}", version: 2, host: composedHost))
        XCTAssertNoThrow(try NativeComponentCapabilityModel.parseMint(payload, componentID: "c-e\u{301}", version: 2, host: composedHost))
        XCTAssertThrowsError(try NativeComponentCapabilityModel.parseMint(payload, componentID: "c-e\u{301}", version: 2, host: decomposedHost))
        for bad in [
            payload.merging(["expiresAt": 0]),
            payload.merging(["props": "granted"]),
            payload.merging(["version": .number(2.5)]),
            payload.merging(["capability": .string(String(repeating: "c", count: 4_097))]),
        ] {
            XCTAssertThrowsError(try NativeComponentCapabilityModel.parseMint(bad, componentID: "c-e\u{301}", version: 2, host: composedHost))
        }
        let scopeA = NativeComponentCapabilityModel.scopeKey(workspaceID: "w", componentID: "c-\u{E9}", version: 2, host: host)
        let scopeB = NativeComponentCapabilityModel.scopeKey(workspaceID: "w", componentID: "c-e\u{301}", version: 2, host: host)
        XCTAssertNotNil(scopeA)
        XCTAssertNotEqual(scopeA, scopeB)
    }

    func testSameIdentityKeepsTheGrantAndABindingChangeRemints() async {
        let transport = echoingTransport()
        closing(transport)
        let model = NativeComponentCapabilityModel(api: transport.api, workspaceID: "workspace-1", timing: quick)
        draining(model)
        model.configure(componentID: "pc-1", version: 2, host: viewHost, props: ["n": 1], bindingKey: [1, 0], enabled: true, preview: false)
        await eventually("the first token") { model.token != nil }
        let first = model.token?.capability
        let authority = model.authority
        model.configure(componentID: "pc-1", version: 2, host: viewHost, props: ["n": 1], bindingKey: [1, 0], enabled: true, preview: false)
        XCTAssertEqual(model.token?.capability, first, "identical identity bytes keep the grant")
        XCTAssertEqual(model.authority, authority)

        model.configure(componentID: "pc-1", version: 2, host: viewHost, props: ["n": 1], bindingKey: [2, 0], enabled: true, preview: false)
        XCTAssertNil(model.token, "a binding change ends the old grant at once")
        XCTAssertGreaterThan(model.authority, authority)
        await eventually("the re-minted token") { model.token != nil }
        XCTAssertNotEqual(model.token?.capability, first)
        XCTAssertEqual(mints(transport), 2)
        await eventually("the replaced token is revoked") {
            transport.requests.contains { $0.method == "DELETE" && $0.path == "/api/component-capabilities/\(first ?? "")" }
        }
    }

    func testStopAndPauseForgetTheIdentitySoTheNextConfigureMints() async {
        let transport = echoingTransport()
        closing(transport)
        let model = NativeComponentCapabilityModel(api: transport.api, workspaceID: "workspace-1", timing: quick)
        draining(model)
        func configure() { model.configure(componentID: "pc-1", version: 2, host: viewHost, props: [:], enabled: true, preview: false) }
        configure()
        await eventually("the first token") { model.token != nil }
        model.stop()
        XCTAssertNil(model.token)
        XCTAssertNil(model.identity)
        configure()
        await eventually("a token after stop") { model.token != nil && self.mints(transport) == 2 }
        model.pause()
        XCTAssertTrue(model.paused)
        configure()
        XCTAssertFalse(model.paused, "configuring an enabled source resumes explicitly")
        await eventually("a token after pause") { model.token != nil && self.mints(transport) == 3 }
    }

    func testSameGrantRenewalKeepsAuthorityAndAChangedGrantAdvancesIt() async {
        let transport = echoingTransport(expiresIn: 1.3, props: { index in index >= 3 ? ["a": 2] : ["a": 1] })
        closing(transport)
        let model = NativeComponentCapabilityModel(api: transport.api, workspaceID: "workspace-1",
            timing: NativeComponentCapabilityTiming(retry: 0.2, minimumRetry: 0.1, renewLead: 1))
        draining(model)
        var changes: [String?] = []
        model.configure(componentID: "pc-1", version: 2, host: viewHost, props: [:], enabled: true, preview: false)
        await eventually("the first token") { model.token?.capability == self.number(1) }
        model.onTokenChange = { changes.append($0?.capability) }
        let authority = model.authority
        await eventually("a same-grant renewal") { model.token?.capability == self.number(2) }
        XCTAssertEqual(model.authority, authority, "a renewal of the same grant keeps results deliverable")
        XCTAssertFalse(changes.contains(where: { $0 == nil }), "a renewal never withdraws the grant first")
        await eventually("a renewal with different props") { model.token?.capability == self.number(3) }
        XCTAssertEqual(model.token?.props, ["a": 2])
        XCTAssertEqual(model.authority, authority + 1)
        model.stop()
    }

    func testHostChangedCallRemintsOnceAndNeverReplays() async {
        var answered = 0
        let transport = echoingTransport(call: { _ in
            answered += 1
            return answered == 1 ? .json(["error": ["code": "conflict", "message": "Component host changed"]], status: 409)
                : .json(["result": ["applied": [], "proposed": [], "rejected": []]])
        })
        closing(transport)
        let model = NativeComponentCapabilityModel(api: transport.api, workspaceID: "workspace-1", timing: quick)
        draining(model)
        model.configure(componentID: "pc-1", version: 2, host: viewHost, props: [:], enabled: true, preview: false)
        await eventually("the first token") { model.token != nil }
        do {
            _ = try await model.call(method: "write.rows", args: [[["op": "row.add"]]], host: viewHost)
            XCTFail("the conflicting write must fail")
        } catch {
            XCTAssertEqual((error as? MichiAPIError)?.statusCode, 409)
        }
        XCTAssertEqual(calls(transport), 1)
        await eventually("the renewed token") { model.token?.capability == self.number(2) }
        XCTAssertEqual(calls(transport), 1, "the failed write is not replayed")
        do {
            _ = try await model.call(method: "read.host", args: [], host: otherHost)
            XCTFail("another host is refused locally")
        } catch {
            XCTAssertEqual(error as? NativeComponentCapabilityError, .stale)
        }
        XCTAssertEqual(calls(transport), 1)
    }

    private let otherHost: JSONValue = ["kind": "database_view", "databaseId": "db-1", "viewId": "view-2"]

    func testVersionChangedCallStopsAndSignalsTheSourceWithoutReminting() async {
        let transport = echoingTransport(call: { _ in
            .json(["error": ["code": "conflict", "message": "Component version changed"]], status: 409)
        })
        closing(transport)
        let model = NativeComponentCapabilityModel(api: transport.api, workspaceID: "workspace-1", timing: quick)
        draining(model)
        var signals: [NativeComponentCapabilitySignal] = []
        model.onSignal = { signals.append($0) }
        model.configure(componentID: "pc-1", version: 2, host: viewHost, props: [:], enabled: true, preview: false)
        await eventually("the first token") { model.token != nil }
        _ = try? await model.call(method: "read.host", args: [], host: viewHost)
        XCTAssertEqual(signals, [.sourceChanged("Component version changed")])
        XCTAssertNil(model.token)
        XCTAssertNil(model.identity)
        try? await Task.sleep(nanoseconds: 400_000_000)
        XCTAssertEqual(mints(transport), 1, "the source is re-read before any new grant")
    }

    func testMissingSourceMintSignalsAndDoesNotRetry() async {
        let transport = AppContractTransport { _, _ in
            .json(["error": ["code": "not_found", "message": "Component not found"]], status: 404)
        }
        closing(transport)
        let model = NativeComponentCapabilityModel(api: transport.api, workspaceID: "workspace-1", timing: quick)
        draining(model)
        var signals: [NativeComponentCapabilitySignal] = []
        model.onSignal = { signals.append($0) }
        model.configure(componentID: "pc-1", version: 2, host: viewHost, props: [:], enabled: true, preview: false)
        await eventually("the missing signal") { !signals.isEmpty }
        XCTAssertEqual(signals, [.sourceMissing("Component not found")])
        try? await Task.sleep(nanoseconds: 500_000_000)
        XCTAssertEqual(mints(transport), 1, "a gone source is never retried in a loop")
    }

    func testConflictingMintSignalsAndRetriesAfterTheDelay() async {
        let transport = AppContractTransport { request, history in
            let index = history.filter { $0.path == "/api/component-capabilities" }.count
            if request.method == "POST", request.path == "/api/component-capabilities", index == 1 {
                return .json(["error": ["code": "conflict", "message": "Component version changed"]], status: 409)
            }
            if request.method == "POST", request.path == "/api/component-capabilities" {
                return .json(self.mintPayload(host: self.viewHost), status: 201)
            }
            return .json(.null)
        }
        closing(transport)
        let model = NativeComponentCapabilityModel(api: transport.api, workspaceID: "workspace-1", timing: quick)
        draining(model)
        var signals: [NativeComponentCapabilitySignal] = []
        model.onSignal = { signals.append($0) }
        model.configure(componentID: "pc-1", version: 2, host: viewHost, props: [:], enabled: true, preview: false)
        await eventually("the retried token") { model.token != nil }
        XCTAssertEqual(signals, [.sourceChanged("Component version changed")])
        XCTAssertEqual(mints(transport), 2)
    }

    func testWriteOutcomeClassificationTreatsOnlyAnsweredRefusalsAsNotApplied() {
        typealias Model = NativeComponentCapabilityModel
        XCTAssertFalse(Model.writeOutcomeUnknown(NativeComponentCapabilityError.paused))
        XCTAssertFalse(Model.writeOutcomeUnknown(NativeComponentCapabilityError.pageWrite))
        XCTAssertTrue(Model.writeOutcomeUnknown(CancellationError()))
        XCTAssertTrue(Model.writeOutcomeUnknown(URLError(.timedOut)))
        for code in [MichiAPIError.Code.timedOut, MichiAPIError.Code.network, MichiAPIError.Code.invalidResponse] {
            XCTAssertTrue(Model.writeOutcomeUnknown(MichiAPIError(statusCode: nil, code: code, message: "x")), code)
        }
        for code in [MichiAPIError.Code.invalidConfiguration, MichiAPIError.Code.invalidPath,
                     MichiAPIError.Code.invalidRequest, MichiAPIError.Code.insecureURL] {
            XCTAssertFalse(Model.writeOutcomeUnknown(MichiAPIError(statusCode: nil, code: code, message: "x")), code)
        }
        for status in [200, 302, 408, 500, 502, 503] {
            XCTAssertTrue(Model.writeOutcomeUnknown(MichiAPIError(statusCode: status, code: nil, message: "x")), "\(status)")
        }
        for status in [400, 401, 403, 404, 409, 422, 429] {
            XCTAssertFalse(Model.writeOutcomeUnknown(MichiAPIError(statusCode: status, code: nil, message: "x")), "\(status)")
        }
        XCTAssertTrue(Model.confirmedWrite(["applied": [], "proposed": [], "rejected": []]))
        XCTAssertFalse(Model.confirmedWrite(["applied": [], "proposed": []]))
        XCTAssertFalse(Model.confirmedWrite(["applied": "r1", "proposed": [], "rejected": []]))
        XCTAssertFalse(Model.confirmedWrite([[]]))
        XCTAssertTrue(Model.writeChanged(["applied": [["id": "r1"]], "proposed": []]))
        XCTAssertFalse(Model.writeChanged(["applied": [], "proposed": [], "rejected": [["id": "r1"]]]))
    }

    func testRevokerRevokesEveryTokenLeftWhenTornDown() async {
        let transport = AppContractTransport { _, _ in .json(.null) }
        closing(transport)
        var revoker: NativeComponentCapabilityRevoker? = NativeComponentCapabilityRevoker(api: transport.api)
        revoker?.track(number(1))
        revoker?.track(number(2))
        revoker?.revoke(number(1))
        revoker?.revoke(number(1))
        XCTAssertEqual(revoker?.liveCount, 1)
        revoker = nil
        await eventually("both revocations") { transport.requests.filter { $0.method == "DELETE" }.count == 2 }
        XCTAssertEqual(Set(transport.requests.filter { $0.method == "DELETE" }.map(\.path)),
                       ["/api/component-capabilities/\(number(1))", "/api/component-capabilities/\(number(2))"])
    }

    func testShutdownDrainsLiveTokensSoDeinitDoesNotCreateAnotherRequest() async {
        let transport = echoingTransport()
        closing(transport)
        var model: NativeComponentCapabilityModel? = NativeComponentCapabilityModel(
            api: transport.api, workspaceID: "workspace-1", timing: quick)
        model?.configure(componentID: "pc-1", version: 2, host: viewHost, props: [:], enabled: true, preview: false)
        await eventually("the minted token") { model?.token != nil }
        XCTAssertEqual(model?.revoker.liveCount, 1)
        await model?.shutdown()
        XCTAssertEqual(model?.revoker.liveCount, 0)
        await eventually("the drained revocation") { transport.requests.contains { $0.method == "DELETE" } }
        let deletes = transport.requests.filter { $0.method == "DELETE" }.count
        XCTAssertGreaterThanOrEqual(deletes, 1)
        model = nil
        try? await Task.sleep(nanoseconds: 80_000_000)
        XCTAssertEqual(transport.requests.filter { $0.method == "DELETE" }.count, deletes,
                       "deinit after drain must not start another DELETE on the session")
    }
}
