import XCTest
@testable import MichiCore

final class ConnectionSessionTests: XCTestCase {
    private let home = "https://michi.tail123.ts.net"
    private let other = "https://other.example.test"

    func testStoredTokenIsNotSentToADifferentOrigin() {
        XCTAssertEqual(
            ConnectionTokenReuse.tokenToSend(
                explicit: "",
                stored: "secret-token-xyz",
                storedAddress: home,
                requestedAddress: other
            ),
            ""
        )
        XCTAssertEqual(
            ConnectionTokenReuse.tokenToSend(
                explicit: "",
                stored: "secret-token-xyz",
                storedAddress: home,
                requestedAddress: home + "/"
            ),
            "secret-token-xyz"
        )
        XCTAssertEqual(
            ConnectionTokenReuse.tokenToSend(
                explicit: "  fresh-token  ",
                stored: "secret-token-xyz",
                storedAddress: home,
                requestedAddress: home
            ),
            "fresh-token"
        )
        XCTAssertFalse(ConnectionTokenReuse.sameOrigin(home, other))
        XCTAssertTrue(ConnectionTokenReuse.sameOrigin(home, home + "/api"))
    }

    func testDirectBearerIsBoundToTheSelectedOrigin() throws {
        let selected = try XCTUnwrap(parse(home))
        XCTAssertEqual(ConnectionIdentity.directBearer(token: "secret-token-xyz", selected: selected), "secret-token-xyz")
        XCTAssertNil(ConnectionIdentity.directBearer(token: "   ", selected: selected))
        XCTAssertNil(ConnectionIdentity.directBearer(token: "", selected: selected))
    }

    func testLegacyProfilesDefaultAutoReconnectOff() throws {
        let data = Data(#"[{"id":"p1","name":"Mac","address":"https://michi.tail123.ts.net"}]"#.utf8)
        let profiles = try JSONDecoder().decode([ConnectionProfile].self, from: data)
        XCTAssertEqual(profiles, [ConnectionProfile(id: "p1", name: "Mac", address: home, autoReconnect: false)])
    }

    func testLaunchReconnectsLastSuccessfulOptedInProfile() {
        var state = ConnectionSessionState(profiles: [
            ConnectionProfile(id: "a", name: "A", address: home, autoReconnect: true),
        ])
        state.markSuccessfulConnection(state.profiles[0])
        XCTAssertEqual(state.lastAutoReconnectID, "a")
        state.selectedID = nil
        XCTAssertEqual(state.launchReconnectProfileID(arguments: []), "a")
    }

    func testLaunchIgnoresDebugFixturesAndManualHold() {
        var state = ConnectionSessionState(
            profiles: [ConnectionProfile(id: "a", name: "A", address: home, autoReconnect: true)],
            lastAutoReconnectID: "a"
        )
        XCTAssertNil(state.launchReconnectProfileID(arguments: ["--uitesting"]))
        XCTAssertNil(state.launchReconnectProfileID(arguments: ["--connection-preview-success"]))
        XCTAssertEqual(state.launchReconnectProfileID(arguments: []), "a")

        state.disconnect(profileID: "a")
        XCTAssertTrue(state.manualHold)
        XCTAssertNil(state.lastAutoReconnectID)
        XCTAssertFalse(state.profile(id: "a")?.autoReconnect ?? true)
        XCTAssertNil(state.launchReconnectProfileID(arguments: []))
        XCTAssertNil(state.selectedID)
    }

    func testRemovalStopsAutomaticReconnectWithoutSelectingAnotherProfile() {
        var state = ConnectionSessionState(profiles: [
            ConnectionProfile(id: "a", name: "A", address: home, autoReconnect: true),
            ConnectionProfile(id: "b", name: "B", address: other, autoReconnect: true),
        ], selectedID: "a", lastAutoReconnectID: "a")
        state.remove(profileID: "a")
        XCTAssertNil(state.lastAutoReconnectID)
        XCTAssertTrue(state.manualHold)
        XCTAssertNil(state.selectedID)
        XCTAssertNil(state.launchReconnectProfileID(arguments: []))
        XCTAssertEqual(state.profiles.map(\.id), ["b"])
    }

    func testCoordinatorRemoveOfInFlightProfileBeatsLateFinish() {
        var coordinator = ConnectionCoordinator(session: ConnectionSessionState(profiles: [
            ConnectionProfile(id: "a", name: "A", address: home, autoReconnect: true),
        ]))
        let request = coordinator.startConnect(address: home, name: "A", token: "", profileID: "a")
        XCTAssertTrue(coordinator.isActive(request))
        coordinator.remove(profileID: "a")
        XCTAssertFalse(coordinator.isActive(request))
        XCTAssertNil(coordinator.session.profile(id: "a"))
        XCTAssertFalse(coordinator.finish(request, profile: ConnectionProfile(id: "a", name: "A", address: home)))
        XCTAssertNil(coordinator.session.profile(id: "a"))
        XCTAssertNil(coordinator.session.selectedID)
    }

    func testCoordinatorNewerConnectInvalidatesThePreviousRequest() {
        var coordinator = ConnectionCoordinator()
        let first = coordinator.startConnect(address: home, name: "A", token: "old", profileID: nil)
        let second = coordinator.startConnect(address: other, name: "B", token: "new", profileID: nil)
        XCTAssertFalse(coordinator.isActive(first))
        XCTAssertTrue(coordinator.isActive(second))
        coordinator.disconnect()
        XCTAssertFalse(coordinator.isActive(second))
        XCTAssertTrue(coordinator.session.manualHold)
    }

    func testDisablingOptInClearsLastSuccessAndDoesNotBusyLoop() {
        var state = ConnectionSessionState(
            profiles: [ConnectionProfile(id: "a", name: "A", address: home, autoReconnect: true)],
            lastAutoReconnectID: "a"
        )
        state.setAutoReconnect(profileID: "a", enabled: false)
        XCTAssertNil(state.lastAutoReconnectID)
        XCTAssertNil(state.launchReconnectProfileID(arguments: []))
        state.connecting = true
        XCTAssertNil(state.launchReconnectProfileID(arguments: []))
    }

    private func parse(_ raw: String) -> ConnectionAddress.Parsed? {
        if case .success(let parsed) = ConnectionAddress.parse(raw) { return parsed }
        return nil
    }
}
