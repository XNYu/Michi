import Foundation
import XCTest
import MichiCore
#if canImport(Michi)
@testable import Michi
#else
@testable import MichiState
#endif

/// Programmable component backend for one test. The handler runs on
/// URLProtocol threads, so every field is read and written under the lock.
private final class ComponentBackend: @unchecked Sendable {
    struct State {
        var componentID = "pc-1"
        var enabled = true
        var activeVersion = 2
        var versions = 3
        var extraItems: [JSONValue] = []
        /// Granted props for every mint; nil echoes the requested props.
        var grantedProps: JSONValue?
        /// Granted props for mint N (1-based), before `grantedProps`.
        var grants: [JSONValue] = []
        var expiresIn: Double = 120
        var mintResponse: AppContractResponse?
        var write: AppContractResponse = ComponentBackend.applied
        var navigateDelay: TimeInterval = 0
        var readHostDelay: TimeInterval = 0
        var readDatabaseDelay: TimeInterval = 0
        var hostData: JSONValue = ["page": ["id": "page-1", "title": "Plan"]]
        var mints = 0
    }

    static let applied: AppContractResponse = .json(["result": ["applied": [["id": "r1"]], "proposed": [], "rejected": []]])

    private let lock = NSLock()
    private var state = State()
    private(set) var transport: AppContractTransport!

    init() {
        transport = AppContractTransport { [weak self] request, _ in
            self?.respond(request) ?? .failure(.cancelled)
        }
    }

    func update(_ change: (inout State) -> Void) { lock.lock(); change(&state); lock.unlock() }
    var mints: Int { lock.lock(); defer { lock.unlock() }; return state.mints }
    var mintBodies: [JSONValue] {
        transport.requests.filter { $0.method == "POST" && $0.path == "/api/component-capabilities" }.map { $0.body }
    }
    func calls(_ method: String) -> [AppContractRequest] {
        transport.requests.filter {
            $0.method == "POST" && $0.path.hasPrefix("/api/component-capabilities/") && $0.body["method"].stringValue == method
        }
    }
    var capabilityCalls: Int { transport.requests.filter { $0.method == "POST" && $0.path.hasPrefix("/api/component-capabilities/") }.count }
    var deletes: Int { transport.requests.filter { $0.method == "DELETE" }.count }
    var sourceReads: [AppContractRequest] { transport.requests.filter { $0.method == "GET" && $0.path.hasPrefix("/api/components/") } }

    static func token(_ number: Int) -> String { "tok-" + String(format: "%060d", number) }

    static func component(id: String, name: String = "calc", enabled: Bool = true, active: Int = 2, versions: Int = 3) -> JSONValue {
        ["id": .string(id), "ownerUserId": "local-user", "workspaceId": "workspace-1", "name": .string(name),
         "description": "Calculator", "enabled": .bool(enabled), "activeVersion": .number(Double(active)),
         "libraryRevision": 4, "revocationEpoch": 1, "deletedAt": .null, "versions": .number(Double(versions)),
         "createdAt": 1, "updatedAt": 2]
    }

    static func code(_ version: Int) -> String { "root.textContent='v\(version)';" }

    private func respond(_ request: AppContractRequest) -> AppContractResponse {
        lock.lock()
        if request.method == "POST" && request.path == "/api/component-capabilities" { state.mints += 1 }
        let current = state
        lock.unlock()
        if request.method == "DELETE" { return .json(.null, status: 200) }
        if request.method == "GET" && request.path == "/api/workspaces/workspace-1/components" {
            let own = Self.component(id: current.componentID, enabled: current.enabled, active: current.activeVersion, versions: current.versions)
            return .json(["revision": 4, "items": .array([own] + current.extraItems)])
        }
        let sourcePrefix = "/api/components/"
        if request.method == "GET" && request.path.hasPrefix(sourcePrefix) {
            // URL.path is percent-decoded to the exact UTF-8 bytes that were sent.
            let id = String(request.path.dropFirst(sourcePrefix.count))
            guard let number = Int(request.query["version"] ?? ""), request.query["workspaceId"] == "workspace-1" else {
                return .json(["error": ["code": "not_found", "message": "not found"]], status: 404)
            }
            return .json(["componentId": .string(id), "version": .number(Double(number)), "code": .string(Self.code(number)),
                          "propsSchema": .null, "source": ["kind": "user"], "createdAt": 2])
        }
        if request.method == "POST" && request.path == "/api/component-capabilities" {
            if let response = current.mintResponse { return response }
            let number = current.mints
            let props = number <= current.grants.count ? current.grants[number - 1] : (current.grantedProps ?? request.body["props"])
            return .json(["capability": .string(Self.token(number)),
                          "expiresAt": .number(Date().timeIntervalSince1970 * 1000 + current.expiresIn * 1000),
                          "componentId": request.body["componentId"], "version": request.body["version"],
                          "host": request.body["host"], "props": props], status: 201)
        }
        if request.method == "POST" && request.path.hasPrefix("/api/component-capabilities/") {
            let args = request.body["args"].arrayValue
            switch request.body["method"].stringValue {
            case "write.rows": return current.write
            case "navigate.page":
                return .delayedJSON(["result": ["pageId": args.first ?? .null]], status: 200, delay: current.navigateDelay)
            case "ask.draft": return .json(["result": ["accepted": true]])
            case "read.host": return .delayedJSON(["result": current.hostData], status: 200, delay: current.readHostDelay)
            case "read.database":
                return .delayedJSON(["result": ["id": request.body["resourceId"], "rows": []]], status: 200, delay: current.readDatabaseDelay)
            default: return .json(["result": .null])
            }
        }
        return .json(["error": ["code": "not_found", "message": "Unexpected request"]], status: 404)
    }
}

/// Drives one outer document the way the WebKit coordinator does: binds a
/// document nonce, completes the handshake and talks only on its channel.
@MainActor private final class Runner {
    let model: NativeComponentRuntimeModel
    let channel: String
    let document = ComponentSandbox.makeDocumentNonce()
    private var received: [JSONValue] = []

    init?(_ model: NativeComponentRuntimeModel, render: Bool = true) {
        guard let channel = model.sandboxChannel(loaded: nil) else { return nil }
        self.model = model
        self.channel = channel
        send(["type": "michi-component:wrapper-load"])
        send(["type": "michi-component:wrapper-ready", "channel": .string(channel)])
        if render { send(["type": "michi-component:rendered", "channel": .string(channel)]) }
    }

    func send(_ value: JSONValue) { model.handleSandboxMessage(value, channel: channel, document: document) }

    func call(_ id: Int, _ method: String, _ args: JSONValue = []) {
        send(["type": "michi-component:call", "channel": .string(channel), "id": .number(Double(id)),
              "method": .string(method), "args": args])
    }

    /// Everything native has queued for this channel so far.
    func pull() -> [JSONValue] {
        received += model.drainOutbox(channel: channel)
        return received
    }

    func count(_ type: String) -> Int { pull().filter { $0["type"].stringValue == type }.count }
    func messages(_ type: String) -> [JSONValue] { pull().filter { $0["type"].stringValue == type } }
    func results(_ id: Int) -> [JSONValue] {
        pull().filter { $0["type"].stringValue == "michi-component:result" && $0["id"] == .number(Double(id)) }
    }
    func result(_ id: Int) -> JSONValue? { results(id).last }
}

@MainActor final class NativeComponentRuntimeTests: XCTestCase {
    private let pageHost: JSONValue = ["kind": "page_block", "pageId": "page-1", "blockId": "block-1"]
    private let viewHost: JSONValue = ["kind": "database_view", "databaseId": "db-1", "viewId": "view-1"]
    private let otherViewHost: JSONValue = ["kind": "database_view", "databaseId": "db-1", "viewId": "view-2"]
    private let writeArgs: JSONValue = [[["op": "row.update", "id": "r1", "done": true]]]

    private func timing(refresh: TimeInterval = 30, call: TimeInterval = 2, firstRender: TimeInterval = 5,
                        renewLead: TimeInterval = 20) -> NativeComponentRuntimeTiming {
        NativeComponentRuntimeTiming(refresh: refresh, call: call, firstRender: firstRender, previewDebounce: 0.05,
                                     capability: NativeComponentCapabilityTiming(retry: 0.3, minimumRetry: 0.1, renewLead: renewLead))
    }

    private func guards() -> NativeComponentWriteGuardStore {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("michi-component-guards-\(UUID().uuidString)", isDirectory: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        return NativeComponentWriteGuardStore(directory: directory)
    }

    /// Close is registered first so teardown runs it last, after every drain.
    private func closing(_ backend: ComponentBackend) {
        addTeardownBlock { backend.transport.close() }
    }

    private func draining(_ model: NativeComponentRuntimeModel) {
        addTeardownBlock { await model.shutdown() }
    }

    private func makeModel(_ backend: ComponentBackend, host: JSONValue? = nil, componentID: String = "pc-1",
                           pinnedVersion: Int? = 2, props: JSONValue = [:], data: JSONValue = ["rows": []],
                           bindingKey: JSONValue = .null, readOnly: Bool = false,
                           timing: NativeComponentRuntimeTiming? = nil,
                           guards: NativeComponentWriteGuardStore? = nil) -> NativeComponentRuntimeModel {
        let model = NativeComponentRuntimeModel(
            api: backend.transport.api, workspaceID: "workspace-1", host: host ?? viewHost, componentID: componentID,
            pinnedVersion: pinnedVersion, props: props, data: data, bindingKey: bindingKey, readOnly: readOnly,
            timing: timing ?? self.timing(), writeGuards: guards ?? self.guards()
        )
        draining(model)
        return model
    }

    /// Polls `condition` on the main actor until it holds or `timeout` passes.
    @discardableResult
    private func eventually(_ what: String, timeout: TimeInterval = 4, file: StaticString = #filePath, line: UInt = #line,
                            _ condition: () -> Bool) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition() {
            guard Date() < deadline else {
                XCTFail("Timed out waiting for \(what)", file: file, line: line)
                return false
            }
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
        return true
    }

    /// A non-retained worker, optionally one other than `excluding`.
    @discardableResult
    private func running(_ model: NativeComponentRuntimeModel, excluding channel: String? = nil,
                         file: StaticString = #filePath, line: UInt = #line) async -> Bool {
        await eventually("a running worker", file: file, line: line) {
            guard let session = model.session, !session.isRetained else { return false }
            return channel.map { !ComponentSandbox.sameID($0, session.channel) } ?? true
        }
    }

    /// Only for "never happens" checks: waits past a known delayed reply.
    private func settle(_ seconds: TimeInterval) async {
        try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
    }

    private func sessionCall(_ session: NativeComponentSandboxSession, id: Int, _ method: String, _ args: JSONValue) -> JSONValue {
        ["type": "michi-component:call", "channel": .string(session.channel), "id": .number(Double(id)),
         "method": .string(method), "args": args]
    }

    private func connectedSession(preview: Bool = false, render: Bool, document: String = "doc-a") -> NativeComponentSandboxSession {
        var session = NativeComponentSandboxSession.start(generation: 1, preview: preview, hasCapability: true, code: "x",
            props: [:], data: [:], theme: [:], height: nil,
            minHeight: preview ? ComponentSandbox.previewHeightMin : ComponentSandbox.heightMin,
            maxHeight: preview ? ComponentSandbox.previewHeightMax : ComponentSandbox.heightMax)
        XCTAssertEqual(session.acceptIncoming(["type": "michi-component:wrapper-load"], document: document), .wrapperInit)
        XCTAssertEqual(session.acceptIncoming(["type": "michi-component:wrapper-ready", "channel": .string(session.channel)], document: document), .load)
        if render {
            XCTAssertEqual(session.acceptIncoming(["type": "michi-component:rendered", "channel": .string(session.channel)], document: document), .rendered)
        }
        return session
    }

    // MARK: Pure rules

    func testResolvedVersionUsesPinOrActiveAndRejectsZero() {
        let component = ComponentBackend.component(id: "pc-1")
        XCTAssertEqual(NativeComponentRuntimeModel.resolvedVersion(component: component, pinnedVersion: 1), 1)
        XCTAssertEqual(NativeComponentRuntimeModel.resolvedVersion(component: component, pinnedVersion: nil), 2)
        XCTAssertNil(NativeComponentRuntimeModel.resolvedVersion(component: component, pinnedVersion: 0))
    }

    func testPageDatabaseIDsAreExactBytesUniqueAndBounded() {
        let many = (0..<40).map { JSONValue.string("db-\($0)") }
        let props: JSONValue = ["databaseId": "db-1",
                                "databaseIds": .array(["db-1", "\u{E9}", "e\u{301}", "", 5] + many)]
        let ids = NativeComponentRuntimeModel.pageDatabaseIDs(props)
        XCTAssertEqual(ids.count, 20)
        XCTAssertTrue(ComponentSandbox.sameID(ids[0], "db-1"))
        XCTAssertTrue(ComponentSandbox.sameID(ids[1], "\u{E9}"))
        XCTAssertTrue(ComponentSandbox.sameID(ids[2], "e\u{301}"), "canonically equivalent IDs stay distinct")
        XCTAssertTrue(ComponentSandbox.sameID(ids[3], "db-0"))
        XCTAssertEqual(NativeComponentRuntimeModel.pageDatabaseIDs(["title": "none"]), [])
    }

    // MARK: Session rules

    func testSessionResizeClampsAnyMagnitudeWithoutTrapping() {
        var session = connectedSession(render: true)
        XCTAssertEqual(session.acceptIncoming(sessionCall(session, id: 1, "resize", .array([.number(1e300)])), document: "doc-a"),
                       .resize(ComponentSandbox.heightMax, id: 1))
        XCTAssertEqual(session.acceptIncoming(sessionCall(session, id: 2, "resize", .array([.number(-1e300)])), document: "doc-a"),
                       .resize(ComponentSandbox.heightMin, id: 2))
        XCTAssertEqual(session.acceptIncoming(sessionCall(session, id: 3, "resize", .array([.number(1e19)])), document: "doc-a"),
                       .resize(ComponentSandbox.heightMax, id: 3))
        XCTAssertEqual(session.acceptIncoming(sessionCall(session, id: 4, "resize", ["tall"]), document: "doc-a"),
                       .reply(id: 4, ok: false, value: nil, error: "Height must be a number"))
        XCTAssertEqual(session.acceptIncoming(sessionCall(session, id: 5, "resize", [1, 2]), document: "doc-a"),
                       .reply(id: 5, ok: false, value: nil, error: "Height must be a number"))
        XCTAssertEqual(session.acceptIncoming(sessionCall(session, id: 6, "resize", .array([.number(.nan)])), document: "doc-a"), .ignore,
                       "a non-encodable number never parses as a call")

        var preview = connectedSession(preview: true, render: true)
        XCTAssertFalse(preview.hasCapability)
        XCTAssertEqual(preview.data, ComponentSandbox.previewData)
        XCTAssertEqual(preview.acceptIncoming(sessionCall(preview, id: 1, "resize", .array([.number(1e300)])), document: "doc-a"),
                       .resize(ComponentSandbox.previewHeightMax, id: 1))
    }

    func testSessionBindsToItsFirstDocumentAndStopsWhenThatDocumentReloads() {
        var session = NativeComponentSandboxSession.start(generation: 1, preview: false, hasCapability: true, code: "x",
            props: [:], data: [:], theme: [:], height: nil)
        let ready: JSONValue = ["type": "michi-component:wrapper-ready", "channel": .string(session.channel)]
        XCTAssertEqual(session.acceptIncoming(ready, document: "doc-a"), .ignore, "nothing is accepted before a document binds")
        XCTAssertEqual(session.acceptIncoming(["type": "michi-component:wrapper-load"], document: ""), .ignore)
        XCTAssertEqual(session.acceptIncoming(["type": "michi-component:wrapper-load"], document: "doc-a"), .wrapperInit)
        XCTAssertEqual(session.acceptIncoming(["type": "michi-component:wrapper-load"], document: "doc-b"), .ignore)
        XCTAssertEqual(session.acceptIncoming(ready, document: "doc-b"), .ignore, "another document cannot complete the handshake")
        XCTAssertEqual(session.acceptIncoming(["type": "michi-component:wrapper-ready", "channel": .string(ComponentSandbox.makeChannel())],
                                              document: "doc-a"), .ignore)
        XCTAssertEqual(session.acceptIncoming(ready, document: "doc-a"), .load)
        XCTAssertEqual(session.acceptIncoming(["type": "michi-component:wrapper-load"], document: "doc-a"),
                       .stop("The component sandbox document changed. It has been stopped for safety."))
        XCTAssertTrue(session.isRetained)
        XCTAssertEqual(session.acceptIncoming(sessionCall(session, id: 1, "read.host", []), document: "doc-a"), .ignore)
    }

    func testCandidateRefusesSideEffectsUntilRenderedAndFailsClosed() {
        var candidate = connectedSession(render: false)
        let sideEffects: [(Int, String, JSONValue)] = [(1, "write.rows", [[]]), (2, "navigate.page", ["page-9"]), (3, "ask.draft", ["fix"])]
        for (id, method, args) in sideEffects {
            XCTAssertEqual(candidate.acceptIncoming(sessionCall(candidate, id: id, method, args), document: "doc-a"),
                           .reply(id: id, ok: false, value: nil, error: "This component update is not active"), method)
        }
        XCTAssertEqual(candidate.acceptIncoming(sessionCall(candidate, id: 4, "read.host", []), document: "doc-a"),
                       .hostCall(id: 4, method: "read.host", args: []))
        XCTAssertFalse(candidate.canSideEffect)
        XCTAssertEqual(candidate.acceptIncoming(["type": "michi-component:error", "channel": .string(candidate.channel), "message": "boom"],
                                                document: "doc-a"), .fail("boom"))
        XCTAssertTrue(candidate.isRetained, "a candidate that fails before rendering never runs")
        XCTAssertFalse(candidate.finishCall(id: 4))
        XCTAssertEqual(candidate.acceptIncoming(["type": "michi-component:rendered", "channel": .string(candidate.channel)], document: "doc-a"), .ignore)

        var active = connectedSession(render: true)
        XCTAssertTrue(active.canSideEffect)
        XCTAssertEqual(active.acceptIncoming(["type": "michi-component:error", "channel": .string(active.channel), "message": "oops"],
                                             document: "doc-a"), .fail("oops"))
        XCTAssertFalse(active.isRetained, "a rendered worker keeps running after reporting an error")

        var late = connectedSession(render: false)
        XCTAssertEqual(late.firstRenderTimedOut(), .timeout)
        XCTAssertTrue(late.isRetained)
        XCTAssertFalse(late.canSideEffect)
        var rendered = connectedSession(render: true)
        XCTAssertEqual(rendered.firstRenderTimedOut(), .ignore)
    }

    func testSessionIDsInFlightAndRateLimitsFreeSlotsOnlyOnce() {
        var session = connectedSession(render: true)
        let now = Date()
        for id in 1...8 {
            XCTAssertEqual(session.acceptIncoming(sessionCall(session, id: id, "read.host", []), document: "doc-a", now: now),
                           .hostCall(id: id, method: "read.host", args: []))
        }
        XCTAssertEqual(session.acceptIncoming(sessionCall(session, id: 1, "read.host", []), document: "doc-a", now: now),
                       .reply(id: 1, ok: false, value: nil, error: "A component request with this id is still pending"))
        XCTAssertEqual(session.acceptIncoming(sessionCall(session, id: 9, "read.host", []), document: "doc-a", now: now),
                       .reply(id: 9, ok: false, value: nil, error: "Too many component requests are still pending"))
        XCTAssertTrue(session.finishCall(id: 1))
        XCTAssertFalse(session.finishCall(id: 1), "a slot is freed exactly once")
        XCTAssertEqual(session.pending, 7)
        XCTAssertEqual(session.acceptIncoming(sessionCall(session, id: 9, "read.host", []), document: "doc-a", now: now),
                       .hostCall(id: 9, method: "read.host", args: []))

        var limited = connectedSession(render: true)
        for id in 1...ComponentSandbox.hostCallsPerSecond {
            XCTAssertEqual(limited.acceptIncoming(sessionCall(limited, id: id, "resize", [200]), document: "doc-a", now: now), .resize(200, id: id))
        }
        XCTAssertEqual(limited.acceptIncoming(sessionCall(limited, id: 99, "resize", [200]), document: "doc-a", now: now),
                       .reply(id: 99, ok: false, value: nil, error: "Too many component requests. Try again shortly."))
        XCTAssertEqual(limited.acceptIncoming(sessionCall(limited, id: 100, "resize", [200]), document: "doc-a",
                                              now: now.addingTimeInterval(1.1)), .resize(200, id: 100))
        limited.retain()
        XCTAssertFalse(limited.finishCall(id: 100))
    }

    // MARK: Preview

    func testPreviewRunsDraftEditsWithoutAnyServerRequest() async throws {
        let backend = ComponentBackend()
        closing(backend)
        let model = NativeComponentRuntimeModel(api: backend.transport.api, workspaceID: "workspace-1", host: .null,
            componentID: "pc-1", pinnedVersion: 2, props: ["n": 1], data: [:], preview: true,
            timing: timing(), writeGuards: guards())
        draining(model)
        model.installPreviewSource(name: "calc", code: "root.textContent='a';", version: 2)
        XCTAssertNil(model.session, "nothing runs before the preview is visible")
        model.appear()
        let first = try XCTUnwrap(model.session)
        XCTAssertEqual(first.data, ComponentSandbox.previewData)
        XCTAssertFalse(first.hasCapability)
        let runner = try XCTUnwrap(Runner(model))
        runner.call(1, "read.host")
        runner.call(2, "write.rows", writeArgs)
        XCTAssertEqual(runner.result(1)?["error"], "This capability is unavailable")
        XCTAssertEqual(runner.result(2)?["error"], "This capability is unavailable")

        model.updatePreviewSource(name: "calc", code: "root.textContent='b';", version: 2)
        model.updatePreviewSource(name: "calc", code: "root.textContent='c';", version: 2)
        await eventually("the debounced draft runs") { model.session?.code == "root.textContent='c';" && model.session?.isRetained == false }
        let edited = try XCTUnwrap(model.session)
        XCTAssertNotEqual(edited.channel, runner.channel)
        XCTAssertGreaterThanOrEqual(runner.count("michi-component:freeze"), 1)

        model.installPreviewSource(name: "calc", code: "root.textContent='c';", version: 2)
        XCTAssertEqual(model.session?.channel, edited.channel, "unchanged source keeps the worker")
        model.applyHost(host: .null, componentID: "pc-1", pinnedVersion: 2, props: ["n": 2], data: [:], readOnly: false)
        XCTAssertEqual(model.session?.channel, edited.channel)
        XCTAssertEqual(model.session?.props, ["n": 2])

        model.disappear()
        XCTAssertEqual(model.session?.isRetained, true)
        model.appear()
        await running(model, excluding: edited.channel)
        XCTAssertTrue(backend.transport.requests.isEmpty, "preview reads no source and mints nothing")
        XCTAssertNil(model.capability.token)
    }

    // MARK: Live hosts

    func testDatabaseHostRunsPinnedSourceWithExactlyTheGrantedProps() async throws {
        let backend = ComponentBackend()
        backend.update { $0.grantedProps = [:] }
        closing(backend)
        let model = makeModel(backend, props: ["title": "Caller"])
        model.appear()
        await running(model)
        XCTAssertEqual(model.version, 2)
        XCTAssertEqual(backend.sourceReads.first?.query["version"], "2")
        XCTAssertEqual(backend.mintBodies.first?["props"], ["title": "Caller"])
        XCTAssertEqual(model.grantedProps, .object([:]))
        XCTAssertEqual(model.session?.props, .object([:]), "an empty grant is never replaced by caller props")
        let runner = try XCTUnwrap(Runner(model))
        let load = try XCTUnwrap(runner.messages("michi-component:load").first)
        XCTAssertEqual(load["props"], .object([:]))
        XCTAssertEqual(load["data"], ["rows": []])
        XCTAssertEqual(load["code"], .string(ComponentBackend.code(2)))
        XCTAssertEqual(runner.count("michi-component:wrapper-init"), 1)
        XCTAssertEqual(model.session?.canSideEffect, true)
        XCTAssertEqual(model.presentedVersion, 2)
    }

    func testPageHostWaitsForCapabilityDataAndIgnoresCallerData() async throws {
        let backend = ComponentBackend()
        backend.update {
            $0.grantedProps = ["databaseId": "db-1", "databaseIds": ["db-1", "db-2"]]
            $0.readDatabaseDelay = 0.3
        }
        closing(backend)
        let model = makeModel(backend, host: pageHost, props: ["databaseId": "db-1"], data: ["ignored": true])
        model.appear()
        await eventually("the first database read") { backend.calls("read.database").count == 1 }
        XCTAssertNil(model.session, "no worker starts before the host data has been read")
        await running(model)
        XCTAssertEqual(backend.calls("read.host").count, 1)
        XCTAssertEqual(backend.calls("read.database").map { $0.body["resourceId"] }, ["db-1", "db-2"])
        let data = try XCTUnwrap(model.session?.data)
        XCTAssertEqual(data["page"]["title"], "Plan")
        XCTAssertEqual(data["databases"]["db-1"]["id"], "db-1")
        XCTAssertEqual(data["databases"]["db-2"]["id"], "db-2")
        XCTAssertNil(data.objectValue["ignored"], "page data comes only from the capability")

        let runner = try XCTUnwrap(Runner(model))
        XCTAssertEqual(runner.count("michi-component:load"), 1)
        runner.call(1, "write.rows", writeArgs)
        XCTAssertEqual(runner.result(1)?["error"], .string(NativeComponentCapabilityError.pageWrite.errorDescription!))
        XCTAssertTrue(backend.calls("write.rows").isEmpty)

        backend.update { $0.readDatabaseDelay = 0 }
        model.pageChanged()
        await eventually("an unchanged page refresh") { backend.calls("read.host").count == 2 && backend.calls("read.database").count == 4 }
        await settle(0.3)
        XCTAssertEqual(runner.count("michi-component:update"), 0, "identical data is not posted again")

        backend.update { $0.hostData = ["page": ["id": "page-1", "title": "Renamed"]] }
        model.pageChanged()
        await eventually("changed page data reaches the worker") { runner.count("michi-component:update") == 1 }
        XCTAssertEqual(runner.messages("michi-component:update").first?["data"]["page"]["title"], "Renamed")
        XCTAssertEqual(runner.count("michi-component:load"), 1)
        XCTAssertEqual(model.session?.channel, runner.channel)
    }

    func testSameGrantRenewalNeverReloadsAndKeepsResultsDeliverable() async throws {
        let backend = ComponentBackend()
        backend.update { $0.expiresIn = 1.3; $0.navigateDelay = 0.5 }
        closing(backend)
        var pages: [String] = []
        let model = makeModel(backend, timing: timing(renewLead: 1))
        model.updateHandlers(navigate: { pages.append($0) }, draft: nil, databaseChanged: nil)
        model.appear()
        await running(model)
        let runner = try XCTUnwrap(Runner(model))
        runner.call(1, "navigate.page", ["page-9"])
        await eventually("two renewals") { backend.mints >= 3 }
        await eventually("the navigation across a renewal") { pages == ["page-9"] }
        XCTAssertEqual(model.session?.channel, runner.channel)
        XCTAssertEqual(model.session?.canSideEffect, true)
        XCTAssertEqual(runner.count("michi-component:wrapper-init"), 1)
        XCTAssertEqual(runner.count("michi-component:load"), 1)
        XCTAssertEqual(runner.count("michi-component:update"), 0)
        XCTAssertEqual(runner.result(1)?["ok"], true)
        XCTAssertNotEqual(model.capability.token?.capability, ComponentBackend.token(1))
        await eventually("replaced tokens are revoked") { backend.deletes >= 2 }
    }

    func testPropsAndBindingChangesRemintAndUpdateWithoutReload() async throws {
        let backend = ComponentBackend()
        closing(backend)
        let model = makeModel(backend, props: ["n": 1], bindingKey: [1, 0])
        model.appear()
        await running(model)
        let runner = try XCTUnwrap(Runner(model))

        model.applyHost(host: viewHost, componentID: "pc-1", pinnedVersion: 2, props: ["n": 2], data: ["rows": []],
                        bindingKey: [1, 0], readOnly: false)
        await eventually("the new grant reaches the worker") { runner.count("michi-component:update") == 1 }
        XCTAssertEqual(backend.mintBodies.count, 2)
        XCTAssertEqual(backend.mintBodies.last?["props"], ["n": 2])
        XCTAssertEqual(runner.messages("michi-component:update").first?["props"], ["n": 2])

        model.applyHost(host: viewHost, componentID: "pc-1", pinnedVersion: 2, props: ["n": 2], data: ["rows": []],
                        bindingKey: [2, 0], readOnly: false)
        await eventually("a binding change re-mints") { backend.mints == 3 && model.session?.hasCapability == true }
        XCTAssertEqual(runner.count("michi-component:update"), 1, "the same granted props are not posted again")

        model.applyHost(host: viewHost, componentID: "pc-1", pinnedVersion: 2, props: ["n": 2], data: ["rows": [["id": "r1"]]],
                        bindingKey: [2, 0], readOnly: false)
        XCTAssertEqual(runner.count("michi-component:update"), 2)
        XCTAssertEqual(runner.messages("michi-component:update").last?["data"], ["rows": [["id": "r1"]]])
        XCTAssertEqual(backend.mints, 3, "a data change alone does not re-mint")
        XCTAssertEqual(runner.count("michi-component:load"), 1)
        XCTAssertEqual(model.session?.channel, runner.channel)
    }

    func testHostChangeRetiresTheWorkerAndDropsItsLateNavigation() async throws {
        let backend = ComponentBackend()
        backend.update { $0.navigateDelay = 0.3 }
        closing(backend)
        var pages: [String] = []
        let model = makeModel(backend)
        model.updateHandlers(navigate: { pages.append($0) }, draft: nil, databaseChanged: nil)
        model.appear()
        await running(model)
        let runner = try XCTUnwrap(Runner(model))
        runner.call(1, "navigate.page", ["page-9"])
        await eventually("the navigation request") { backend.calls("navigate.page").count == 1 }

        model.applyHost(host: otherViewHost, componentID: "pc-1", pinnedVersion: 2, props: [:], data: ["rows": []], readOnly: false)
        XCTAssertNil(model.session, "the old worker is gone before anything else runs")
        XCTAssertNil(model.capability.token)
        await running(model, excluding: runner.channel)
        XCTAssertEqual(backend.mintBodies.last?["host"], otherViewHost)
        await settle(0.5)
        XCTAssertEqual(pages, [])
        XCTAssertTrue(runner.results(1).isEmpty, "a retired worker gets no reply")
        runner.call(2, "navigate.page", ["page-8"])
        XCTAssertEqual(backend.calls("navigate.page").count, 1)
    }

    func testPinChangeRunsTheNewVersionInANewWorker() async throws {
        let backend = ComponentBackend()
        closing(backend)
        let model = makeModel(backend)
        model.appear()
        await running(model)
        let runner = try XCTUnwrap(Runner(model))
        model.applyHost(host: viewHost, componentID: "pc-1", pinnedVersion: 3, props: [:], data: ["rows": []], readOnly: false)
        await running(model, excluding: runner.channel)
        XCTAssertEqual(model.version, 3)
        XCTAssertEqual(model.session?.code, ComponentBackend.code(3))
        XCTAssertEqual(backend.sourceReads.last?.query["version"], "3")
        XCTAssertEqual(backend.mintBodies.last?["version"], 3)
    }

    func testBackgroundAndDisappearDropLateResultsAndStartFreshWorkers() async throws {
        let backend = ComponentBackend()
        backend.update { $0.navigateDelay = 0.3 }
        closing(backend)
        var pages: [String] = []
        let model = makeModel(backend)
        model.updateHandlers(navigate: { pages.append($0) }, draft: nil, databaseChanged: nil)
        model.appear()
        await running(model)
        let runner = try XCTUnwrap(Runner(model))
        runner.call(1, "navigate.page", ["page-9"])
        await eventually("the navigation request") { backend.calls("navigate.page").count == 1 }

        model.enterBackground()
        XCTAssertEqual(model.session?.isRetained, true)
        XCTAssertNil(model.capability.token)
        await eventually("the background revocation") { backend.deletes == 1 }
        await settle(0.5)
        XCTAssertEqual(pages, [])
        XCTAssertTrue(runner.results(1).isEmpty)

        model.enterForeground()
        await running(model, excluding: runner.channel)
        XCTAssertEqual(backend.mints, 2)
        let foreground = try XCTUnwrap(model.session?.channel)

        model.disappear()
        XCTAssertEqual(model.session?.isRetained, true)
        XCTAssertNil(model.capability.token)
        model.appear()
        await running(model, excluding: foreground)
        XCTAssertEqual(backend.mints, 3)
        XCTAssertEqual(pages, [])
    }

    func testStopThenRestartRunsAFreshWorkerWithAFreshGrant() async throws {
        let backend = ComponentBackend()
        closing(backend)
        let model = makeModel(backend)
        model.appear()
        await running(model)
        let runner = try XCTUnwrap(Runner(model))
        model.stop()
        XCTAssertTrue(model.stopped)
        XCTAssertEqual(model.session?.isRetained, true)
        XCTAssertNil(model.capability.token)
        XCTAssertEqual(model.notice, "This component was stopped. Use Restart to run it again.")
        runner.call(1, "read.host")
        XCTAssertTrue(backend.calls("read.host").isEmpty)

        model.restart()
        XCTAssertFalse(model.stopped)
        await running(model, excluding: runner.channel)
        XCTAssertEqual(backend.mints, 2)
        let second = try XCTUnwrap(Runner(model))
        XCTAssertEqual(second.count("michi-component:load"), 1)
        XCTAssertEqual(model.session?.canSideEffect, true)
    }

    func testReadOnlyPausesWithoutRequestsAndWritableResumes() async throws {
        let backend = ComponentBackend()
        closing(backend)
        let model = makeModel(backend, readOnly: true)
        model.appear()
        XCTAssertEqual(model.error, NativeComponentRuntimeModel.readOnlyMessage)
        XCTAssertNil(model.session)
        XCTAssertTrue(backend.transport.requests.isEmpty)

        model.applyHost(host: viewHost, componentID: "pc-1", pinnedVersion: 2, props: [:], data: ["rows": []], readOnly: false)
        XCTAssertNil(model.error)
        await running(model)
        let first = try XCTUnwrap(model.session?.channel)

        model.applyHost(host: viewHost, componentID: "pc-1", pinnedVersion: 2, props: [:], data: ["rows": []], readOnly: true)
        XCTAssertEqual(model.session?.isRetained, true)
        XCTAssertNil(model.capability.token)
        XCTAssertEqual(model.error, NativeComponentRuntimeModel.readOnlyMessage)

        model.applyHost(host: viewHost, componentID: "pc-1", pinnedVersion: 2, props: [:], data: ["rows": []], readOnly: false)
        await running(model, excluding: first)
        XCTAssertEqual(backend.mints, 2)
        XCTAssertNil(model.error)
    }

    func testDisabledSourcePausesAndReenabledSourceResumes() async throws {
        let backend = ComponentBackend()
        backend.update { $0.enabled = false }
        closing(backend)
        let disabled = NativeComponentCapabilityError.disabled.errorDescription
        let model = makeModel(backend, timing: timing(refresh: 0.2))
        model.appear()
        await eventually("the disabled state") { model.error == disabled }
        XCTAssertNil(model.session)
        XCTAssertEqual(backend.mints, 0)

        backend.update { $0.enabled = true }
        await running(model)
        XCTAssertNil(model.error)
        XCTAssertEqual(backend.mints, 1)
        let first = try XCTUnwrap(model.session?.channel)

        backend.update { $0.enabled = false }
        await eventually("disabling stops the running worker") { model.session?.isRetained == true && model.error == disabled }
        XCTAssertNil(model.capability.token)
        backend.update { $0.enabled = true }
        await running(model, excluding: first)
        XCTAssertEqual(backend.mints, 2)
    }

    func testFirstRenderDeadlineAndStartupFailureStopTheHost() async throws {
        let backend = ComponentBackend()
        closing(backend)
        let model = makeModel(backend, timing: timing(firstRender: 0.3))
        model.appear()
        await running(model)
        let runner = try XCTUnwrap(Runner(model, render: false))
        await eventually("the first-render deadline") { model.stopped }
        XCTAssertTrue(model.error?.hasPrefix("The component did not render within") == true)
        XCTAssertEqual(model.session?.isRetained, true)
        XCTAssertNil(model.capability.token)
        XCTAssertGreaterThanOrEqual(runner.count("michi-component:freeze"), 1)
        runner.send(["type": "michi-component:rendered", "channel": .string(runner.channel)])
        XCTAssertTrue(model.stopped, "a late render does not revive the worker")

        model.restart()
        await running(model, excluding: runner.channel)
        let failing = try XCTUnwrap(Runner(model, render: false))
        failing.send(["type": "michi-component:error", "channel": .string(failing.channel), "message": "SyntaxError"])
        XCTAssertTrue(model.stopped)
        XCTAssertEqual(model.error, "The component could not start: SyntaxError")
        XCTAssertEqual(model.session?.isRetained, true)
    }

    func testDocumentReloadAndRecreatedWebViewNeverContinueAWorker() async throws {
        let backend = ComponentBackend()
        closing(backend)
        let model = makeModel(backend)
        model.appear()
        await running(model)
        let runner = try XCTUnwrap(Runner(model))
        XCTAssertEqual(model.sandboxChannel(loaded: runner.channel), runner.channel)

        let replacement = try XCTUnwrap(model.sandboxChannel(loaded: nil), "a recreated web view gets a new worker")
        XCTAssertNotEqual(replacement, runner.channel)
        runner.call(1, "read.host")
        XCTAssertTrue(backend.calls("read.host").isEmpty, "the old document's channel is dead")

        let current = try XCTUnwrap(Runner(model))
        XCTAssertEqual(current.channel, replacement)
        current.send(["type": "michi-component:wrapper-load"])
        XCTAssertTrue(model.stopped)
        XCTAssertEqual(model.error, "The component sandbox document changed. It has been stopped for safety.")
    }

    // MARK: Side effects

    func testMissingCallbacksAndCandidateStateRefuseLocallyWithoutHTTP() async throws {
        let backend = ComponentBackend()
        closing(backend)
        let model = makeModel(backend)
        model.appear()
        await running(model)
        let candidate = try XCTUnwrap(Runner(model, render: false))
        candidate.call(1, "navigate.page", ["page-9"])
        XCTAssertEqual(candidate.result(1)?["error"], "This component update is not active")
        candidate.send(["type": "michi-component:rendered", "channel": .string(candidate.channel)])

        candidate.call(2, "navigate.page", ["page-9"])
        candidate.call(3, "ask.draft", ["please fix"])
        XCTAssertEqual(candidate.result(2)?["error"], "Navigation is unavailable here")
        XCTAssertEqual(candidate.result(3)?["error"], "Draft requests are unavailable here")
        XCTAssertEqual(backend.capabilityCalls, 0)
        XCTAssertEqual(model.session?.pending, 0)
    }

    func testNavigateAndDraftUseTheLatestCallbacksAfterAConfirmedResult() async throws {
        let backend = ComponentBackend()
        backend.update { $0.navigateDelay = 0.2 }
        closing(backend)
        var stale: [String] = [], pages: [String] = [], drafts: [String] = []
        let model = makeModel(backend)
        model.updateHandlers(navigate: { stale.append($0) }, draft: nil, databaseChanged: nil)
        model.appear()
        await running(model)
        let runner = try XCTUnwrap(Runner(model))
        runner.call(1, "navigate.page", ["page-9"])
        model.updateHandlers(navigate: { pages.append($0) }, draft: { drafts.append($0) }, databaseChanged: nil)
        await eventually("the navigation") { pages == ["page-9"] }
        XCTAssertEqual(stale, [])
        XCTAssertEqual(runner.result(1)?["ok"], true)
        runner.call(2, "ask.draft", ["please fix"])
        await eventually("the draft") { drafts == ["please fix"] }
        XCTAssertEqual(runner.result(2)?["ok"], true)
    }

    func testUnknownWriteOutcomesAreNeverResentAndBlockFurtherWrites() async throws {
        let outcomes: [(String, AppContractResponse)] = [
            ("no response", .failure(.timedOut)),
            ("connection lost", .failure(.networkConnectionLost)),
            ("server error", .json(["error": "Unavailable"], status: 503)),
            ("unreadable success", .json(["result": ["applied": "r1", "proposed": [], "rejected": []]])),
            ("missing result", .json(["ok": true])),
        ]
        for (label, response) in outcomes {
            let backend = ComponentBackend()
            backend.update { $0.write = response }
            closing(backend)
            var changes = 0
            let model = makeModel(backend)
            model.updateHandlers(navigate: nil, draft: nil, databaseChanged: { changes += 1 })
            model.appear()
            await running(model)
            let runner = try XCTUnwrap(Runner(model))
            runner.call(1, "write.rows", writeArgs)
            await eventually(label) { runner.result(1) != nil }
            XCTAssertEqual(runner.result(1)?["ok"], false, label)
            XCTAssertEqual(runner.result(1)?["error"], .string(NativeComponentRuntimeModel.unknownWriteReply), label)
            XCTAssertEqual(model.unconfirmedWrite, NativeComponentRuntimeModel.unconfirmedWriteMessage, label)
            XCTAssertEqual(changes, 0, label)
            runner.call(2, "write.rows", writeArgs)
            XCTAssertEqual(runner.result(2)?["error"], .string(NativeComponentRuntimeModel.blockedWriteMessage), label)
            XCTAssertEqual(backend.calls("write.rows").count, 1, "\(label): sent exactly once")
        }
    }

    func testRejectedWriteIsReportedWithoutBlockingLaterWrites() async throws {
        let backend = ComponentBackend()
        backend.update { $0.write = .json(["error": ["code": "invalid_request", "message": "Row r1 does not exist"]], status: 400) }
        closing(backend)
        let model = makeModel(backend)
        model.appear()
        await running(model)
        let runner = try XCTUnwrap(Runner(model))
        runner.call(1, "write.rows", writeArgs)
        await eventually("the rejection") { runner.result(1) != nil }
        XCTAssertEqual(runner.result(1)?["error"], "Row r1 does not exist")
        XCTAssertNil(model.unconfirmedWrite)
        backend.update { $0.write = ComponentBackend.applied }
        runner.call(2, "write.rows", writeArgs)
        await eventually("the next write") { runner.result(2) != nil }
        XCTAssertEqual(runner.result(2)?["ok"], true)
        XCTAssertEqual(backend.calls("write.rows").count, 2)
    }

    func testCallDeadlineFreesTheSlotAndALateWriteStaysUnconfirmedUntilAcknowledged() async throws {
        let backend = ComponentBackend()
        backend.update {
            $0.write = .delayedJSON(["result": ["applied": [["id": "r1"]], "proposed": [], "rejected": []]], status: 200, delay: 0.6)
        }
        closing(backend)
        let store = guards()
        var changes = 0
        let model = makeModel(backend, timing: timing(call: 0.2), guards: store)
        model.updateHandlers(navigate: nil, draft: nil, databaseChanged: { changes += 1 })
        model.appear()
        await running(model)
        let runner = try XCTUnwrap(Runner(model))
        runner.call(1, "write.rows", writeArgs)
        await eventually("the deadline reply") { runner.result(1) != nil }
        XCTAssertEqual(runner.result(1)?["error"], .string(NativeComponentRuntimeModel.timedOutReply))
        XCTAssertEqual(model.session?.pending, 0, "the deadline frees the slot")
        XCTAssertEqual(model.unconfirmedWrite, NativeComponentRuntimeModel.unconfirmedWriteMessage)
        await eventually("the late confirmation refreshes the original host") { changes == 1 }
        XCTAssertEqual(runner.results(1).count, 1, "the worker is answered once")
        XCTAssertEqual(model.unconfirmedWrite, NativeComponentRuntimeModel.unconfirmedWriteMessage, "a late answer never clears the guard")
        XCTAssertEqual(backend.calls("write.rows").count, 1)

        model.restart()
        await running(model, excluding: runner.channel)
        XCTAssertEqual(model.unconfirmedWrite, NativeComponentRuntimeModel.unconfirmedWriteMessage, "restart keeps the guard")
        XCTAssertEqual(makeModel(backend, guards: store).unconfirmedWrite, NativeComponentRuntimeModel.unconfirmedWriteMessage,
                       "a new host instance for the same scope is blocked")
        XCTAssertNil(makeModel(backend, host: otherViewHost, guards: store).unconfirmedWrite)

        let second = try XCTUnwrap(Runner(model))
        second.call(2, "write.rows", writeArgs)
        XCTAssertEqual(second.result(2)?["error"], .string(NativeComponentRuntimeModel.blockedWriteMessage))
        XCTAssertEqual(backend.calls("write.rows").count, 1)

        model.acknowledgeUnconfirmedWrite()
        XCTAssertNil(model.unconfirmedWrite)
        XCTAssertNil(makeModel(backend, guards: store).unconfirmedWrite)
        backend.update { $0.write = ComponentBackend.applied }
        second.call(3, "write.rows", writeArgs)
        await eventually("an acknowledged host writes again") { second.result(3) != nil }
        XCTAssertEqual(second.result(3)?["ok"], true)
        XCTAssertEqual(backend.calls("write.rows").count, 2)
        XCTAssertEqual(changes, 2)
    }

    func testAStaleDeadlineNeverExpiresALaterCallWithTheSameID() async throws {
        let backend = ComponentBackend()
        closing(backend)
        // Timeline: call A at 0 (answered at once, deadline 1.0); call B reuses
        // the id at 0.5, is answered at 1.3, and has its own deadline at 1.5.
        let model = makeModel(backend, timing: timing(call: 1.0))
        model.appear()
        await running(model)
        let runner = try XCTUnwrap(Runner(model))
        runner.call(1, "read.host")
        await eventually("the first answer") { runner.result(1) != nil }
        backend.update { $0.hostData = ["page": ["id": "page-1", "title": "Second"]]; $0.readHostDelay = 0.8 }
        await settle(0.5)
        runner.call(1, "read.host")
        await eventually("the reused id is answered", timeout: 3) { runner.results(1).count == 2 }
        XCTAssertEqual(runner.results(1).last?["ok"], true, "A's deadline must not time out B")
        XCTAssertEqual(runner.results(1).last?["value"]["page"]["title"], "Second")
        await settle(0.4)
        XCTAssertEqual(runner.results(1).count, 2, "each call is answered exactly once")
    }

    func testInFlightReopenSeesPendingMarkerAndDoesNotSubmitAnotherWrite() async throws {
        let backend = ComponentBackend()
        backend.update {
            $0.write = .delayedJSON(["result": ["applied": [["id": "r1"]], "proposed": [], "rejected": []]], status: 200, delay: 0.5)
        }
        closing(backend)
        let store = guards()
        let model = makeModel(backend, guards: store)
        model.appear()
        await running(model)
        let runner = try XCTUnwrap(Runner(model))
        runner.call(1, "write.rows", writeArgs)
        await eventually("the in-flight write") { backend.calls("write.rows").count == 1 }

        let other = makeModel(backend, guards: store)
        XCTAssertEqual(other.unconfirmedWrite, NativeComponentRuntimeModel.unconfirmedWriteMessage,
                       "reopening the same scope while a write is in flight must fail closed")
        other.appear()
        await running(other)
        let second = try XCTUnwrap(Runner(other))
        second.call(1, "write.rows", writeArgs)
        XCTAssertEqual(second.result(1)?["error"], .string(NativeComponentRuntimeModel.blockedWriteMessage))
        XCTAssertEqual(backend.calls("write.rows").count, 1, "the pending marker is not another write")
    }

    func testLateConfirmationDoesNotClearANewerWriteMarker() async throws {
        let backend = ComponentBackend()
        backend.update {
            $0.write = .delayedJSON(["result": ["applied": [["id": "r1"]], "proposed": [], "rejected": []]], status: 200, delay: 0.8)
        }
        closing(backend)
        let store = guards()
        let model = makeModel(backend, timing: timing(call: 0.2), guards: store)
        model.appear()
        await running(model)
        let runner = try XCTUnwrap(Runner(model))
        runner.call(1, "write.rows", writeArgs)
        await eventually("A timed out") { runner.result(1) != nil && model.unconfirmedWrite != nil }
        model.acknowledgeUnconfirmedWrite()
        XCTAssertNil(model.unconfirmedWrite)

        backend.update {
            $0.write = .delayedJSON(["result": ["applied": [["id": "r2"]], "proposed": [], "rejected": []]], status: 200, delay: 1.0)
        }
        runner.call(2, "write.rows", writeArgs)
        await eventually("B timed out") { runner.result(2) != nil }
        XCTAssertEqual(model.unconfirmedWrite, NativeComponentRuntimeModel.unconfirmedWriteMessage)
        XCTAssertEqual(backend.calls("write.rows").count, 2)

        await settle(0.8)
        XCTAssertEqual(model.unconfirmedWrite, NativeComponentRuntimeModel.unconfirmedWriteMessage,
                       "A's late confirmation must not clear B's newer marker")
        XCTAssertEqual(makeModel(backend, guards: store).unconfirmedWrite, NativeComponentRuntimeModel.unconfirmedWriteMessage)
        XCTAssertEqual(backend.calls("write.rows").count, 2)
    }

    func testConfirmedWriteAfterDisappearRefreshesAndClearsOnlyThatPendingMarker() async throws {
        let backend = ComponentBackend()
        backend.update {
            $0.write = .delayedJSON(["result": ["applied": [["id": "r1"]], "proposed": [], "rejected": []]], status: 200, delay: 0.35)
        }
        closing(backend)
        let store = guards()
        var changes = 0
        let model = makeModel(backend, guards: store)
        model.updateHandlers(navigate: nil, draft: nil, databaseChanged: { changes += 1 })
        model.appear()
        await running(model)
        let runner = try XCTUnwrap(Runner(model))
        runner.call(1, "write.rows", writeArgs)
        await eventually("the write left the device") { backend.calls("write.rows").count == 1 }
        model.disappear()
        await eventually("the captured refresh after disappear") { changes == 1 }
        XCTAssertNil(model.unconfirmedWrite)
        XCTAssertNil(makeModel(backend, guards: store).unconfirmedWrite,
                     "a confirmed pending marker is cleared; a new host is not blocked")
        XCTAssertEqual(backend.calls("write.rows").count, 1)
        XCTAssertTrue(runner.results(1).isEmpty, "a disappeared worker is not answered")
    }

    // MARK: Identity

    func testExactUnicodeComponentIDSelectsOnlyItsOwnSourceAndGrant() async throws {
        let composed = "c-\u{E9}", decomposed = "c-e\u{301}"
        let backend = ComponentBackend()
        backend.update {
            $0.componentID = composed
            $0.extraItems = [ComponentBackend.component(id: decomposed, name: "decoy", enabled: false)]
        }
        closing(backend)
        let model = makeModel(backend, componentID: composed)
        model.appear()
        await running(model)
        XCTAssertEqual(model.name, "calc")
        let source = try XCTUnwrap(backend.sourceReads.first)
        XCTAssertTrue(ComponentSandbox.sameID(source.path, "/api/components/" + composed))
        XCTAssertTrue(ComponentSandbox.sameID(backend.mintBodies.first?["componentId"].stringValue ?? "", composed))
        XCTAssertTrue(ComponentSandbox.sameID(model.capability.token?.componentID ?? "", composed))

        let decoy = makeModel(backend, componentID: decomposed)
        decoy.appear()
        await eventually("the decoy's own disabled state") { decoy.error == NativeComponentCapabilityError.disabled.errorDescription }
        XCTAssertNil(decoy.session)
        XCTAssertEqual(backend.mints, 1, "the canonically equivalent ID never mints")
    }
}
