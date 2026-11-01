import Foundation
import MichiCore

struct ProbeFailure: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}
func require(_ condition: Bool, _ message: String) throws {
    if !condition { throw ProbeFailure(message: message) }
}

@main struct ContractProbe {
    static func main() async throws {
        guard CommandLine.arguments.count == 2,
              let url = URL(string: CommandLine.arguments[1]), url.host == "127.0.0.1", url.scheme == "http" else {
            throw ProbeFailure(message: "Use only the loopback address from the isolated backend harness.")
        }
        let api = MichiAPI(baseURL: url)
        let harness = try await api.request("/native-contract-harness")
        try require(harness["kind"] == "michi-native-contract-harness" && harness["isolated"] == true,
                    "Refusing writes: this endpoint is not the disposable contract harness.")
        let caps = try await api.request("/persistence/capabilities")
        try require(caps["explicitCommands"].boolValue, "Explicit graph commands unavailable")
        let workspaceID = "ws-native-" + UUID().uuidString.lowercased()
        let treeID = "tree-" + UUID().uuidString.lowercased()
        let workspace: JSONValue = ["id": .string(workspaceID), "name": "Native contract fixture", "created_at": 1]
        _ = try await api.request("/workspaces/\(workspaceID)/commands", method: "POST", body: ["operationId": .string(UUID().uuidString), "commands": [["type": "workspace.upsert", "payload": workspace]]])
        let allocation = try await api.request("/node-ids/allocate", method: "POST", body: ["count": 1])
        let nodeID = allocation["nodeIds"].arrayValue.first?.stringValue ?? ""
        try require(!nodeID.isEmpty, "Node allocation failed")
        _ = try await api.request("/workspaces/\(workspaceID)/graph/nodes/ensure", method: "POST", body: [
            "workspace": ["id": .string(workspaceID), "name": "Native contract fixture", "cwd": .null, "createdAt": 1, "activeTreeId": .string(treeID)],
            "tree": ["id": .string(treeID), "rootNodeId": .string(nodeID), "createdAt": 1, "lastActiveAt": 1],
            "node": ["id": .string(nodeID), "treeId": .string(treeID), "parentNodeId": .null, "kind": "chat", "title": "Native conversation", "createdAt": 1],
            "edges": []
        ])
        let snapshot = try await api.request("/workspaces/all?meta=1")
        let graph = snapshot["workspaces"].arrayValue.first { $0["workspace"].id == workspaceID } ?? .null
        try require(graph["nodes"].arrayValue.contains { $0.id == nodeID && $0["tree_id"].stringValue == treeID }, "Graph identity mismatch")
        let history = try await api.request("/workspaces/\(workspaceID)/trees/\(treeID)/messages")
        try require(history["messages"].arrayValue.isEmpty, "New thread unexpectedly has history")
        let page = try await api.request("/workspaces/\(workspaceID)/pages", method: "POST", body: ["title": "Native page"])
        try require(!page.id.isEmpty && page["revision"].intValue > 0, "Page creation shape mismatch")
        let edits = try await api.request("/pages/\(MichiAPI.pathSegment(page.id))/edits", method: "POST", body: ["revision": page["revision"], "ops": [["op": "insert", "after": .null, "block": ["type": "markdown", "text": "Native Swift transport → real Michi persistence"]]]])
        let block = edits["page"]["blocks"].arrayValue.first { $0["text"].stringValue == "Native Swift transport → real Michi persistence" } ?? .null
        try require(block["text"].stringValue == "Native Swift transport → real Michi persistence", "Page edit was not persisted")
        let opened = try await api.request("/workspaces/\(workspaceID)/task-database", method: "POST", body: [:])
        try require(!opened["database"].id.isEmpty, "Task database creation shape mismatch")
        let found = try await api.request("/workspaces/\(workspaceID)/task-database")
        try require(found["databaseId"] == opened["database"]["id"], "Task database identity mismatch")
        let ownDraft: JSONValue = ["value": "Phone draft", "mentions": []]
        let webDraft: JSONValue = ["value": "Browser draft", "mentions": []]
        for (window, draft) in [("ios-probe", ownDraft), ("web-probe", webDraft)] {
            _ = try await api.request("/workspaces/\(workspaceID)/commands", method: "POST", body: ["operationId": .string(UUID().uuidString), "commands": [["type": "node.patch", "payload": ["id": .string(nodeID), "composer_draft_window_id": .string(window), "composer_draft": .string(draft.prettyPrinted)]]]])
        }
        let draftGraph = try await api.request("/workspaces/\(workspaceID)")
        let draftSlots = draftGraph["nodes"].arrayValue.first { $0.id == nodeID }?["composer_draft"].parsedJSON["__michiWindowDrafts"] ?? .null
        try require(draftSlots["ios-probe"].parsedJSON["value"] == "Phone draft" && draftSlots["web-probe"].parsedJSON["value"] == "Browser draft", "Window-scoped draft preservation failed")
        let database = opened["database"], databaseID = MichiAPI.pathSegment(database.id)
        let rowResult = try await api.request("/databases/\(databaseID)/edits", method: "POST", body: ["revision": database["revision"], "ops": [["op": "row.add", "values": ["task": "Native task", "status": "todo", "threads": [.string(nodeID)]]]]])
        let savedDatabase = rowResult["database"]
        let task = savedDatabase["rows"].arrayValue.first { $0["values"]["task"] == "Native task" } ?? .null
        try require(!task.id.isEmpty && task["values"]["threads"].arrayValue == [.string(nodeID)], "Task/threads shape mismatch")
        let updated = try await api.request("/databases/\(databaseID)/edits", method: "POST", body: ["revision": savedDatabase["revision"], "ops": [["op": "row.update", "id": task["id"], "expectRev": task["rev"], "values": ["status": "doing"]]]])
        try require(updated["database"]["rows"].arrayValue.first { $0.id == task.id }?["values"]["status"] == "doing", "Native board move failed")
        let allTasks = try await api.request("/spaces-home/all-tasks")
        try require(allTasks["sources"].arrayValue.contains { $0["databaseId"] == database["id"] }, "All Tasks source ownership mismatch")
        try require(allTasks["rows"].arrayValue.contains { $0["databaseId"] == database["id"] && $0["row"].id == task.id }, "All Tasks row shape mismatch")
        let historyChanges = try await api.request("/pages/\(MichiAPI.pathSegment(page.id))/changes?direction=backward&limit=50")
        try require(!historyChanges["changes"].arrayValue.isEmpty, "Page history is unavailable")
        _ = try await api.request("/pages/\(MichiAPI.pathSegment(page.id))", method: "DELETE", body: [:])
        let trash = try await api.request("/workspaces/\(workspaceID)/pages/trash")
        try require(trash["items"].arrayValue.contains { $0["root"].id == page.id }, "Page trash group shape mismatch")
        _ = try await api.request("/pages/\(MichiAPI.pathSegment(page.id))/restore", method: "POST", body: [:])
        let restored = try await api.request("/pages/\(MichiAPI.pathSegment(page.id))")
        try require(restored.id == page.id, "Page restore identity mismatch")
        try await componentAndDatabaseContracts(api: api, workspaceID: workspaceID, pageID: page.id)
        try require(caps["digestReadMarkers"] == "v1", "Atomic digest read-marker capability unavailable")
        let digestIDs = try await api.request("/node-ids/allocate", method: "POST", body: ["count": 2])["nodeIds"].arrayValue
        try require(digestIDs.count == 2, "Digest fixture allocation failed")
        let digestID = digestIDs[0].stringValue, followUpID = digestIDs[1].stringValue
        let digest: JSONValue = ["status": "idle", "generatedAt": 1_000, "viewedAt": 0, "content": "# Contract digest\n\n## Open Questions\n- What next?", "sources": [.string(nodeID)], "opaque": ["keep": true]]
        _ = try await api.request("/workspaces/\(workspaceID)/commands", method: "POST", body: ["operationId": .string(UUID().uuidString), "commands": [["type": "node.upsert", "payload": ["id": .string(digestID), "workspace_id": .string(workspaceID), "tree_id": .null, "parent_node_id": .null, "kind": "digest", "created_at": 1, "digest": .string(digest.prettyPrinted)]]]])
        let readPath = "/workspaces/\(workspaceID)/nodes/\(digestID)/digest/viewed"
        let read = try await api.request(readPath, method: "POST", body: ["generatedAt": 1_000])
        let readAgain = try await api.request(readPath, method: "POST", body: ["generatedAt": 1_000])
        try require(read["viewedAt"].doubleValue >= 1_000 && readAgain["viewedAt"] == read["viewedAt"] && !readAgain["changed"].boolValue, "Digest marker is not idempotent")
        var rebuilt = digest; rebuilt["generatedAt"] = 2_000; rebuilt["content"] = "A newer digest"
        _ = try await api.request("/workspaces/\(workspaceID)/commands", method: "POST", body: ["operationId": .string(UUID().uuidString), "commands": [["type": "node.patch", "payload": ["id": .string(digestID), "digest": .string(rebuilt.prettyPrinted)]]]])
        do {
            _ = try await api.request(readPath, method: "POST", body: ["generatedAt": 1_000])
            throw ProbeFailure(message: "A stale generation marked a newer digest read")
        } catch let failure as MichiAPIError { try require(failure.statusCode == 409, "Expected a stale digest generation conflict") }
        let opaqueReference: JSONValue = ["version": 1, "digestId": .string(digestID), "contentHash": "probe-preserved-opaque-reference"]
        let followUpDraft: JSONValue = ["value": "What next?", "mentions": [], "__michiDigestFollowUp": opaqueReference]
        _ = try await api.request("/workspaces/\(workspaceID)/graph/nodes/ensure", method: "POST", body: [
            "workspace": ["id": .string(workspaceID), "name": "Native contract fixture", "createdAt": 1, "activeTreeId": .string(treeID)],
            "node": ["id": .string(followUpID), "treeId": .string(treeID), "parentNodeId": .string(nodeID), "kind": "chat", "title": "Digest follow-up", "createdAt": 2, "composerDraft": .string(followUpDraft.prettyPrinted)],
            "edges": [["id": .string("branch-" + followUpID), "sourceNodeId": .string(nodeID), "targetNodeId": .string(followUpID), "kind": "branch", "createdAt": 2],
                      ["id": .string("link-" + followUpID), "sourceNodeId": .string(digestID), "targetNodeId": .string(followUpID), "kind": "link", "createdAt": 2]]
        ])
        _ = try await api.request("/workspaces/\(workspaceID)/commands", method: "POST", body: ["operationId": .string(UUID().uuidString), "commands": [["type": "node.patch", "payload": ["id": .string(followUpID), "composer_draft_window_id": "ios-follow-up-probe", "composer_draft": .string(ownDraft.prettyPrinted)]]]])
        let digestGraph = try await api.request("/workspaces/\(workspaceID)")
        let freshDigest = digestGraph["nodes"].arrayValue.first { $0.id == digestID }?["digest"].parsedJSON ?? .null
        let followUp = digestGraph["nodes"].arrayValue.first { $0.id == followUpID } ?? .null
        try require(freshDigest == rebuilt, "Stale read marker changed newer digest content or metadata")
        try require(followUp["parent_node_id"].stringValue == nodeID && followUp["tree_id"].stringValue == treeID && followUp["composer_draft"].parsedJSON["__michiDigestFollowUp"] == opaqueReference, "Digest follow-up ownership or durable reference was lost")
        try require(digestGraph["edges"].arrayValue.contains { $0["source_node_id"].stringValue == digestID && $0["target_node_id"].stringValue == followUpID && $0["kind"] == "link" }, "Digest non-owning link was not saved")
        print("PASS: atomic digest read receipts preserve newer content; source-root follow-up and non-owning link retain opaque context metadata across window draft updates.")
        if caps["conditionalTrashPurge"] == "v1" {
            func patchNode(_ fields: [String: JSONValue]) async throws {
                _ = try await api.request("/workspaces/\(workspaceID)/commands", method: "POST", body: ["operationId": .string(UUID().uuidString), "commands": [["type": "node.patch", "payload": .object(fields.merging(["id": .string(nodeID)]) { _, new in new })]]])
            }
            _ = try await api.request("/workspaces/\(workspaceID)/commands", method: "POST", body: ["operationId": .string(UUID().uuidString), "commands": [["type": "node.patch", "payload": ["id": .string(followUpID), "deleted_at": 90, "deletion_group_id": "del-follow-up-probe"]]]])
            _ = try await api.request("/workspaces/\(workspaceID)/nodes", method: "DELETE", body: ["nodeIds": [.string(followUpID)], "expectedNodes": [["id": .string(followUpID), "deletedAt": 90, "deletionGroupId": "del-follow-up-probe"]]])
            try await patchNode(["deleted_at": 100, "deletion_group_id": "del-native-probe"])
            let stale: JSONValue = ["nodeIds": [.string(nodeID)], "expectedNodes": [["id": .string(nodeID), "deletedAt": 100, "deletionGroupId": "del-native-probe"]]]
            try await patchNode(["deleted_at": .null, "deletion_group_id": .null])
            do {
                _ = try await api.request("/workspaces/\(workspaceID)/nodes", method: "DELETE", body: stale)
                throw ProbeFailure(message: "Restored node was permanently deleted")
            } catch let failure as MichiAPIError { try require(failure.statusCode == 409 && (failure.code ?? failure.message) == "purge_conflict", "Conditional purge conflict shape mismatch") }
            try await patchNode(["deleted_at": 200, "deletion_group_id": "del-native-probe"])
            var current = stale; current["expectedNodes"] = [["id": .string(nodeID), "deletedAt": 200, "deletionGroupId": "del-native-probe"]]
            _ = try await api.request("/workspaces/\(workspaceID)/nodes", method: "DELETE", body: current)
            let finalGraph = try await api.request("/workspaces/\(workspaceID)")
            try require(!finalGraph["nodes"].arrayValue.contains { $0.id == nodeID }, "Conditional node purge did not remove the expected node")
            _ = try await api.request("/workspaces/\(workspaceID)/commands", method: "POST", body: ["operationId": .string(UUID().uuidString), "commands": [["type": "workspace.upsert", "payload": ["id": .string(workspaceID), "active_tree_id": .null, "deleted_at": 300]]]])
            do {
                _ = try await api.request("/workspaces/\(workspaceID)", method: "DELETE", body: ["expectedDeletedAt": 299])
                throw ProbeFailure(message: "Stale workspace marker permitted permanent deletion")
            } catch let failure as MichiAPIError { try require(failure.statusCode == 409 && (failure.code ?? failure.message) == "purge_conflict", "Workspace purge conflict shape mismatch") }
            _ = try await api.request("/workspaces/\(workspaceID)", method: "DELETE", body: ["expectedDeletedAt": 300])
            print("PASS: conditional Trash purge rejects restored nodes/stale workspace markers and accepts matching deletion snapshots.")
        }
        print("PASS: native URLSession → production API routes: capabilities, graph hydration, window-scoped drafts, page creation/edit/history/trash/restore, task database row creation/threads/revision update and All Tasks ownership. All data isolated; no real agent invoked.")
    }

    /// These are the wire envelopes produced by NativeComponentLibraryModel,
    /// PageModel.insertBlock, DatabaseOrdering and DatabaseManagement. This
    /// executable deliberately depends only on MichiCore, not SwiftUI models.
    /// A failed/ambiguous mutation aborts the run; no POST or DELETE is retried.
    static func componentAndDatabaseContracts(api: MichiAPI, workspaceID: String, pageID: String) async throws {
        let libraryPath = "/workspaces/\(MichiAPI.pathSegment(workspaceID))/components"
        let query = "?workspaceId=" + MichiAPI.queryComponent(workspaceID)
        let empty = try await api.request(libraryPath)
        try require(empty["revision"] == 0 && empty["items"].arrayValue.isEmpty, "New workspace component library is not empty")
        let code1 = "export default function Component() { return 'Stored fixture v1'; }"
        let code2 = "export default function Component() { return 'Stored fixture v2'; }"
        let schema: JSONValue = ["type": "object", "additionalProperties": true]
        let input1: JSONValue = ["name": "native-contract", "description": "Native contract fixture", "code": .string(code1), "propsSchema": schema]
        let created = try await api.request(libraryPath, method: "POST", body: ["input": input1, "expectedLibraryRevision": empty["revision"]])
        var component = created["component"]
        try require(!component.id.isEmpty && component["workspaceId"].stringValue == workspaceID && !component["ownerUserId"].stringValue.isEmpty,
                    "Component create identity mismatch")
        try require(created["revision"] == 1 && component["libraryRevision"] == 1 && component["activeVersion"] == 1 && component["versions"] == 1 && component["enabled"] == true && component["revocationEpoch"] == 1,
                    "Component create revision/state mismatch")
        let componentPath = "/components/\(MichiAPI.pathSegment(component.id))"
        let v1 = try await api.request(componentPath + query + "&version=1")
        try require(v1 == created["version"] && v1["code"].stringValue == code1 && v1["propsSchema"] == schema && v1["source"] == ["kind": "user"],
                    "Component v1 source/schema/attribution mismatch")
        var input2 = input1; input2["code"] = .string(code2); input2["description"] = "Second immutable version"
        let saved = try await api.request(libraryPath, method: "POST", body: ["input": input2, "expectedLibraryRevision": created["revision"]])
        try require(saved["component"].id == component.id && saved["revision"] == 2 && saved["component"]["libraryRevision"] == 2
                    && saved["component"]["versions"] == 2 && saved["component"]["activeVersion"] == 2 && saved["component"]["revocationEpoch"] == 2,
                    "Same-name save did not append an immutable version to the same component")
        component = saved["component"]
        let unchangedV1 = try await api.request(componentPath + query + "&version=1")
        let v2 = try await api.request(componentPath + query)
        try require(unchangedV1 == v1 && v2 == saved["version"] && v2["code"].stringValue == code2 && v2["source"] == ["kind": "user"],
                    "Saving v2 overwrote v1 or did not activate the new source")
        let libraryBeforeRejections = try await api.request(libraryPath)
        try require(libraryBeforeRejections["items"].arrayValue == [component], "Same-name save duplicated the library entry")
        try await rejection(status: 409, code: "stale_revision", label: "Stale component save") {
            try await api.request(libraryPath, method: "POST", body: ["input": input1, "expectedLibraryRevision": 1])
        }
        try await rejection(status: 400, code: "invalid", label: "Caller-supplied component attribution") {
            try await api.request(libraryPath, method: "POST", body: ["input": input1, "expectedLibraryRevision": 2, "source": ["kind": "user"]])
        }
        let afterRejections = try await api.request(libraryPath)
        try require(afterRejections == libraryBeforeRejections, "Rejected component writes changed the library")

        let props: JSONValue = ["title": "原生契约", "opaque": ["items": [1, true, .null, ["nested": "kept"]], "ratio": .number(0.125)], "enabled": false]
        let pagePath = "/pages/\(MichiAPI.pathSegment(pageID))"
        let page = try await api.request(pagePath)
        let nativeBlock: JSONValue = ["type": "component", "componentId": .string(component.id), "pinnedVersion": 2, "props": props]
        let insertion = try await api.request(pagePath + "/edits", method: "POST", body: ["revision": page["revision"], "ops": [["op": "insert", "block": nativeBlock, "after": page["blocks"].arrayValue.last?["id"] ?? .null]]])
        let insertedPage = try await api.request(pagePath)
        let inserted = insertedPage["blocks"].arrayValue.filter { $0["type"] == "component" && $0["componentId"] == component["id"] }
        try require(insertedPage == insertion["page"] && inserted.count == 1 && !inserted[0].id.isEmpty && inserted[0]["pinnedVersion"] == 2 && inserted[0]["props"] == props,
                    "Explicit native component insertion lost its pin/props or inserted more than once")
        try require(page["blocks"].arrayValue.allSatisfy { original in insertedPage["blocks"].arrayValue.contains(original) }, "Component insertion changed an existing page block")
        let database = try await databaseManagementContracts(api: api, workspaceID: workspaceID, componentID: component.id, props: props)
        let references = try await api.request(componentPath + "/references" + query)["items"].arrayValue
        try require(references.count == 2 && references.allSatisfy { $0["workspaceId"].stringValue == workspaceID && $0["componentId"] == component["id"] && $0["pinnedVersion"] == 2 && $0["protected"] == true && $0["hostRevision"].intValue > 0 },
                    "Native component references did not retain ownership and explicit version protection")
        try require(references.contains { $0["kind"] == "page_block" && $0["pageId"].stringValue == pageID && $0["blockId"] == inserted[0]["id"] }
                    && references.contains { $0["kind"] == "database_view" && $0["databaseId"].stringValue == database.id && $0["viewId"] == "view-native-custom" },
                    "Page/database component usage did not resolve to the actual hosts")

        func action(_ name: String, version: JSONValue? = nil) async throws {
            let before = component
            var body: JSONValue = ["workspaceId": .string(workspaceID), "expectedLibraryRevision": before["libraryRevision"]]
            if let version { body["version"] = version }
            let next = try await api.request(componentPath + (name == "delete" ? "" : "/" + name), method: name == "delete" ? "DELETE" : "POST", body: body)
            try require(next.id == before.id && next["ownerUserId"] == before["ownerUserId"] && next["workspaceId"] == before["workspaceId"] && next["versions"] == 2
                        && next["createdAt"] == before["createdAt"] && next["libraryRevision"].intValue == before["libraryRevision"].intValue + 1
                        && next["revocationEpoch"].intValue == before["revocationEpoch"].intValue + 1, "Component \(name) receipt identity/revision mismatch")
            if let version { try require(next["activeVersion"] == version && next["enabled"] == true, "Component \(name) did not select the requested version") }
            else { try require(next["activeVersion"] == before["activeVersion"], "Component \(name) changed its active version") }
            let list = try await api.request(libraryPath)
            try require(list["revision"] == next["libraryRevision"], "Component \(name) receipt did not persist")
            if name == "delete" {
                try require(next["enabled"] == false && !next["deletedAt"].isNull && list["items"].arrayValue.isEmpty, "Component deletion was not persisted")
            } else {
                try require(list["items"].arrayValue == [next] && next["deletedAt"].isNull, "Component \(name) did not match the saved library")
                if name == "enable" || name == "disable" { try require(next["enabled"] == .bool(name == "enable"), "Component \(name) did not change enabled state") }
            }
            component = next
        }
        try await action("disable")
        let disabled = try await api.request(libraryPath)
        try await rejection(status: 404, code: "not_found", label: "Disabled component source read") { try await api.request(componentPath + query) }
        try await rejection(status: 409, code: "stale_revision", label: "Stale component enable") {
            try await api.request(componentPath + "/enable", method: "POST", body: ["workspaceId": .string(workspaceID), "expectedLibraryRevision": 2])
        }
        try await rejection(status: 409, code: "stale_revision", label: "Activation while disabled") {
            try await api.request(componentPath + "/activate", method: "POST", body: ["workspaceId": .string(workspaceID), "expectedLibraryRevision": disabled["revision"], "version": 1])
        }
        let stillDisabled = try await api.request(libraryPath)
        try require(stillDisabled == disabled, "A rejected action consumed a library revision or enabled the component")
        try await action("enable")
        let enabled = try await api.request(libraryPath)
        for name in ["disable", "activate", "rollback", "delete"] {
            var staleBody: JSONValue = ["workspaceId": .string(workspaceID), "expectedLibraryRevision": 2]
            if name == "activate" || name == "rollback" { staleBody["version"] = 1 }
            try await rejection(status: 409, code: "stale_revision", label: "Stale component \(name)") {
                try await api.request(componentPath + (name == "delete" ? "" : "/" + name), method: name == "delete" ? "DELETE" : "POST", body: staleBody)
            }
        }
        let afterStaleActions = try await api.request(libraryPath)
        try require(afterStaleActions == enabled, "Stale component actions changed an active library entry")
        try await action("activate", version: 1)
        let active1 = try await api.request(componentPath + query)
        try require(active1 == v1, "Activate did not select immutable v1")
        let pinnedPage = try await api.request(pagePath)
        let pinnedDatabase = try await api.request("/databases/\(MichiAPI.pathSegment(database.id))")
        try require(pinnedPage["blocks"].arrayValue.first { $0.id == inserted[0].id }?["pinnedVersion"] == 2
                    && pinnedDatabase["views"].arrayValue.first { $0.id == "view-native-custom" }?["config"]["pinnedVersion"] == 2,
                    "Activating an older library version rewrote an explicitly pinned native host")
        try await action("rollback", version: 2)
        let active2 = try await api.request(componentPath + query)
        try require(active2 == v2, "Rollback did not select the requested immutable version")
        try await action("delete")
        try await rejection(status: 404, code: "not_found", label: "Deleted component source read") { try await api.request(componentPath + query + "&version=1") }
        let retainedReferences = try await api.request(componentPath + "/references" + query)
        try require(retainedReferences["items"].arrayValue.count == 2, "Deleting a library entry cascaded into its page/database hosts")
        print("PASS: real component routes accept native library save/list/read/references, preserve immutable same-name versions and source attribution, reject stale revisions, and honor disable/enable/activate/rollback/delete plus explicitly pinned page/custom-view hosts. Stored source was never executed.")
    }

    static func databaseManagementContracts(api: MichiAPI, workspaceID: String, componentID: String, props: JSONValue) async throws -> JSONValue {
        let created = try await api.request("/workspaces/\(MichiAPI.pathSegment(workspaceID))/databases", method: "POST", body: ["title": "Native management contract", "columns": [
            ["name": "Label", "type": "text"], ["name": "Amount", "type": "number"], ["name": "Done", "type": "checkbox"],
            ["name": "Dates", "type": "date"], ["name": "Tags", "type": "multi"], ["name": "Spare", "type": "text"]], "views": []])
        try require(!created.id.isEmpty && created["workspaceId"].stringValue == workspaceID, "Database fixture creation identity mismatch")
        let path = "/databases/\(MichiAPI.pathSegment(created.id))"
        var database = try await api.request(path)
        func column(_ name: String) throws -> String {
            let matches = database["columns"].arrayValue.filter { $0["name"].stringValue == name }
            try require(matches.count == 1 && !matches[0].id.isEmpty, "Database is missing fixture column \(name)")
            return matches[0].id
        }
        let label = try column("Label"), amount = try column("Amount"), done = try column("Done")
        let dates = try column("Dates"), tags = try column("Tags"), spare = try column("Spare")
        func apply(_ ops: [JSONValue]) async throws {
            let priorRevision = database["revision"].intValue
            let result = try await api.request(path + "/edits", method: "POST", body: ["revision": database["revision"], "ops": .array(ops)])
            let fresh = try await api.request(path)
            try require(fresh == result["database"] && fresh.id == created.id && fresh["workspaceId"].stringValue == workspaceID && fresh["revision"].intValue == priorRevision + 1,
                        "Database edit response did not persist at the next revision")
            database = fresh
        }
        func view(_ id: String) -> JSONValue { database["views"].arrayValue.first { $0.id == id } ?? .null }
        func orderedIDs() -> [String] { database["rows"].arrayValue.sorted { $0["position"].doubleValue < $1["position"].doubleValue }.map(\.id) }
        let table: JSONValue = ["id": "view-native-table", "name": "Table", "type": "table", "config": ["filters": [], "match": "all", "sorts": []]]
        let customConfig: JSONValue = ["filters": [["column": .string(spare), "op": "empty"]], "match": "any", "sorts": [["column": .string(spare), "dir": "desc"]],
            "visible": [.string(label), .string(amount), .string(spare)], "date": .string(dates), "height": 360, "componentId": .string(componentID), "props": props]
        let custom: JSONValue = ["id": "view-native-custom", "name": "Custom", "type": "custom", "config": customConfig]
        try await apply([["op": "view.save", "view": table], ["op": "view.save", "view": custom]])
        var pinnedConfig = customConfig; pinnedConfig["pinnedVersion"] = 2
        try require(view("view-native-custom")["config"] == pinnedConfig, "Human custom view save did not preserve opaque props or pin its version")
        let typedValues: JSONValue = .object([label: "A", amount: .number(12.5), done: true, dates: ["start": "2026-10-30", "end": "2026-11-02"], tags: ["first", "第二"], spare: .null])
        var valuesB = typedValues; valuesB[label] = "B"; valuesB[amount] = -3; valuesB[done] = false
        var valuesC = typedValues; valuesC[label] = "C"; valuesC[amount] = .null
        try await apply([["op": "row.add", "values": typedValues, "body": "Preserve A body"], ["op": "row.add", "values": valuesB], ["op": "row.add", "values": valuesC]])
        let rows = database["rows"].arrayValue
        try require(rows.count == 3 && rows.allSatisfy { !$0.id.isEmpty }, "Database row fixtures were not allocated")
        let a = rows.first { $0["values"][label] == "A" } ?? .null
        let b = rows.first { $0["values"][label] == "B" } ?? .null
        let c = rows.first { $0["values"][label] == "C" } ?? .null
        try require(!a.id.isEmpty && !b.id.isEmpty && !c.id.isEmpty && a["values"] == typedValues && b["values"] == valuesB && c["values"] == valuesC, "Typed database cells were changed during creation")
        try await apply([["op": "row.move", "id": c["id"], "after": .null]])
        try require(orderedIDs() == [c.id, a.id, b.id], "row.move after:null did not move the target to the start")
        let staleRevision = database["revision"]
        try await apply([["op": "row.move", "id": c["id"], "after": b["id"]]])
        try require(orderedIDs() == [a.id, b.id, c.id], "row.move did not place the target immediately after its anchor")
        try require(rows.allSatisfy { original in
            let current = database["rows"].arrayValue.first { $0.id == original.id } ?? .null
            return current["values"] == original["values"] && current["body"] == original["body"] && current["edited"] == original["edited"]
        }, "Moving rows changed typed cells, body or field ownership")
        let beforeConflict = database
        try await rejection(status: 409, code: "stale_revision", label: "Stale native row move") {
            try await api.request(path + "/edits", method: "POST", body: ["revision": staleRevision, "ops": [["op": "row.move", "id": c["id"], "after": .null]]])
        }
        let afterConflict = try await api.request(path)
        try require(afterConflict == beforeConflict, "Rejected stale ordering changed the database")
        let rowsBeforeColumns = database["rows"]
        try await apply([["op": "column.move", "id": .string(amount), "after": .null]])
        try require(database["columns"].arrayValue.map(\.id) == [amount, label, done, dates, tags, spare], "column.move after:null failed")
        try await apply([["op": "column.move", "id": .string(amount), "after": .string(dates)]])
        try require(database["columns"].arrayValue.map(\.id) == [label, done, dates, amount, tags, spare] && database["rows"] == rowsBeforeColumns && view("view-native-custom")["config"] == pinnedConfig,
                    "Moving columns changed row data or custom view configuration")
        let beforeManagement = database
        let originalPosition = view("view-native-custom")["position"]
        // DatabaseManagement.saveView intentionally submits only id/name/type/config.
        let rename: JSONValue = ["id": "view-native-custom", "name": "Renamed custom", "type": "custom", "config": view("view-native-custom")["config"]]
        try await apply([["op": "view.save", "view": rename]])
        try require(view("view-native-custom")["name"] == "Renamed custom" && view("view-native-custom")["position"] == originalPosition && view("view-native-custom")["config"] == pinnedConfig,
                    "Renaming a custom view changed its position or opaque configuration")
        try await rejection(status: 409, code: "stale_revision", label: "Stale native view management") {
            try await api.request(path + "/edits", method: "POST", body: ["revision": beforeManagement["revision"], "ops": [["op": "view.delete", "id": "view-native-custom"]]])
        }
        let afterStaleDelete = try await api.request(path)
        try require(afterStaleDelete == database, "A stale view deletion changed the saved view")
        var duplicate = rename; duplicate["id"] = "view-native-copy"; duplicate["name"] = "Renamed custom copy"
        try await apply([["op": "view.save", "view": duplicate]])
        try require(view("view-native-copy")["config"] == pinnedConfig && view("view-native-copy")["position"].intValue > originalPosition.intValue,
                    "Duplicating a custom view lost opaque configuration or did not append it")
        try await apply([["op": "view.delete", "id": "view-native-copy"]])
        try require(view("view-native-copy").isNull && view("view-native-custom")["config"] == pinnedConfig && !view("view-native-table").isNull,
                    "Deleting a duplicate changed another view")
        try await apply([["op": "column.delete", "id": .string(spare)]])
        pinnedConfig["visible"] = [.string(label), .string(amount)]; pinnedConfig["filters"] = []; pinnedConfig["sorts"] = []
        try require(!database["columns"].arrayValue.contains { $0.id == spare } && view("view-native-custom")["config"] == pinnedConfig,
                    "Column deletion did not remove dangling config references or changed opaque props")
        for original in rows {
            var expected = original["values"].objectValue; expected.removeValue(forKey: spare)
            let current = database["rows"].arrayValue.first { $0.id == original.id } ?? .null
            try require(current["values"] == .object(expected) && current["body"] == original["body"], "Column deletion removed unrelated cells or body")
        }
        let beforeRowDelete = database["rows"].arrayValue
        let currentB = beforeRowDelete.first { $0.id == b.id } ?? .null
        try await apply([["op": "row.delete", "id": b["id"], "expectRev": currentB["rev"]]])
        try require(database["rows"].arrayValue == beforeRowDelete.filter { $0.id != b.id }, "Row deletion changed a different row")
        print("PASS: real database edits accept native row.move/column.move and view.save/delete envelopes, reject stale ordering/management revisions, preserve typed cells and opaque custom props, and scope column/row deletion to the selected resources.")
        return database
    }

    /// Only an actual, expected HTTP rejection counts. Transport errors and
    /// unexpected success propagate without another mutation attempt.
    static func rejection(status: Int, code: String, label: String, request: () async throws -> JSONValue) async throws {
        do {
            _ = try await request()
            throw ProbeFailure(message: "\(label) unexpectedly succeeded")
        } catch let failure as MichiAPIError {
            try require(failure.statusCode == status && failure.code == code, "\(label): expected HTTP \(status)/\(code), got \(failure)")
        }
    }
}
