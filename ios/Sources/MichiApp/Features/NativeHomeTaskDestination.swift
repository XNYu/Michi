import SwiftUI
import MichiCore

/// A Home task link resolves the page's workspace, independently of the chat
/// picker. Creating a missing task database remains an explicit user action.
struct NativeHomeTaskDestination: View {
    let api: MichiAPI
    let workspaceID: String
    let viewID: String?
    @State private var databaseID: String?
    @State private var loading = false
    @State private var writable = false
    @State private var loaded = false
    @State private var uncertain = false
    @State private var error: String?

    var body: some View {
        Group {
            if let databaseID { FeatureDatabaseScreen(api: api, databaseId: databaseID, workspaceId: workspaceID, initialViewId: viewID) }
            else {
                Form {
                    if let error { Text(error).foregroundStyle(.red) }
                    if loading { ProgressView("Loading tasks…") }
                    else if loaded { Text("This workspace does not have a task database yet.") }
                    if uncertain { Text("The last creation was not confirmed. Check for the saved database before continuing.").font(.footnote) }
                    Button("Refresh") { Task { await load() } }.disabled(loading)
                    Button("Create task database") { Task { await create() } }
                        .disabled(loading || !loaded || !writable || uncertain)
                }
                .navigationTitle("Tasks")
                .navigationBarTitleDisplayMode(.inline)
                .michiToolbarBackground()
            }
        }.task { if !loaded { await load() } }
    }

    private func workspaceIsWritable() async throws -> Bool {
        let value = try await api.request("/workspaces/\(MichiAPI.pathSegment(workspaceID))")
        let workspace = value["workspace"].isNull ? value : value["workspace"]
        guard workspace.id == workspaceID, workspace["deleted_at"].isNull else { throw NativeFailure("This workspace is no longer available.") }
        return workspace["archived_at"].isNull && workspace["readOnly"] != true
    }
    private func load() async {
        guard !loading else { return }; loading = true
        defer { loading = false }
        do {
            writable = try await workspaceIsWritable()
            let result = try await api.request("/workspaces/\(MichiAPI.pathSegment(workspaceID))/task-database")
            guard result.objectValue.keys.contains("databaseId") else { throw NativeFailure("The service did not return the task database identity.") }
            if result["databaseId"].isNull { databaseID = nil }
            else {
                guard let id = result["databaseId"].optionalString, !id.isEmpty else { throw NativeFailure("The task database identity is invalid.") }
                databaseID = id; uncertain = false
            }
            loaded = true; error = nil
        } catch { writable = false; self.error = error.localizedDescription }
    }
    private func create() async {
        guard !loading, loaded, writable, !uncertain else { return }; loading = true
        defer { loading = false }
        do {
            guard try await workspaceIsWritable() else { writable = false; throw NativeFailure("This workspace is read-only.") }
            uncertain = true
            let result = try await api.request("/workspaces/\(MichiAPI.pathSegment(workspaceID))/task-database", method: "POST", body: [:])
            let database = try featureRequireDatabase(result)
            guard database["workspaceId"].stringValue == workspaceID else { throw NativeFailure("The service returned a different workspace's database.") }
            databaseID = database.id; uncertain = false; error = nil
        } catch let failure as MichiAPIError where failure.statusCode.map({ (400..<500).contains($0) }) == true {
            uncertain = false; error = failure.localizedDescription
        } catch { self.error = error.localizedDescription }
    }
}
