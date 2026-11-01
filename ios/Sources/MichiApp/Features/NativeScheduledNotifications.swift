import SwiftUI

/// Place in the shell's top overlay. These are transient in-app notices, not a
/// persisted inbox or background push delivery. The shell owns scene attachment.
struct NativeScheduledNotifications: View {
    @ObservedObject var model: NativeScheduledNotificationsModel
    let onOpenConversation: (_ workspaceID: String, _ nodeID: String) -> Void
    @Environment(\.accessibilityVoiceOverEnabled) private var voiceOverEnabled

    var body: some View {
        VStack {
            if let notice = model.notice {
                HStack(alignment: .top, spacing: 10) {
                    Button {
                        Task {
                            if let target = await model.target(for: notice) {
                                model.dismiss(notice.id)
                                onOpenConversation(target.workspaceID, target.nodeID)
                            }
                        }
                    } label: {
                        HStack(alignment: .top, spacing: 10) {
                            Image(systemName: notice.needsAttention ? "exclamationmark.bubble" : "clock.badge.checkmark")
                                .foregroundStyle(.tint).accessibilityHidden(true)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(notice.title).font(.headline).lineLimit(2)
                                Text(notice.subtitle).font(.subheadline.weight(.medium))
                                Text(notice.body).font(.caption).foregroundStyle(.secondary).lineLimit(3)
                                if model.opening { ProgressView().controlSize(.small) }
                            }.frame(maxWidth: .infinity, alignment: .leading)
                        }.contentShape(Rectangle())
                    }.buttonStyle(.plain).disabled(model.opening)
                        .accessibilityHint("Open this scheduled run’s conversation")
                    Button { model.dismiss(notice.id) } label: {
                        Image(systemName: "xmark").frame(width: 44, height: 44)
                    }.buttonStyle(.plain).accessibilityLabel("Dismiss notification")
                }
                .padding(12)
                .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14))
                .overlay { RoundedRectangle(cornerRadius: 14).stroke(.secondary.opacity(0.2), lineWidth: 0.5) }
                .shadow(color: .black.opacity(0.1), radius: 8, y: 3)
                .padding(.horizontal, 12).padding(.top, 6)
                .task(id: notice.id) {
                    // Match phone-web's four-second toast, while leaving the
                    // action available for a VoiceOver user to find and read.
                    guard !voiceOverEnabled else { return }
                    do { try await Task.sleep(for: .seconds(4)) } catch { return }
                    model.dismiss(notice.id)
                }
            }
        }
        .alert("Unable to open conversation", isPresented: Binding(get: { model.error != nil }, set: { if !$0 { model.clearError() } })) {
            Button("OK", role: .cancel) { model.clearError() }
        } message: { Text(model.error ?? "") }
    }
}
