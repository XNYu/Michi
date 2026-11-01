import Foundation
import MichiCore

private struct StreamProbeFailure: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}
private func require(_ condition: Bool, _ message: String) throws {
    if !condition { throw StreamProbeFailure(message: message) }
}
private actor ProbeEvents {
    private var records: [String: [SSEEvent]] = [:]
    func append(_ event: SSEEvent, to channel: String) { records[channel, default: []].append(event) }
    func events(_ channel: String) -> [SSEEvent] { records[channel] ?? [] }
}
private func consume(_ api: MichiAPI, path: String, method: String = "GET", body: JSONValue? = nil,
                     channel: String, recorder: ProbeEvents) async throws -> [SSEEvent] {
    var events: [SSEEvent] = []
    for try await event in api.stream(path, method: method, body: body) {
        events.append(event); await recorder.append(event, to: channel)
    }
    return events
}
private func waitUntil(_ description: String, _ predicate: () async throws -> Bool) async throws {
    let deadline = Date().addingTimeInterval(6)
    repeat {
        if try await predicate() { return }
        try await Task.sleep(for: .milliseconds(20))
    } while Date() < deadline
    throw StreamProbeFailure(message: "Timed out: " + description)
}

@main struct StreamProbe {
    static func main() async {
        let watchdog = Task {
            do { try await Task.sleep(for: .seconds(40)) } catch { return }
            fputs("FAIL: isolated native WebSocket probe exceeded 40 seconds.\n", stderr)
            exit(2)
        }
        defer { watchdog.cancel() }
        do {
            try await run()
        } catch {
            fputs("FAIL: \(error.localizedDescription)\n", stderr)
            exit(1)
        }
    }

    static func run() async throws {
        guard CommandLine.arguments.count == 2 else { throw StreamProbeFailure(message: "Pass the endpoint JSON written by stream-harness.cjs.") }
        let endpoint = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])))
        guard endpoint["isolated"].boolValue, endpoint["service"] == "michi-native-stream-harness",
              let url = URL(string: endpoint["url"].stringValue), url.host == "127.0.0.1", url.scheme == "http",
              !endpoint["bearerToken"].stringValue.isEmpty else {
            throw StreamProbeFailure(message: "Only an isolated loopback stream harness is allowed.")
        }
        let transport = MichiStreamTransport()
        let api = MichiAPI(baseURL: url, bearerToken: endpoint["bearerToken"].stringValue, streamTransport: transport)
        let identity = try await api.request("/probe/status")
        try require(identity["isolated"].boolValue && identity["service"] == "michi-native-stream-harness", "Not the isolated stream harness")
        let capabilities = try await api.request("/persistence/capabilities")
        try await transport.configure(capabilities: capabilities)
        let recorder = ProbeEvents()
        let payload: JSONValue = ["nodeId": "probe", "turnId": "message-turn", "text": "Native contract only", "displayText": "Native contract only", "userMetadata": ["attachments": []]]
        let background: JSONValue = ["includeForeground": true, "cursors": ["background-node": ["turnId": "background-turn", "seq": 2]]]
        let message = Task { try await consume(api, path: "/chats/probe/message", method: "POST", body: payload, channel: "message", recorder: recorder) }
        let replay = Task { try await consume(api, path: "/chats/replay/stream?fromTurnId=replay-turn&fromSeq=7", channel: "replay", recorder: recorder) }
        let observer = Task { try await consume(api, path: "/chats/background/subscribe", method: "POST", body: background, channel: "background", recorder: recorder) }
        defer { message.cancel(); replay.cancel(); observer.cancel(); Task { await api.closeStreams() } }
        try await waitUntil("three multiplexed channels and split Unicode event") {
            let stats = try await api.request("/probe/status")
            let chunks = await recorder.events("message")
            let replayEvents = await recorder.events("replay"), backgroundEvents = await recorder.events("background")
            return stats["active"].arrayValue.count == 3 && chunks.contains { $0.data["text"] == "你好😀 — native WebSocket" }
                && !replayEvents.isEmpty && !backgroundEvents.isEmpty
        }
        var stats = try await api.request("/probe/status")
        try require(stats["tickets"] == 1 && stats["upgrades"] == 1, "Concurrent streams did not share one real socket and one ticket")
        try require(stats["opens"].arrayValue.allSatisfy { $0["originMatches"].boolValue && $0["authenticated"].boolValue }, "Forwarded routes lost Origin/authentication")
        try require(stats["opens"].arrayValue.first { $0["path"] == "/api/chats/probe/message" }?["body"] == payload, "POST payload changed across WebSocket transport")
        try require(stats["opens"].arrayValue.first { $0["path"] == "/api/chats/background/subscribe" }?["body"] == background, "Background cursors changed")
        try require(stats["upgradeOrigins"].arrayValue == [.string(url.absoluteString)], "Native upgrade Origin does not match ticket Origin")
        try require(stats["upgradeHadAuthorization"].arrayValue == [.bool(false)], "Upgrade unexpectedly duplicated the bearer credential")
        print("PASS: real URLSessionWebSocket → production ticket/upgrade → 3 authenticated demultiplexed SSE channels; Unicode chunks, bodies and replay cursors preserved.")

        replay.cancel()
        do { _ = try await replay.value; throw StreamProbeFailure(message: "Cancelled subscriber did not throw") } catch is CancellationError {}
        try await waitUntil("only replay subscriber detached") {
            let active = try await api.request("/probe/status")["active"].arrayValue
            return active.count == 2 && !active.contains("replay")
        }
        let start = Date()
        stats = try await api.request("/probe/status")
        try require(Date().timeIntervalSince(start) < 2 && stats["active"].arrayValue.count == 2, "Ordinary HTTP request stalled behind active streams")
        try require(stats["cancelCalls"] == 0, "Subscriber detach called durable agent cancellation")
        _ = try await api.request("/probe/release", method: "POST", body: [:])
        let messageEvents = try await message.value, backgroundEvents = try await observer.value
        try require(messageEvents.map(\.event) == ["turn_start", "chunk", "done"], "Message channel included another channel's events")
        try require(backgroundEvents.first?.event == "foreground_event" && backgroundEvents.first?.data["data"]["title"] == "Background channel only", "Background frame was misrouted")
        print("PASS: cancelling one subscriber detaches its upstream only; other channels and ordinary HTTP remain usable; zero durable /cancel calls.")

        let uncertain = Task { try await consume(api, path: "/chats/uncertain/message", method: "POST", body: ["nodeId": "uncertain", "turnId": "uncertain-turn", "text": "Accepted exactly once"], channel: "uncertain", recorder: recorder) }
        defer { uncertain.cancel() }
        try await waitUntil("accepted turn before connection loss") { await recorder.events("uncertain").contains { $0.event == "chunk" } }
        _ = try await api.request("/probe/drop-sockets", method: "POST", body: [:])
        var disconnected = false
        do { _ = try await uncertain.value } catch { disconnected = true }
        try require(disconnected, "A lost WebSocket did not fail its subscriber")
        let recovered = try await consume(api, path: "/chats/uncertain/stream?fromTurnId=uncertain-turn&fromSeq=2", channel: "recovered", recorder: recorder)
        stats = try await api.request("/probe/status")
        try require(stats["opens"].arrayValue.filter { $0["path"] == "/api/chats/uncertain/message" }.count == 1, "An ambiguous POST was resent")
        try require(stats["opens"].arrayValue.contains { $0["method"] == "GET" && $0["path"] == "/api/chats/uncertain/stream?fromTurnId=uncertain-turn&fromSeq=2" }, "Replay did not retain the turn and sequence")
        try require(recovered.map(\.event) == ["chunk", "done"] && recovered.first?.data["seq"] == 2, "Replay ordering failed")
        try require(stats["tickets"] == 2 && stats["upgrades"] == 2, "Recovery did not acquire a fresh one-use ticket")
        print("PASS: forced real socket loss does not resend POST; explicit GET replay uses the original turn/cursor and a fresh ticket.")

        var refused = false
        do { _ = try await consume(api, path: "/chats/busy/message", method: "POST", body: ["turnId": "busy-turn"], channel: "busy", recorder: recorder) }
        catch let error as MichiAPIError { refused = error.statusCode == 409 && error.code == "turn_active" }
        try require(refused, "Production forwarding lost 409 turn_active semantics")
        let legacyTransport = MichiStreamTransport()
        try await legacyTransport.configure(capabilities: ["protocolVersion": 2])
        let legacy = MichiAPI(baseURL: url, bearerToken: endpoint["bearerToken"].stringValue, streamTransport: legacyTransport)
        let legacyEvents = try await consume(legacy, path: "/chats/legacy/stream", channel: "legacy", recorder: recorder)
        await legacy.closeStreams()
        stats = try await api.request("/probe/status")
        try require(legacyEvents.first?.data["channel"] == "legacy-sse" && stats["upgrades"] == 2, "Legacy SSE fallback opened another socket or failed")
        print("PASS: real forwarded 409 preserves its machine code; explicit legacy capability retains native HTTP SSE.")

        try await verifyTicketSafety(api: api, base: url)
        await api.closeStreams()
        try await waitUntil("all upstream subscriptions closed") { try await api.request("/probe/status")["active"].arrayValue.isEmpty }
        stats = try await api.request("/probe/status")
        try require(stats["cancelCalls"] == 0, "Durable cancellation route was invoked")
        print("PASS: native WebSocket contract smoke complete. Synthetic loopback-only routes; no existing data, credentials, database, scheduler, or agent runtime used.")
    }

    private static func verifyTicketSafety(api: MichiAPI, base: URL) async throws {
        func request(token: String, origin: String) throws -> URLRequest {
            var parts = URLComponents(url: base, resolvingAgainstBaseURL: false)!
            parts.scheme = "ws"; parts.path = "/api/stream-transport"; parts.queryItems = [URLQueryItem(name: "token", value: token)]
            var request = URLRequest(url: parts.url!, timeoutInterval: 5)
            request.setValue(origin, forHTTPHeaderField: "Origin")
            return request
        }
        let ticket = try await api.request("/stream-transport", method: "POST")
        let firstRequest = try request(token: ticket["token"].stringValue, origin: base.absoluteString)
        let first = URLSession.shared.webSocketTask(with: firstRequest)
        first.resume()
        try await first.send(.string("{\"type\":\"cancel\",\"id\":\"unused-fixture\"}"))
        first.cancel(with: .normalClosure, reason: nil)
        let reused = URLSession.shared.webSocketTask(with: firstRequest)
        reused.resume()
        var reuseRejected = false
        do { try await reused.send(.string("{\"type\":\"cancel\",\"id\":\"unused-fixture\"}")) } catch { reuseRejected = true }
        reused.cancel(with: .goingAway, reason: nil)
        try require(reuseRejected, "A consumed stream ticket was reusable")
        let next = try await api.request("/stream-transport", method: "POST")
        let wrongOrigin = URLSession.shared.webSocketTask(with: try request(token: next["token"].stringValue, origin: "https://refused-native-origin.invalid"))
        wrongOrigin.resume()
        var originRejected = false
        do { try await wrongOrigin.send(.string("{\"type\":\"cancel\",\"id\":\"unused-fixture\"}")) } catch { originRejected = true }
        wrongOrigin.cancel(with: .goingAway, reason: nil)
        try require(originRejected, "A one-use ticket was not bound to its Origin")
        let stats = try await api.request("/probe/status")
        try require(stats["upgrades"].intValue >= 5 && stats["upgradeOrigins"].arrayValue.last == "https://refused-native-origin.invalid", "Rejected upgrades did not reach the production guard")
        print("PASS: actual native upgrades reject reused tickets and mismatched Origins.")
    }
}
