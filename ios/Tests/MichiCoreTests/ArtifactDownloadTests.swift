import Foundation
import XCTest
@testable import MichiCore

final class ArtifactDownloadTests: XCTestCase {
    private var session: URLSession!
    override func setUp() {
        super.setUp(); TransportMockURLProtocol.reset()
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [TransportMockURLProtocol.self]
        session = URLSession(configuration: configuration, delegate: TransportFollowingDelegate(), delegateQueue: nil)
    }
    override func tearDown() {
        session.invalidateAndCancel(); session = nil; TransportMockURLProtocol.reset(); super.tearDown()
    }
    private func api() -> MichiAPI {
        MichiAPI(baseURL: URL(string: "https://download.michi.test")!, bearerToken: "test-secret", session: session)
    }
    private func bytes(_ value: String, headers: [String: String] = [:]) -> TransportMockURLProtocol.Reply {
        .respond(status: 200, headers: ["Content-Type": "application/octet-stream"].merging(headers) { _, value in value }, chunks: [.init(value)])
    }
    private func errorCode(_ code: String, operation: @escaping @Sendable () async throws -> MichiArtifactDownload, file: StaticString = #filePath, line: UInt = #line) async {
        do { let download = try await transportWithTimeout { try await operation() }; download.removeTemporaryFile(); XCTFail("Expected \(code)", file: file, line: line) }
        catch let error as MichiAPIError { XCTAssertEqual(error.code, code, file: file, line: line) }
        catch { XCTFail("Unexpected error: \(error)", file: file, line: line) }
    }

    func testAuthenticatedDownloadUsesInjectedSessionAndEncodedQuery() async throws {
        TransportMockURLProtocol.install { _ in self.bytes("native bytes", headers: ["Content-Disposition": "attachment; filename=\"report.txt\"", "Content-Length": "12"]) }
        let file = try await api().downloadArtifact(workspaceID: "workspace-1", path: ".artifacts/a & b.txt", maximumBytes: 100)
        defer { file.removeTemporaryFile() }
        XCTAssertEqual(file.filename, "report.txt")
        XCTAssertEqual(file.byteCount, 12)
        XCTAssertEqual(try String(contentsOf: file.fileURL, encoding: .utf8), "native bytes")
        let request = try XCTUnwrap(TransportMockURLProtocol.requests.first)
        XCTAssertEqual(request.headers["Authorization"], "Bearer test-secret")
        XCTAssertEqual(request.headers["Origin"], "https://download.michi.test")
        XCTAssertEqual(request.headers["Accept"], "application/octet-stream")
        XCTAssertEqual(URLComponents(url: request.url, resolvingAgainstBaseURL: false)?.queryItems?.first?.value, ".artifacts/a & b.txt")
        XCTAssertEqual(request.url.path, "/api/artifacts/workspace-1/download")
        XCTAssertTrue(file.fileURL.deletingLastPathComponent().lastPathComponent.hasPrefix("michi-artifact-"))
    }

    func testAbsentDispositionUsesSafeOriginalBasename() async throws {
        TransportMockURLProtocol.install { _ in self.bytes("x") }
        let file = try await api().downloadArtifact(workspaceID: "ws", path: "folder/original.pdf")
        defer { file.removeTemporaryFile() }
        XCTAssertEqual(file.filename, "original.pdf")
    }

    func testAdvertisedAndActualByteLimitsBothRejectOversize() async {
        let client = api()
        TransportMockURLProtocol.install { _ in self.bytes("x", headers: ["Content-Length": "9"]) }
        await errorCode("artifact_too_large") { try await client.downloadArtifact(workspaceID: "ws", path: "x", maximumBytes: 4) }
        TransportMockURLProtocol.install { _ in self.bytes("12345") }
        await errorCode("artifact_too_large") { try await client.downloadArtifact(workspaceID: "ws", path: "x", maximumBytes: 4) }
    }

    func testInvalidLimitAndBlankPathMakeNoRequest() async {
        let client = api()
        TransportMockURLProtocol.install { _ in self.bytes("should not run") }
        await errorCode(MichiAPIError.Code.invalidRequest) { try await client.downloadArtifact(workspaceID: "ws", path: "x", maximumBytes: 0) }
        await errorCode(MichiAPIError.Code.invalidRequest) { try await client.downloadArtifact(workspaceID: "ws", path: "x", maximumBytes: 51 * 1024 * 1024) }
        await errorCode(MichiAPIError.Code.invalidPath) { try await client.downloadArtifact(workspaceID: "ws", path: " \n") }
        XCTAssertTrue(TransportMockURLProtocol.requests.isEmpty)
    }

    func testCrossOriginRedirectCannotLeakBearerEvenWithFollowingSessionDelegate() async {
        let client = api()
        TransportMockURLProtocol.install { _ in .redirect(status: 302, location: "https://elsewhere.example/stolen") }
        await errorCode(MichiAPIError.Code.redirectBlocked) { try await client.downloadArtifact(workspaceID: "ws", path: "x") }
        XCTAssertEqual(TransportMockURLProtocol.requests.map { $0.url.host }, ["download.michi.test"])
    }

    func testSameOriginRedirectRechecksGatewayExpiryAndDoesNotFollow() async {
        let origin = URL(string: "https://download.michi.test")!
        let issued = Date(timeIntervalSince1970: 1_700_000_000)
        let expires = issued.addingTimeInterval(60)
        let clock = TransportTestClock(issued)
        let access = try! GatewayAccess(endpoint: origin, bearer: "fixture-gateway-bearer", expiresAt: expires)
        let client = MichiAPI(baseURL: origin, session: session, gatewayAccess: access)
        client.now = { clock.date() }
        TransportMockURLProtocol.install { request in
            if request.url.path.hasSuffix("download") {
                clock.set(expires.addingTimeInterval(1))
                return .redirect(status: 302, location: "/api/file-transfer")
            }
            return self.bytes("leaked")
        }
        await errorCode(MichiAPIError.Code.gatewayAccessExpired) { try await client.downloadArtifact(workspaceID: "ws", path: "x") }
        XCTAssertEqual(TransportMockURLProtocol.requests.map { $0.url.path }, ["/api/artifacts/ws/download"])
        XCTAssertFalse(TransportMockURLProtocol.requests.contains { $0.url.path == "/api/file-transfer" })
    }

    func testSameOriginRedirectRetainsIdentityHeaders() async throws {
        TransportMockURLProtocol.install { request in
            if request.url.path.hasSuffix("download") { return .redirect(status: 302, location: "/api/file-transfer") }
            return self.bytes("ok", headers: ["Content-Disposition": "attachment; filename=\"file.bin\""])
        }
        let file = try await api().downloadArtifact(workspaceID: "ws", path: "x")
        defer { file.removeTemporaryFile() }
        XCTAssertEqual(file.byteCount, 2)
        XCTAssertEqual(TransportMockURLProtocol.requests.count, 2)
        XCTAssertTrue(TransportMockURLProtocol.requests.allSatisfy { $0.headers["Authorization"] == "Bearer test-secret" })
    }

    func testLoginHTMLAndUnexpectedJSONAreNeverSavedAsFile() async {
        let client = api()
        TransportMockURLProtocol.install { _ in .respond(status: 200, headers: ["Content-Type": "text/html"], chunks: [.init("<html>Login</html>")]) }
        await errorCode(MichiAPIError.Code.htmlResponse) { try await client.downloadArtifact(workspaceID: "ws", path: "x") }
        TransportMockURLProtocol.install { _ in .respond(status: 200, headers: ["Content-Type": "application/json"], chunks: [.init("{}")]) }
        await errorCode(MichiAPIError.Code.invalidResponse) { try await client.downloadArtifact(workspaceID: "ws", path: "x") }
    }

    func testHTTPErrorRetainsMachineCodeWithoutRetry() async {
        let client = api()
        TransportMockURLProtocol.install { _ in .respond(status: 404, headers: ["Content-Type": "application/json"], chunks: [.init(#"{"error":"Gone","code":"missing_file"}"#)]) }
        await errorCode("missing_file") { try await client.downloadArtifact(workspaceID: "ws", path: "x") }
        XCTAssertEqual(TransportMockURLProtocol.requests.count, 1)
    }

    func testCancellationClosesByteStreamWithoutAnotherRequest() async throws {
        let gate = DispatchSemaphore(value: 0), client = api()
        TransportMockURLProtocol.install { _ in .respond(status: 200, headers: ["Content-Type": "application/octet-stream"], chunks: [.init("wait", waitFor: gate)]) }
        let task = Task { try await client.downloadArtifact(workspaceID: "ws", path: "x") }
        try await transportWaitUntil { !TransportMockURLProtocol.requests.isEmpty }
        task.cancel()
        do { let file = try await task.value; file.removeTemporaryFile(); XCTFail("Cancelled download completed") }
        catch { XCTAssertTrue(error is CancellationError, "\(error)") }
        try await transportWaitUntil { TransportMockURLProtocol.stopCount > 0 }
        XCTAssertEqual(TransportMockURLProtocol.requests.count, 1)
    }

    func testSuggestedFilenameCannotEscapeDirectoryOrSpoofDirection() {
        XCTAssertEqual(MichiAPI.safeArtifactFilename("../../secret.txt"), "secret.txt")
        XCTAssertEqual(MichiAPI.safeArtifactFilename("C:\\private\\report.pdf"), "report.pdf")
        XCTAssertEqual(MichiAPI.safeArtifactFilename(".\u{202E}evil\n.svg"), "evil.svg")
        XCTAssertEqual(MichiAPI.safeArtifactFilename(".."), "artifact")
        XCTAssertLessThanOrEqual(MichiAPI.safeArtifactFilename(String(repeating: "界", count: 200)).utf8.count, 220)
    }
}
