import XCTest
import MichiCore
#if canImport(Michi)
@testable import Michi
#else
@testable import MichiState
#endif

@MainActor
final class ConnectionStoreTests: XCTestCase {
    private let home = "https://michi.example.test"
    private let other = "https://other.example.test"
    private var defaults: UserDefaults!
    private var suiteName = ""

    override func setUp() {
        super.setUp()
        suiteName = "michi.connection.test." + UUID().uuidString
        defaults = UserDefaults(suiteName: suiteName)
        defaults.removePersistentDomain(forName: suiteName)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        defaults = nil
        super.tearDown()
    }

    func testRemovingInFlightProfilePreventsLateSuccessFromRecreatingIt() async throws {
        let hold = PreflightHold()
        let vault = MemoryCredentialVault()
        try vault.save("secret-token-xyz", id: "p1")
        let profile = ConnectionProfile(id: "p1", name: "Desk", address: home, autoReconnect: true)
        defaults.set(try JSONEncoder().encode([profile]), forKey: "michi.connections.v1")
        let store = makeStore(vault: vault) { _, _, onStage in
            await onStage?(.identity)
            return await hold.park()
        }

        let task = Task { await store.connect(profile) }
        try await waitUntil { store.connecting && store.preflightStage == .identity }
        store.remove(profile)
        await hold.finish(.success(Self.success))
        await task.value

        XCTAssertNil(store.api)
        XCTAssertNil(store.selected)
        XCTAssertFalse(store.connecting)
        XCTAssertFalse(store.profiles.contains { $0.id == "p1" })
        XCTAssertNil(vault.read("p1"))
    }

    func testSecondConnectReplacesTheFirstInsteadOfDropping() async throws {
        let first = PreflightHold()
        let second = PreflightHold()
        let vault = MemoryCredentialVault()
        let gate = ConnectCallGate()
        let store = makeStore(vault: vault) { _, _, onStage in
            let index = await gate.next()
            await onStage?(index == 1 ? .identity : .capabilities)
            return await (index == 1 ? first : second).park()
        }

        let one = Task { await store.connect(address: home, name: "First", token: "", profileID: nil) }
        try await waitUntil { store.connecting }
        let two = Task { await store.connect(address: other, name: "Second", token: "", profileID: nil) }
        try await waitUntil { await gate.count() == 2 }
        await first.finish(.success(Self.success))
        await second.finish(.success(Self.success))
        await one.value
        await two.value

        XCTAssertEqual(store.selected?.name, "Second")
        XCTAssertEqual(store.selected?.address, other)
        XCTAssertEqual(store.profiles.map(\.name), ["Second"])
        XCTAssertNotNil(store.api)
        XCTAssertFalse(store.connecting)
        XCTAssertEqual(store.preflightStage, .capabilities)
        XCTAssertNil(store.error)
    }

    func testExplicitDisconnectWinsOverLatePreflightSuccess() async throws {
        let hold = PreflightHold()
        let store = makeStore { _, _, onStage in
            await onStage?(.identity)
            return await hold.park()
        }
        let task = Task { await store.connect(address: home, name: "Desk", token: "secret-token-xyz", profileID: nil) }
        try await waitUntil { store.connecting }
        store.disconnect()
        await hold.finish(.success(Self.success))
        await task.value

        XCTAssertNil(store.api)
        XCTAssertNil(store.selected)
        XCTAssertFalse(store.connecting)
        XCTAssertTrue(store.profiles.isEmpty)
    }

    func testLaunchReconnectRemovalCancelsInFlightRestore() async throws {
        let hold = PreflightHold()
        let vault = MemoryCredentialVault()
        try vault.save("secret-token-xyz", id: "p1")
        let profile = ConnectionProfile(id: "p1", name: "Desk", address: home, autoReconnect: true)
        defaults.set(try JSONEncoder().encode([profile]), forKey: "michi.connections.v1")
        defaults.set("p1", forKey: "michi.connections.autoReconnect.v1")
        let store = ConnectionStore(
            defaults: defaults,
            arguments: [],
            credentials: vault,
            urlSession: URLSession(configuration: .ephemeral),
            preflight: { _, _, onStage in
                await onStage?(.workspaces)
                return await hold.park()
            },
            startLaunchReconnect: true
        )
        try await waitUntil { store.connecting }
        store.remove(profile)
        await hold.finish(.success(Self.success))
        try await waitUntil { !store.connecting }

        XCTAssertNil(store.api)
        XCTAssertNil(store.selected)
        XCTAssertFalse(store.profiles.contains { $0.id == "p1" })
    }

    private func makeStore(
        vault: MemoryCredentialVault = MemoryCredentialVault(),
        preflight: @escaping ConnectionPreflightHandler
    ) -> ConnectionStore {
        ConnectionStore(
            defaults: defaults,
            arguments: [],
            credentials: vault,
            urlSession: URLSession(configuration: .ephemeral),
            preflight: preflight,
            startLaunchReconnect: false
        )
    }

    private func waitUntil(_ timeout: TimeInterval = 2, _ condition: () async -> Bool) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if await condition() { return }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTFail("Condition was not met")
    }

    private static let success = ConnectionPreflight.Success(
        capabilities: [
            "protocolVersion": 2,
            "authoritativeTurnPersistence": true,
            "explicitCommands": true,
            "digestReadMarkers": "v1",
        ],
        workspaces: ["workspaces": []]
    )
}

private actor PreflightHold {
    private var continuation: CheckedContinuation<ConnectionPreflight.Result, Never>?

    func park() async -> ConnectionPreflight.Result {
        await withCheckedContinuation { continuation = $0 }
    }

    func finish(_ result: ConnectionPreflight.Result) {
        continuation?.resume(returning: result)
        continuation = nil
    }
}

private actor ConnectCallGate {
    private var calls = 0

    func next() -> Int {
        calls += 1
        return calls
    }

    func count() -> Int { calls }
}
