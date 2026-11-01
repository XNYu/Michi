import Foundation

/// A bounded, authenticated download owned by the caller. The URL points only
/// to a private temporary directory created by this request, never a server path.
public struct MichiArtifactDownload: Sendable {
    public let fileURL: URL
    public let filename: String
    public let byteCount: Int
    public let mimeType: String

    public func removeTemporaryFile() {
        let directory = fileURL.deletingLastPathComponent()
        guard directory.lastPathComponent.hasPrefix("michi-artifact-") else { return }
        try? FileManager.default.removeItem(at: directory)
    }
}

extension MichiAPI {
    public static let maximumArtifactDownloadBytes = 50 * 1024 * 1024

    /// Uses this connection's injected session and redirect policy. Data is
    /// written in 64 KiB chunks; the advertised and actual byte counts are capped.
    public func downloadArtifact(workspaceID: String, path: String,
                                 maximumBytes: Int = MichiAPI.maximumArtifactDownloadBytes) async throws -> MichiArtifactDownload {
        guard maximumBytes > 0, maximumBytes <= Self.maximumArtifactDownloadBytes else {
            throw MichiAPIError(statusCode: nil, code: MichiAPIError.Code.invalidRequest, message: "Artifact downloads must be limited to 50 MB or less.")
        }
        guard !path.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, path.utf8.count <= 8_192,
              !path.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else {
            throw MichiAPIError(statusCode: nil, code: MichiAPIError.Code.invalidPath, message: "This artifact has an invalid file reference.")
        }
        let route = "/artifacts/\(Self.pathSegment(workspaceID))/download?path=\(Self.queryComponent(path))"
        var (request, endpoint) = try makeRequest(route, method: "GET", body: nil, kind: .json)
        request.setValue("application/octet-stream", forHTTPHeaderField: "Accept")
        request.timeoutInterval = 90
        let redirects = MichiRedirectGuard(endpoint: endpoint, method: "GET", identityHeaders: identityHeaders(endpoint),
                                           gatewayAccess: gatewayAccess, now: now)
        let transfer = ArtifactTransferCancellation()
        return try await withTaskCancellationHandler {
            var directory: URL?
            do {
                try Task.checkCancellation()
                let (bytes, response) = try await session.bytes(for: request, delegate: redirects)
                transfer.attach(bytes.task)
                defer { transfer.cancel() }
                if let blocked = redirects.blocked { throw blocked }
                let http = try Self.validated(response, endpoint: endpoint)
                guard (200..<300).contains(http.statusCode) else {
                    var errorBody = Data()
                    for try await byte in bytes {
                        errorBody.append(byte)
                        if errorBody.count >= Self.maxErrorBodyBytes { break }
                    }
                    throw Self.httpError(http, body: errorBody)
                }
                let mime = http.mimeType?.lowercased() ?? ""
                if mime == "text/html" || mime == "application/xhtml+xml" { throw Self.htmlError(status: http.statusCode) }
                // The production download route always forces attachment/octet-stream.
                // An ingress JSON/login response must not become a saved artifact.
                guard mime == "application/octet-stream" else {
                    throw MichiAPIError(statusCode: http.statusCode, code: MichiAPIError.Code.invalidResponse,
                                        message: "The server did not return an artifact download.")
                }
                if response.expectedContentLength > Int64(maximumBytes) { throw Self.artifactLimitError(status: http.statusCode, maximumBytes: maximumBytes) }
                let suggested = http.value(forHTTPHeaderField: "Content-Disposition") == nil ? path : response.suggestedFilename ?? path
                let filename = Self.safeArtifactFilename(suggested)
                let folder = FileManager.default.temporaryDirectory.appendingPathComponent("michi-artifact-" + UUID().uuidString, isDirectory: true)
                try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
                directory = folder
                let file = folder.appendingPathComponent(filename, isDirectory: false)
                guard FileManager.default.createFile(atPath: file.path, contents: nil, attributes: [.posixPermissions: 0o600]) else {
                    throw MichiAPIError(statusCode: nil, code: "artifact_storage", message: "Could not create a temporary download file.")
                }
                let handle = try FileHandle(forWritingTo: file)
                defer { try? handle.close() }
                var chunk = Data(), count = 0
                chunk.reserveCapacity(64 * 1024)
                for try await byte in bytes {
                    guard count < maximumBytes else { throw Self.artifactLimitError(status: http.statusCode, maximumBytes: maximumBytes) }
                    chunk.append(byte); count += 1
                    if chunk.count == 64 * 1024 {
                        try Task.checkCancellation(); try handle.write(contentsOf: chunk); chunk.removeAll(keepingCapacity: true)
                    }
                }
                try Task.checkCancellation()
                if response.expectedContentLength >= 0,
                   http.value(forHTTPHeaderField: "Content-Encoding") == nil,
                   response.expectedContentLength != Int64(count) {
                    throw MichiAPIError(statusCode: http.statusCode, code: MichiAPIError.Code.invalidResponse, message: "The artifact download ended before all bytes arrived.")
                }
                if !chunk.isEmpty { try handle.write(contentsOf: chunk) }
                try handle.close()
                return MichiArtifactDownload(fileURL: file, filename: filename, byteCount: count, mimeType: mime)
            } catch {
                if let directory { try? FileManager.default.removeItem(at: directory) }
                throw Self.transportError(redirects.blocked.map { $0 as Error } ?? error)
            }
        } onCancel: { transfer.cancel() }
    }

    /// File names from Content-Disposition are presentation data, never paths.
    public static func safeArtifactFilename(_ suggested: String) -> String {
        let basename = suggested.replacingOccurrences(of: "\\", with: "/").split(separator: "/", omittingEmptySubsequences: true).last.map(String.init) ?? "artifact"
        let disallowed = CharacterSet.controlCharacters.union(CharacterSet(charactersIn: ":*?\"<>|"))
            .union(CharacterSet(charactersIn: "\u{202A}\u{202B}\u{202C}\u{202D}\u{202E}\u{2066}\u{2067}\u{2068}\u{2069}"))
        var name = String(String.UnicodeScalarView(basename.unicodeScalars.filter { !disallowed.contains($0) }))
            .trimmingCharacters(in: .whitespacesAndNewlines)
        while name.hasPrefix(".") { name.removeFirst() }
        while name.utf8.count > 220 { name.removeLast() }
        return name.isEmpty ? "artifact" : name
    }

    private static func artifactLimitError(status: Int, maximumBytes: Int) -> MichiAPIError {
        MichiAPIError(statusCode: status, code: "artifact_too_large",
                      message: "This download exceeds the \(ByteCountFormatter.string(fromByteCount: Int64(maximumBytes), countStyle: .file)) limit.")
    }
}

private final class ArtifactTransferCancellation: @unchecked Sendable {
    private let lock = NSLock()
    private var task: URLSessionDataTask?
    private var cancelled = false
    func attach(_ task: URLSessionDataTask) {
        lock.lock(); self.task = task; let wasCancelled = cancelled; lock.unlock()
        if wasCancelled { task.cancel() }
    }
    func cancel() {
        lock.lock(); cancelled = true; let task = task; lock.unlock()
        task?.cancel()
    }
}
