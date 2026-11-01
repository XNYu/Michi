import Foundation
import MichiCore

struct WorkspaceGraphPoint: Equatable { var x: Double; var y: Double }
struct WorkspaceGraphItem: Identifiable, Equatable {
    let id: String
    let node: JSONValue
    let parentID: String?
    let depth: Int
    let isContext: Bool
    let point: WorkspaceGraphPoint
}
struct WorkspaceGraphConnection: Identifiable, Equatable {
    enum Kind: String { case branch, merge, link }
    let source: String
    let target: String
    let kind: Kind
    var id: String { [kind.rawValue, source, target].map { "\($0.utf8.count):\($0)" }.joined() }
}

/// Read-only projection. Parent pointers (or unambiguous legacy branch edges)
/// establish hierarchy only within a persisted tree. Merge ancestors may be
/// shown as context; links/merges never change ownership or pull in descendants.
struct WorkspaceGraphLayout: Equatable {
    static let cardWidth = 244.0
    static let cardHeight = 126.0
    static let maximumNodes = 240
    let rootID: String
    let nodes: [WorkspaceGraphItem]
    let edges: [WorkspaceGraphConnection]
    let width: Double
    let height: Double
    let omittedNodeCount: Int
    let inputLimited: Bool

    static func make(graph: WorkspaceGraph, treeID: String, limit: Int = 180) -> Self {
        let empty = Self(rootID: "", nodes: [], edges: [], width: 320, height: 240, omittedNodeCount: 0, inputLimited: false)
        guard !graph.id.isEmpty, !graph.isDeleted, graph.workspace["purged_at"].isNull else { return empty }
        let rawNodes = Array(graph.nodes.prefix(10_000)), rawEdges = Array(graph.edges.prefix(40_000))
        let rawTrees = Array(graph.trees.prefix(10_000))
        let limited = graph.nodes.count > rawNodes.count || graph.edges.count > rawEdges.count || graph.trees.count > rawTrees.count
        let duplicates = Set(Dictionary(grouping: rawNodes, by: \.id).filter { $0.value.count != 1 }.keys)
        let trees = Dictionary(grouping: rawTrees, by: \.id).compactMapValues { records -> JSONValue? in
            guard records.count == 1, let tree = records.first, !tree.id.isEmpty,
                  tree["workspace_id"].stringValue == graph.id, tree["archived_at"].isNull else { return nil }
            return tree
        }
        guard let tree = trees[treeID] else { return empty }
        let valid = rawNodes.filter { node in
            !node.id.isEmpty && !duplicates.contains(node.id) && node["workspace_id"].stringValue == graph.id &&
            node["deleted_at"].isNull && node["purged_at"].isNull && node["kind"] == "chat" &&
            node["page_id"].isNull && node["maintenance_job_id"].isNull && trees[node["tree_id"].stringValue] != nil
        }
        let records = Dictionary(uniqueKeysWithValues: valid.map { ($0.id, $0) })
        let rootID = tree["root_node_id"].stringValue
        guard let root = records[rootID], root["tree_id"].stringValue == treeID else { return empty }
        func ordered(_ first: String, _ second: String) -> Bool {
            let a = records[first]?["created_at"].doubleValue ?? 0, b = records[second]?["created_at"].doubleValue ?? 0
            let left = a.isFinite ? a : 0, right = b.isFinite ? b : 0
            return left == right ? first < second : left < right
        }
        let connections = rawEdges.compactMap { edge -> WorkspaceGraphConnection? in
            guard edge["workspace_id"].isNull || edge["workspace_id"].stringValue == graph.id else { return nil }
            let source = edge["source_node_id"].stringValue, target = edge["target_node_id"].stringValue
            guard source != target, records[source] != nil, records[target] != nil else { return nil }
            let rawKind = edge["kind"].stringValue
            guard let kind = WorkspaceGraphConnection.Kind(rawValue: rawKind.isEmpty ? "branch" : rawKind) else { return nil }
            return .init(source: source, target: target, kind: kind)
        }.sorted { $0.id < $1.id }
        var legacyParents: [String: Set<String>] = [:]
        for edge in connections where edge.kind == .branch && records[edge.source]?["tree_id"] == records[edge.target]?["tree_id"] {
            legacyParents[edge.target, default: []].insert(edge.source)
        }
        var parents: [String: String] = [:]
        for node in valid {
            let parent: String?
            if node.objectValue.keys.contains("parent_node_id") { parent = node["parent_node_id"].optionalString }
            else { parent = legacyParents[node.id]?.count == 1 ? legacyParents[node.id]?.first : nil }
            if let parent, parent != node.id, let record = records[parent], record["tree_id"] == node["tree_id"] { parents[node.id] = parent }
        }
        // A persisted root cannot be reparented by a malformed edge/pointer.
        for tree in trees.values { parents.removeValue(forKey: tree["root_node_id"].stringValue) }
        let ownIDs = valid.filter { $0["tree_id"].stringValue == treeID }.map(\.id).sorted(by: ordered)
        let ownSet = Set(ownIDs)
        var children = Dictionary(grouping: ownIDs.filter { parents[$0] != nil }, by: { parents[$0]! })
        for key in Array(children.keys) { children[key]?.sort(by: ordered) }
        let maximum = min(max(1, limit), maximumNodes)
        var visible: [String] = [], seen = Set<String>()
        func walk(_ seed: String) {
            var queue = [seed], index = 0
            while index < queue.count && visible.count < maximum {
                let id = queue[index]; index += 1
                guard ownSet.contains(id), seen.insert(id).inserted else { continue }
                visible.append(id); queue.append(contentsOf: children[id] ?? [])
            }
        }
        walk(rootID)
        for id in ownIDs where visible.count < maximum { if !seen.contains(id) { walk(id) } }

        var contextIDs = Set<String>(), contextOrder: [String] = []
        let sources = Set(connections.filter { $0.kind == .merge && $0.target == rootID }.map(\.source)).sorted(by: ordered)
        var contextLimited = false
        for source in sources {
            var next: String? = source, chain: [String] = [], visited = Set<String>()
            while let id = next, records[id] != nil, !ownSet.contains(id), visited.insert(id).inserted {
                guard chain.count < maximumNodes && contextIDs.count < maximumNodes else { contextLimited = true; break }
                chain.append(id); next = parents[id]
            }
            for id in chain.reversed() where contextIDs.insert(id).inserted { contextOrder.append(id) }
            if contextIDs.count >= maximumNodes { contextLimited = true; break }
        }
        for id in contextOrder where visible.count < maximum { if seen.insert(id).inserted { visible.append(id) } }
        let visibleSet = Set(visible)
        parents = parents.filter { visibleSet.contains($0.key) && visibleSet.contains($0.value) }
        // Break malformed cycles deterministically; do not recurse through data.
        for id in visible.sorted() {
            var current: String? = id, chain: [String] = [], offsets: [String: Int] = [:]
            while let node = current {
                if let start = offsets[node] {
                    if let cut = chain[start...].min() { parents.removeValue(forKey: cut) }
                    break
                }
                offsets[node] = chain.count; chain.append(node); current = parents[node]
            }
        }
        children = Dictionary(grouping: visible.filter { parents[$0] != nil }, by: { parents[$0]! })
        for key in Array(children.keys) { children[key]?.sort(by: ordered) }
        var roots = visible.filter { parents[$0] == nil }.sorted(by: ordered)
        if let index = roots.firstIndex(of: rootID) { roots.remove(at: index); roots.insert(rootID, at: 0) }
        var points: [String: WorkspaceGraphPoint] = [:], depths: [String: Int] = [:], leaf = 0
        let rankGap = 76.0, rowGap = 42.0, padding = 40.0
        for root in roots {
            var stack: [(String, Int, Bool)] = [(root, 0, false)]
            while let (id, depth, finish) = stack.popLast() {
                if !finish {
                    depths[id] = depth; stack.append((id, depth, true))
                    for child in (children[id] ?? []).reversed() { stack.append((child, depth + 1, false)) }
                } else {
                    let kids = children[id] ?? []
                    let y: Double
                    if let first = kids.first.flatMap({ points[$0] }), let last = kids.last.flatMap({ points[$0] }) { y = (first.y + last.y) / 2 }
                    else { y = padding + cardHeight / 2 + Double(leaf) * (cardHeight + rowGap); leaf += 1 }
                    points[id] = .init(x: padding + cardWidth / 2 + Double(depth) * (cardWidth + rankGap), y: y)
                }
            }
            leaf += 1
        }
        let nodes = visible.compactMap { id -> WorkspaceGraphItem? in
            guard let point = points[id], let node = records[id] else { return nil }
            return .init(id: id, node: node, parentID: parents[id], depth: depths[id] ?? 0, isContext: !ownSet.contains(id), point: point)
        }
        var edges = parents.map { WorkspaceGraphConnection(source: $0.value, target: $0.key, kind: .branch) }.sorted { $0.id < $1.id }
        edges += connections.filter { $0.kind != .branch && visibleSet.contains($0.source) && visibleSet.contains($0.target) }
        var edgeIDs = Set<String>(); edges = edges.filter { edgeIDs.insert($0.id).inserted }
        let edgeLimited = edges.count > maximumNodes * 6
        edges = Array(edges.prefix(maximumNodes * 6)).sorted { $0.id < $1.id }
        return .init(rootID: rootID, nodes: nodes, edges: edges,
                     width: max(320, (points.values.map(\.x).max() ?? 0) + cardWidth / 2 + padding),
                     height: max(240, (points.values.map(\.y).max() ?? 0) + cardHeight / 2 + padding),
                     omittedNodeCount: max(0, ownIDs.count + contextIDs.count - nodes.count), inputLimited: limited || contextLimited || edgeLimited)
    }
}

/// Native camera math, kept pure so fit/zoom/clamping can be checked without a
/// Simulator gesture runner. Screen = world * scale + offset.
struct WorkspaceGraphCamera: Equatable {
    var x = 0.0
    var y = 0.0
    var scale = 1.0
    static let zoomRange = 0.004...2.5

    func clamped(layout: WorkspaceGraphLayout, width: Double, height: Double) -> Self {
        guard width.isFinite, height.isFinite, width > 0, height > 0 else { return .init() }
        let zoom = scale.isFinite ? min(Self.zoomRange.upperBound, max(Self.zoomRange.lowerBound, scale)) : 1
        let w = layout.width * zoom, h = layout.height * zoom
        let mx = min(48, w), my = min(48, h)
        return .init(x: min(width - mx, max(mx - w, x.isFinite ? x : 0)),
                     y: min(height - my, max(my - h, y.isFinite ? y : 0)), scale: zoom)
    }
    func zoomed(by factor: Double, anchor: WorkspaceGraphPoint) -> Self {
        guard factor.isFinite, factor > 0, anchor.x.isFinite, anchor.y.isFinite, scale.isFinite, scale > 0 else { return self }
        let zoom = min(Self.zoomRange.upperBound, max(Self.zoomRange.lowerBound, scale * factor)), ratio = zoom / scale
        return .init(x: anchor.x - (anchor.x - x) * ratio, y: anchor.y - (anchor.y - y) * ratio, scale: zoom)
    }
    static func fit(_ layout: WorkspaceGraphLayout, width: Double, height: Double) -> Self {
        guard width.isFinite, height.isFinite, width > 0, height > 0 else { return .init() }
        let zoom = min(1, max(zoomRange.lowerBound, min(max(1, width - 32) / layout.width, max(1, height - 32) / layout.height)))
        return .init(x: (width - layout.width * zoom) / 2, y: (height - layout.height * zoom) / 2, scale: zoom)
    }
}
