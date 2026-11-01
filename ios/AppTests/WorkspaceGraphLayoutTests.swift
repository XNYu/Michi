import Foundation
import XCTest
import MichiCore
#if canImport(Michi)
@testable import Michi
#else
@testable import MichiState
#endif

private func graphNode(_ id: String, tree: String = "tree", parent: String? = nil, created: Double = 1) -> JSONValue {
    ["id": .string(id), "workspace_id": "ws", "tree_id": .string(tree), "parent_node_id": parent.map(JSONValue.string) ?? .null,
     "kind": "chat", "title": .string(id), "created_at": .number(created), "status": "idle"]
}
private func graphEdge(_ source: String, _ target: String, kind: String = "branch", workspace: String = "ws") -> JSONValue {
    ["id": .string(source + ":" + target), "workspace_id": .string(workspace), "source_node_id": .string(source), "target_node_id": .string(target), "kind": .string(kind)]
}
private func graphFixture(nodes: [JSONValue], edges: [JSONValue] = [], otherTrees: [JSONValue] = []) -> WorkspaceGraph {
    WorkspaceGraph(raw: ["workspace": ["id": "ws", "name": "Workspace"], "nodes": .array(nodes), "edges": .array(edges),
                         "trees": .array([["id": "tree", "workspace_id": "ws", "root_node_id": "root"]] + otherTrees)])
}
private func otherGraphTree(_ id: String, root: String) -> JSONValue { ["id": .string(id), "workspace_id": "ws", "root_node_id": .string(root)] }

final class WorkspaceGraphLayoutTests: XCTestCase {
    func testHierarchyUsesPersistedParentsAndPlacesBranchesWithoutOverlapping() {
        let graph = graphFixture(nodes: [graphNode("root"), graphNode("a", parent: "root"), graphNode("b", parent: "root"), graphNode("c", parent: "a")])
        let layout = WorkspaceGraphLayout.make(graph: graph, treeID: "tree")
        XCTAssertEqual(layout.nodes.map(\.id), ["root", "a", "b", "c"])
        XCTAssertEqual(layout.edges.count, 3)
        for node in layout.nodes {
            XCTAssertTrue(node.point.x.isFinite && node.point.y.isFinite)
            XCTAssertGreaterThanOrEqual(node.point.x, WorkspaceGraphLayout.cardWidth / 2)
            XCTAssertLessThanOrEqual(node.point.x + WorkspaceGraphLayout.cardWidth / 2, layout.width)
            if let parentID = node.parentID, let parent = layout.nodes.first(where: { $0.id == parentID }) {
                XCTAssertGreaterThan(node.point.x - parent.point.x, WorkspaceGraphLayout.cardWidth)
                XCTAssertEqual(node.depth, parent.depth + 1)
            }
            for other in layout.nodes where other.id != node.id {
                XCTAssertTrue(abs(node.point.x - other.point.x) >= WorkspaceGraphLayout.cardWidth || abs(node.point.y - other.point.y) >= WorkspaceGraphLayout.cardHeight)
            }
        }
    }

    func testWorkspaceAndHelperVisibilityFiltersFailClosed() {
        let excluded = [graphNode("foreign").merging(["workspace_id": "other"]), graphNode("deleted").merging(["deleted_at": 1]),
                        graphNode("purged").merging(["purged_at": 1]), graphNode("page").merging(["page_id": "page-1"]),
                        graphNode("maintenance").merging(["maintenance_job_id": "job"]), graphNode("digest").merging(["kind": "digest"]),
                        graphNode("artifact").merging(["kind": "artifact"]), graphNode("missing-tree", tree: "absent")]
        let graph = graphFixture(nodes: [graphNode("root"), graphNode("valid", parent: "root")] + excluded,
                                 edges: excluded.map { graphEdge("root", $0.id) })
        let layout = WorkspaceGraphLayout.make(graph: graph, treeID: "tree")
        XCTAssertEqual(layout.nodes.map(\.id), ["root", "valid"])
        XCTAssertEqual(layout.edges.map(\.target), ["valid"])
    }

    func testLinkAndOutgoingMergeNeverPullOtherThreadsIntoOwnership() {
        let graph = graphFixture(nodes: [graphNode("root"), graphNode("child", parent: "root"), graphNode("other", tree: "other"), graphNode("other-child", tree: "other", parent: "other")],
                                 edges: [graphEdge("root", "other", kind: "link"), graphEdge("child", "other", kind: "merge"), graphEdge("root", "other-child")],
                                 otherTrees: [otherGraphTree("other", root: "other")])
        let layout = WorkspaceGraphLayout.make(graph: graph, treeID: "tree")
        XCTAssertEqual(layout.nodes.map(\.id), ["root", "child"])
        XCTAssertEqual(layout.edges.count, 1)
        XCTAssertTrue(layout.nodes.allSatisfy { !$0.isContext })
    }

    func testIncomingMergeShowsOnlyLiveSourceAncestorsAsNonOwningContext() {
        let graph = graphFixture(nodes: [graphNode("root"), graphNode("child", parent: "root"), graphNode("source-root", tree: "source"),
                                        graphNode("source", tree: "source", parent: "source-root"), graphNode("sibling", tree: "source", parent: "source-root"),
                                        graphNode("source-child", tree: "source", parent: "source")],
                                 edges: [graphEdge("source", "root", kind: "merge"), graphEdge("source", "child", kind: "link")],
                                 otherTrees: [otherGraphTree("source", root: "source-root")])
        let layout = WorkspaceGraphLayout.make(graph: graph, treeID: "tree")
        XCTAssertEqual(layout.nodes.map(\.id), ["root", "child", "source-root", "source"])
        XCTAssertEqual(layout.nodes.filter(\.isContext).map(\.id), ["source-root", "source"])
        XCTAssertNil(layout.nodes.first { $0.id == "root" }?.parentID)
        XCTAssertEqual(layout.nodes.first { $0.id == "source" }?.parentID, "source-root")
        XCTAssertTrue(layout.edges.contains { $0.kind == .merge && $0.source == "source" && $0.target == "root" })
        XCTAssertTrue(layout.edges.contains { $0.kind == .link && $0.target == "child" })
    }

    func testForeignOrArchivedMergeSourceCannotBecomeVisible() {
        let graph = graphFixture(nodes: [graphNode("root"), graphNode("archived-source", tree: "archived"), graphNode("live-source", tree: "live")],
                                 edges: [graphEdge("archived-source", "root", kind: "merge"), graphEdge("live-source", "root", kind: "merge", workspace: "foreign")],
                                 otherTrees: [otherGraphTree("archived", root: "archived-source").merging(["archived_at": 1]), otherGraphTree("live", root: "live-source")])
        XCTAssertEqual(WorkspaceGraphLayout.make(graph: graph, treeID: "tree").nodes.map(\.id), ["root"])
    }

    func testMissingOrArchivedRootCannotInventAThread() {
        var graph = graphFixture(nodes: [graphNode("child", parent: "root")])
        XCTAssertTrue(WorkspaceGraphLayout.make(graph: graph, treeID: "tree").nodes.isEmpty)
        graph.raw["nodes"] = [graphNode("root")]
        graph.raw["trees"] = [otherGraphTree("tree", root: "root").merging(["archived_at": 1])]
        XCTAssertTrue(WorkspaceGraphLayout.make(graph: graph, treeID: "tree").nodes.isEmpty)
        graph.raw["trees"] = [otherGraphTree("tree", root: "root")]
        graph.raw["workspace"] = graph.workspace.merging(["deleted_at": 1])
        XCTAssertTrue(WorkspaceGraphLayout.make(graph: graph, treeID: "tree").nodes.isEmpty)
    }

    func testExplicitParentWinsOverStaleEdgesAndLegacyFallbackMustBeUnambiguous() {
        let legacy = JSONValue.object(graphNode("legacy").objectValue.filter { $0.key != "parent_node_id" })
        let ambiguous = JSONValue.object(graphNode("ambiguous").objectValue.filter { $0.key != "parent_node_id" })
        let graph = graphFixture(nodes: [graphNode("root"), graphNode("a", parent: "root"), graphNode("b", parent: "a"), graphNode("explicit-null"), legacy, ambiguous],
                                 edges: [graphEdge("root", "b"), graphEdge("root", "explicit-null"), graphEdge("root", "legacy"), graphEdge("root", "ambiguous"), graphEdge("a", "ambiguous")])
        let layout = WorkspaceGraphLayout.make(graph: graph, treeID: "tree")
        XCTAssertEqual(layout.nodes.first { $0.id == "b" }?.parentID, "a")
        XCTAssertEqual(layout.nodes.first { $0.id == "legacy" }?.parentID, "root")
        XCTAssertNil(layout.nodes.first { $0.id == "explicit-null" }?.parentID)
        XCTAssertNil(layout.nodes.first { $0.id == "ambiguous" }?.parentID)
    }

    func testCyclesAndDuplicateIDsCannotCrashOrReparentTheRoot() {
        let graph = graphFixture(nodes: [graphNode("root", parent: "a"), graphNode("a", parent: "b"), graphNode("b", parent: "a"), graphNode("duplicate"), graphNode("duplicate")])
        let layout = WorkspaceGraphLayout.make(graph: graph, treeID: "tree")
        XCTAssertEqual(Set(layout.nodes.map(\.id)), ["root", "a", "b"])
        XCTAssertNil(layout.nodes.first { $0.id == "root" }?.parentID)
        XCTAssertNil(layout.nodes.first { $0.id == "a" }?.parentID)
        XCTAssertEqual(layout.nodes.first { $0.id == "b" }?.parentID, "a")
        XCTAssertTrue(layout.nodes.allSatisfy { $0.depth <= 1 })
    }

    func testLayoutIsStableAcrossSnapshotAndEdgeOrdering() {
        let nodes = [graphNode("root"), graphNode("a", parent: "root"), graphNode("b", parent: "root"), graphNode("c", parent: "a")]
        let edges = [graphEdge("b", "c", kind: "link"), graphEdge("a", "b", kind: "merge"), graphEdge("root", "a")]
        let first = WorkspaceGraphLayout.make(graph: graphFixture(nodes: nodes, edges: edges), treeID: "tree")
        let reordered = WorkspaceGraphLayout.make(graph: graphFixture(nodes: Array(nodes.reversed()), edges: Array(edges.reversed())), treeID: "tree")
        XCTAssertEqual(first, reordered)
    }

    func testLargeGraphsBoundNodesAndConnectionsWhileKeepingRoot() {
        let nodes = [graphNode("root")] + (0..<400).map { graphNode("n\($0)", parent: "root", created: Double($0 + 2)) }
        let graph = graphFixture(nodes: nodes)
        let bounded = WorkspaceGraphLayout.make(graph: graph, treeID: "tree", limit: 100_000)
        XCTAssertEqual(bounded.nodes.count, WorkspaceGraphLayout.maximumNodes)
        XCTAssertEqual(bounded.nodes.first?.id, "root")
        XCTAssertEqual(bounded.omittedNodeCount, 401 - WorkspaceGraphLayout.maximumNodes)
        XCTAssertEqual(WorkspaceGraphLayout.make(graph: graph, treeID: "tree", limit: 0).nodes.map(\.id), ["root"])
        let subset = Array(nodes.prefix(50))
        let edges = subset.flatMap { first in subset.filter { $0.id != first.id }.map { graphEdge(first.id, $0.id, kind: "link") } }
        let dense = WorkspaceGraphLayout.make(graph: graphFixture(nodes: subset, edges: edges), treeID: "tree")
        XCTAssertLessThanOrEqual(dense.edges.count, WorkspaceGraphLayout.maximumNodes * 6)
        XCTAssertEqual(dense.edges.filter { $0.kind == .branch }.count, 49)
        XCTAssertTrue(dense.inputLimited)
    }

    func testCameraZoomKeepsAnchorAndClampsPanWithoutLosingAllContent() {
        let camera = WorkspaceGraphCamera(x: 20, y: -10, scale: 1)
        let anchor = WorkspaceGraphPoint(x: 150, y: 200)
        let next = camera.zoomed(by: 2, anchor: anchor)
        XCTAssertEqual((anchor.x - camera.x) / camera.scale, (anchor.x - next.x) / next.scale, accuracy: 0.00001)
        XCTAssertEqual((anchor.y - camera.y) / camera.scale, (anchor.y - next.y) / next.scale, accuracy: 0.00001)
        let layout = WorkspaceGraphLayout.make(graph: graphFixture(nodes: [graphNode("root"), graphNode("child", parent: "root")]), treeID: "tree")
        let clamped = WorkspaceGraphCamera(x: -1e9, y: 1e9, scale: 100).clamped(layout: layout, width: 350, height: 450)
        XCTAssertEqual(clamped.scale, WorkspaceGraphCamera.zoomRange.upperBound)
        XCTAssertGreaterThanOrEqual(clamped.x + layout.width * clamped.scale, 48)
        XCTAssertLessThanOrEqual(clamped.y, 450 - 48)
        let fit = WorkspaceGraphCamera.fit(layout, width: 350, height: 450)
        XCTAssertLessThanOrEqual(layout.width * fit.scale, 350)
        XCTAssertLessThanOrEqual(layout.height * fit.scale, 450)
        XCTAssertEqual(camera.zoomed(by: .nan, anchor: anchor), camera)
        let invalid = WorkspaceGraphCamera(x: .infinity, y: .nan, scale: .nan).clamped(layout: layout, width: 350, height: 450)
        XCTAssertTrue(invalid.x.isFinite && invalid.y.isFinite && invalid.scale.isFinite)
    }
}
