import Foundation
import XCTest
import MichiCore
#if canImport(Michi)
@testable import Michi
#else
@testable import MichiState
#endif

private func artifactPreview(_ text: String = "# Draft", path: String = ".artifacts/report.md", modified: Double = 1) -> JSONValue {
    ["content": .string(text), "path": .string(path), "basename": "report.md", "extension": "md", "size": .number(Double(text.utf8.count)), "modifiedAt": .number(modified)]
}

@MainActor final class ArtifactContractTests: XCTestCase {
    private let artifact: JSONValue = ["id": "artifact-1", "name": "Report", "type": "doc", "file_path": ".artifacts/report.md"]
    private func model(_ transport: AppContractTransport, interval: Duration = .seconds(15)) -> ArtifactFileModel {
        ArtifactFileModel(api: transport.api, workspaceID: "workspace-1", artifact: artifact, pollInterval: interval)
    }
    private func eventually(_ condition: () -> Bool) async {
        let deadline = Date().addingTimeInterval(3)
        while !condition(), Date() < deadline { try? await Task.sleep(for: .milliseconds(10)) }
        XCTAssertTrue(condition())
    }

    func testPreviewUsesExactStoredPathAndPreservesQuoteProvenance() async {
        let transport = AppContractTransport { _, _ in .json(artifactPreview()) }
        let reader = model(transport); defer { reader.stop(); transport.close() }
        await reader.refresh()
        XCTAssertEqual(reader.content?.text, "# Draft")
        XCTAssertEqual(transport.requests.first?.query, ["path": ".artifacts/report.md", "preview": "1"])
        XCTAssertEqual(reader.quoteSource, ["type": "artifact", "filePath": ".artifacts/report.md", "name": "Report"])
        XCTAssertFalse(reader.missing)
        XCTAssertFalse(reader.loading)
    }

    func testTransientReadFailureRetainsCachedContentWithWarning() async {
        let transport = AppContractTransport { _, requests in
            requests.count == 1 ? .json(artifactPreview()) : .json(["error": "Temporary outage"], status: 503)
        }
        let reader = model(transport); defer { reader.stop(); transport.close() }
        await reader.refresh(); await reader.refresh()
        XCTAssertEqual(reader.content?.text, "# Draft")
        XCTAssertTrue(reader.showingCachedContent)
        XCTAssertNotNil(reader.error)
        XCTAssertFalse(reader.missing)
    }

    func testNotFoundRemovesPreviouslyLoadedContent() async {
        let transport = AppContractTransport { _, requests in requests.count == 1 ? .json(artifactPreview()) : .json(["error": "Gone"], status: 404) }
        let reader = model(transport); defer { reader.stop(); transport.close() }
        await reader.refresh(); await reader.refresh()
        XCTAssertNil(reader.content); XCTAssertTrue(reader.missing); XCTAssertFalse(reader.showingCachedContent)
    }

    func testOnlyMatchingWatchPathsRefreshAndRemovalClearsContent() async {
        let transport = AppContractTransport { _, requests in .json(artifactPreview("Version \(requests.count)")) }
        let reader = model(transport); defer { reader.stop(); transport.close() }
        await reader.refresh()
        await reader.receive(SSEEvent(event: "artifact_changed", data: ["filePath": "other.md"]))
        XCTAssertEqual(transport.requests.count, 1)
        await reader.receive(SSEEvent(event: "artifact_changed", data: ["filePath": ".artifacts/report.md"]))
        XCTAssertEqual(reader.content?.text, "Version 2")
        await reader.receive(SSEEvent(event: "artifact_removed", data: ["filePath": ".artifacts/report.md"]))
        XCTAssertNil(reader.content); XCTAssertTrue(reader.missing)
        XCTAssertEqual(transport.requests.count, 2)
    }

    func testLateReadCannotResurrectRemovedFile() async {
        let transport = AppContractTransport { _, _ in .delayedJSON(artifactPreview(), status: 200, delay: 0.15) }
        let reader = model(transport); defer { reader.stop(); transport.close() }
        let pending = Task { await reader.refresh() }
        await eventually { !transport.requests.isEmpty }
        await reader.receive(SSEEvent(event: "artifact_removed", data: ["filePath": ".artifacts/report.md"]))
        await pending.value
        XCTAssertNil(reader.content); XCTAssertTrue(reader.missing); XCTAssertFalse(reader.loading)
    }

    func testReadOnlyPollingDoesNotReplaceGlobalWatchDeclarationsAndStops() async {
        let transport = AppContractTransport { request, _ in
            if request.path.hasSuffix("/watch/stream") { return .events([]) }
            return .json(artifactPreview())
        }
        let reader = model(transport, interval: .seconds(1)); defer { reader.stop(); transport.close() }
        reader.start()
        await eventually { transport.requests.filter { $0.path.hasSuffix("/read") }.count >= 2 }
        reader.stop()
        let stoppedCount = transport.requests.count
        try? await Task.sleep(for: .milliseconds(1_150))
        XCTAssertEqual(transport.requests.count, stoppedCount)
        XCTAssertTrue(transport.requests.allSatisfy { $0.method == "GET" })
        XCTAssertFalse(transport.requests.contains { $0.path.hasSuffix("/watch") })
    }

    func testBinaryPreviewErrorDoesNotClaimFileIsMissing() async {
        let transport = AppContractTransport { _, _ in .json(["error": "This binary file cannot be previewed."], status: 415) }
        let reader = model(transport); defer { reader.stop(); transport.close() }
        await reader.refresh()
        XCTAssertNil(reader.content); XCTAssertFalse(reader.missing); XCTAssertNotNil(reader.error)
    }

    func testMalformedPreviewAndWrongPathDoNotBecomeContent() async {
        let transport = AppContractTransport { _, _ in .json(artifactPreview(path: "other-workspace.txt")) }
        let reader = model(transport); defer { reader.stop(); transport.close() }
        await reader.refresh()
        XCTAssertNil(reader.content); XCTAssertNotNil(reader.error)
        var bad = artifactPreview(); bad["imageMime"] = "image/svg+xml"; bad["content"] = "data:image/svg+xml;base64,PHN2Zz4="
        XCTAssertThrowsError(try ArtifactContent(bad, expectedPath: ".artifacts/report.md"))
    }

    func testNativePreviewAllowlistExcludesActiveWebFormats() {
        for filename in ["report.pdf", "image.PNG", "document.docx", "slides.pptx"] { XCTAssertTrue(ArtifactFileModel.canPreviewDownload(filename)) }
        for filename in ["index.html", "image.svg", "code.js", "archive.zip", "file.xhtml"] { XCTAssertFalse(ArtifactFileModel.canPreviewDownload(filename)) }
    }

    func testMissingFileReferenceShowsErrorWithoutStartingTransport() async {
        let transport = AppContractTransport { _, _ in .json(artifactPreview()) }
        let reader = ArtifactFileModel(api: transport.api, workspaceID: "workspace-1", artifact: ["id": "empty", "name": "Missing file"])
        defer { reader.stop(); transport.close() }
        reader.start()
        XCTAssertNotNil(reader.error); XCTAssertTrue(reader.missing); XCTAssertTrue(transport.requests.isEmpty)
    }

    func testInvalidSizeOrTimestampIsRejected() {
        var fractional = artifactPreview(); fractional["size"] = .number(1.5)
        XCTAssertThrowsError(try ArtifactContent(fractional, expectedPath: ".artifacts/report.md"))
        var future = artifactPreview(); future["modifiedAt"] = .number(1e100)
        XCTAssertThrowsError(try ArtifactContent(future, expectedPath: ".artifacts/report.md"))
    }

    func testArtifactListFailurePreservesExistingSnapshot() async {
        var graph = appContractGraph(); graph.raw["contexts"] = .array([artifact])
        let transport = AppContractTransport { _, _ in .json(["error": "Unavailable"], status: 503) }
        defer { transport.close() }
        let library = ArtifactLibraryModel(api: transport.api, graph: graph)
        await library.refresh()
        XCTAssertEqual(library.artifacts, [artifact]); XCTAssertNotNil(library.error)
    }
}
