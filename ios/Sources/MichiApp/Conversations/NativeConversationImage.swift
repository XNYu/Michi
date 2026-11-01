import SwiftUI
import MichiCore

/// Images come through the authenticated artifact API, never through a path
/// interpreted on the phone or an arbitrary URL supplied by assistant text.
struct NativeConversationImage: View {
    let api: MichiAPI
    let workspaceID: String
    let item: JSONValue
    @State private var image: UIImage?
    @State private var error: String?
    @State private var expanded = false
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let image {
                Button { expanded = true } label: {
                    Image(uiImage: image).resizable().scaledToFit().frame(maxHeight: 380)
                }.buttonStyle(.plain).accessibilityLabel(item["caption"].optionalString ?? "View image")
            } else if let error { Label(error, systemImage: "photo.badge.exclamationmark").font(.caption).foregroundStyle(.secondary) }
            else { ProgressView("Loading image…") }
            if !item["caption"].stringValue.isEmpty { Text(item["caption"].stringValue).font(.caption).foregroundStyle(.secondary) }
        }
        .task(id: item["path"].stringValue) {
            image = nil; error = nil
            do {
                guard !item["path"].stringValue.isEmpty else { throw NativeFailure("This image has no saved file reference.") }
                let content = try await api.request("/artifacts/\(MichiAPI.pathSegment(workspaceID))/read?path=\(MichiAPI.pathSegment(item["path"].stringValue))&preview=1")
                let payload = content["content"].stringValue
                guard content["imageMime"].stringValue.hasPrefix("image/"),
                      let data = Data(base64Encoded: payload.components(separatedBy: ",").last ?? ""),
                      let decoded = UIImage(data: data) else { throw NativeFailure("This image format cannot be displayed.") }
                image = decoded
            } catch { self.error = error.localizedDescription }
        }
        .sheet(isPresented: $expanded) {
            NavigationStack {
                ScrollView([.horizontal, .vertical]) {
                    if let image { Image(uiImage: image).resizable().scaledToFit().frame(minWidth: 320, maxWidth: 1200).padding() }
                }.navigationTitle(item["caption"].optionalString ?? "Image")
                    .navigationBarTitleDisplayMode(.inline).toolbar { Button("Done") { expanded = false } }
            }
        }
    }
}
