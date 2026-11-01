import Foundation
import Combine
import MichiCore

@MainActor final class ArtifactLibraryModel: ObservableObject {
    let api: MichiAPI
    let workspaceID: String
    @Published var artifacts: [JSONValue]
    @Published var loading = false
    @Published var error: String?
    init(api: MichiAPI, graph: WorkspaceGraph) {
        self.api = api; workspaceID = graph.id; artifacts = graph.contexts
    }
    func refresh() async {
        guard !loading else { return }; loading = true; defer { loading = false }
        do {
            let response = try await api.request("/workspaces/\(MichiAPI.pathSegment(workspaceID))")
            guard response["workspace"].id == workspaceID,
                  case .array(let records) = response["contexts"].isNull ? response["artifacts"] : response["contexts"] else {
                throw NativeFailure("The saved artifact list could not be read. Your previous list is still shown.")
            }
            artifacts = records.filter { !$0.id.isEmpty }.sorted {
                let left = $0["pinned_at"].doubleValue, right = $1["pinned_at"].doubleValue
                if left != right { return left > right }
                return $0["name"].stringValue.localizedStandardCompare($1["name"].stringValue) == .orderedAscending
            }
            error = nil
        } catch is CancellationError { }
        catch { self.error = error.localizedDescription }
    }
}

struct ArtifactContent: Equatable {
    let text: String
    let imageData: Data?
    let imageMime: String?
    let path: String
    let basename: String
    let fileExtension: String
    let size: Int
    let modifiedAt: Double

    init(_ response: JSONValue, expectedPath: String) throws {
        guard let text = response["content"].optionalString, text.utf8.count <= 8 * 1024 * 1024,
              response["path"].stringValue == expectedPath,
              case .number(let size) = response["size"], size.isFinite, size >= 0, size <= 5 * 1024 * 1024, size.rounded(.towardZero) == size,
              case .number(let modified) = response["modifiedAt"], modified.isFinite, modified >= 0, modified <= 253_402_300_799_000 else {
            throw NativeFailure("Michi returned an invalid artifact preview.")
        }
        self.text = text; path = expectedPath; self.size = Int(size); modifiedAt = modified
        basename = MichiAPI.safeArtifactFilename(response["basename"].optionalString ?? expectedPath)
        fileExtension = response["extension"].stringValue.lowercased()
        if let mime = response["imageMime"].optionalString {
            let prefix = "data:\(mime);base64,"
            guard ["image/png", "image/jpeg", "image/gif", "image/webp"].contains(mime), text.hasPrefix(prefix),
                  let bytes = Data(base64Encoded: String(text.dropFirst(prefix.count))), bytes.count <= 5 * 1024 * 1024 else {
                throw NativeFailure("Michi returned an invalid image preview.")
            }
            imageMime = mime; imageData = bytes
        } else { imageMime = nil; imageData = nil }
    }
}

@MainActor final class ArtifactFileModel: ObservableObject {
    let api: MichiAPI
    let workspaceID: String
    let artifact: JSONValue
    let pollInterval: Duration
    var path: String { artifact["file_path"].stringValue }
    var name: String { artifact["name"].stringValue.isEmpty ? MichiAPI.safeArtifactFilename(path) : artifact["name"].stringValue }
    var quoteSource: JSONValue { ["type": "artifact", "filePath": .string(path), "name": .string(name)] }
    var referenceText: String { "\(name)\nFile: \(path)" }
    @Published private(set) var content: ArtifactContent?
    @Published private(set) var loading = false
    @Published private(set) var missing = false
    @Published private(set) var showingCachedContent = false
    @Published private(set) var error: String?
    @Published private(set) var watchError: String?
    @Published private(set) var lastChecked: Date?
    @Published private(set) var downloading = false
    @Published private(set) var downloaded: MichiArtifactDownload?
    @Published private(set) var downloadError: String?
    private var epoch = 0
    private var refreshAgain = false
    private var refreshTask: Task<Void, Never>?
    private var refreshIdentity: UUID?
    private var watchTask: Task<Void, Never>?
    private var pollTask: Task<Void, Never>?
    private var downloadTask: Task<MichiArtifactDownload, Error>?
    private var downloadIdentity: UUID?
    private let temporaryFile = ArtifactTemporaryFile()
    private var active = false

    init(api: MichiAPI, workspaceID: String, artifact: JSONValue, pollInterval: Duration = .seconds(15)) {
        self.api = api; self.workspaceID = workspaceID; self.artifact = artifact; self.pollInterval = max(.seconds(1), pollInterval)
    }

    /// The current backend watch declaration replaces the global cwd set. Do
    /// not POST one phone's paths and erase another window's registrations.
    /// Existing SSE events are consumed; a serial read-only poll covers files
    /// not registered by another client. Both stop when the preview is hidden.
    func start() {
        guard !active else { return }
        guard !path.isEmpty else { error = "This artifact has no file reference."; missing = true; return }
        active = true
        watchTask = Task { [weak self] in
            guard let self else { return }
            while !Task.isCancelled && active {
                do {
                    for try await event in api.stream("/workspaces/\(MichiAPI.pathSegment(workspaceID))/watch/stream") {
                        guard !Task.isCancelled && active else { return }
                        watchError = nil; await receive(event)
                    }
                    if !Task.isCancelled { watchError = "Live updates disconnected; periodic refresh is still active." }
                } catch is CancellationError { return }
                catch { if Task.isCancelled { return }; watchError = "Live updates unavailable; periodic refresh is still active." }
                do { try await Task.sleep(for: .seconds(3)) } catch { return }
            }
        }
        pollTask = Task { [weak self] in
            guard let self else { return }
            await refresh()
            while !Task.isCancelled && active {
                do { try await Task.sleep(for: pollInterval) } catch { return }
                guard !Task.isCancelled && active else { return }
                await refresh()
            }
        }
    }

    func stop() {
        active = false; epoch += 1; refreshAgain = false
        watchTask?.cancel(); watchTask = nil
        pollTask?.cancel(); pollTask = nil
        refreshTask?.cancel(); refreshTask = nil; refreshIdentity = nil; loading = false
        downloadTask?.cancel(); downloadTask = nil; downloadIdentity = nil; downloading = false
    }

    func receive(_ event: SSEEvent) async {
        guard event.data["filePath"].stringValue == path else { return }
        if event.event == "artifact_removed" {
            epoch += 1; refreshAgain = false
            clearContent(); missing = true; error = "This file is no longer available."
        } else if event.event == "artifact_changed" {
            epoch += 1; clearDownload(); await refresh()
        }
    }

    func refresh() async {
        if let refreshTask { refreshAgain = true; await refreshTask.value; return }
        let identity = UUID(); refreshIdentity = identity
        let task = Task { [weak self] in
            guard let self else { return }
            repeat {
                refreshAgain = false
                await read()
            } while refreshAgain && !Task.isCancelled && refreshIdentity == identity
        }
        refreshTask = task; await task.value
        if refreshIdentity == identity { refreshTask = nil; refreshIdentity = nil }
    }

    private func read() async {
        guard !path.isEmpty else { error = "This artifact has no file reference."; return }
        let readingEpoch = epoch
        let readingIdentity = refreshIdentity
        loading = true; defer { if readingIdentity == refreshIdentity { loading = false } }
        do {
            let result = try await api.request("/artifacts/\(MichiAPI.pathSegment(workspaceID))/read?path=\(MichiAPI.queryComponent(path))&preview=1")
            let next = try ArtifactContent(result, expectedPath: path)
            guard !Task.isCancelled, epoch == readingEpoch else { return }
            if let current = content, current.modifiedAt != next.modifiedAt || current.size != next.size { clearDownload() }
            content = next; missing = false; showingCachedContent = false; error = nil; lastChecked = Date()
        } catch is CancellationError { }
        catch {
            guard !Task.isCancelled, epoch == readingEpoch else { return }
            let status = (error as? MichiAPIError)?.statusCode
            if [401, 403, 404, 413, 415].contains(status ?? 0) { clearContent() }
            missing = status == 404; showingCachedContent = content != nil
            self.error = missing ? "This file is no longer available." : error.localizedDescription
        }
    }

    func prepareDownload() async -> MichiArtifactDownload? {
        guard !downloading, !missing else { return nil }
        if let downloaded { return downloaded }
        downloading = true; downloadError = nil
        let readingEpoch = epoch
        let identity = UUID(); downloadIdentity = identity
        let task = Task { try await api.downloadArtifact(workspaceID: workspaceID, path: path) }
        downloadTask = task
        do {
            let file = try await task.value
            guard !Task.isCancelled, epoch == readingEpoch, downloadIdentity == identity else { file.removeTemporaryFile(); return nil }
            temporaryFile.replace(file); downloaded = file; downloading = false; downloadTask = nil; downloadIdentity = nil; return file
        } catch {
            if epoch == readingEpoch, downloadIdentity == identity {
                downloading = false; downloadTask = nil; downloadIdentity = nil
                if !(error is CancellationError) { downloadError = error.localizedDescription }
            }
            return nil
        }
    }

    func clearDownload() {
        temporaryFile.replace(nil); downloaded = nil
        downloadTask?.cancel(); downloadTask = nil; downloadIdentity = nil; downloading = false
    }
    private func clearContent() {
        content = nil; showingCachedContent = false; loading = false; clearDownload()
    }

    static func canPreviewDownload(_ filename: String) -> Bool {
        // HTML/SVG/JavaScript and archives are never opened in a web-backed viewer.
        ["pdf", "png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "tif", "tiff", "bmp", "rtf", "doc", "docx", "xls", "xlsx", "ppt", "pptx"].contains((filename as NSString).pathExtension.lowercased())
    }
}

/// A non-actor lease cleans up the private file even when Swift releases a
/// model outside the main actor. The transfer itself still owns failure cleanup.
private final class ArtifactTemporaryFile: @unchecked Sendable {
    private let lock = NSLock()
    private var file: MichiArtifactDownload?
    func replace(_ next: MichiArtifactDownload?) {
        lock.lock(); let previous = file; file = next; lock.unlock()
        previous?.removeTemporaryFile()
    }
    deinit { file?.removeTemporaryFile() }
}
