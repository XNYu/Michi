import SwiftUI
import MichiCore

struct ConnectionScreen: View {
    @ObservedObject var connection: ConnectionStore
    @State private var address = ""
    @State private var name = ""
    @State private var token = ""
    @State private var showHelp = false
    @State private var showScanner = false
    @State private var confirmScan = false
    @State private var pendingConfirmation: PendingScanConfirmation?
    @Environment(\.michiTokens) private var tokens
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 0) {
                    VStack(spacing: 12) {
                        Image(systemName: "hare.fill")
                            .font(.system(size: 36, weight: .medium))
                            .foregroundStyle(tokens.fg)
                            .frame(width: 92, height: 92)
                            .background(tokens.bgDeep, in: RoundedRectangle(cornerRadius: 21, style: .continuous))
                        Text("Connect to your computer")
                            .font(MichiFont.sans(size: 26, relativeTo: .title, weight: .semibold))
                            .multilineTextAlignment(.center)
                            .foregroundStyle(tokens.fg)
                        Text("Michi runs on your Mac or Windows PC. Turn on Phone access there, then scan the QR or paste the address it shows.")
                            .font(MichiFont.sans(size: 17, relativeTo: .body))
                            .foregroundStyle(tokens.mid)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal, 32)
                    }
                    .padding(.top, 72)
                    .padding(.bottom, 24)

                    MichiSectionHeader(title: "Address")
                    TextField("HTTPS phone address", text: $address)
                        .font(MichiFont.mono(size: 16, relativeTo: .body))
                        .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                        .padding(.horizontal, 20).padding(.vertical, 12)
                        .disabled(connection.connecting)
                        .accessibilityIdentifier("connection-address")
                    Text("Use the Tailscale or tunnel address from Phone access. A browser-only company address cannot sign in from this app.")
                        .font(MichiFont.rowSecondary).foregroundStyle(tokens.muted)
                        .padding(.horizontal, 20).padding(.bottom, 12)

                    if connection.connecting || connection.preflightStage != nil {
                        ConnectionPreflightProgress(
                            stage: connection.preflightStage,
                            connecting: connection.connecting,
                            failed: connection.error != nil,
                            completed: previewCompleted
                        )
                    }

                    #if DEBUG
                    if connection.previewReady {
                        Text("Preview only. This result is not saved.")
                            .font(MichiFont.rowSecondary)
                            .foregroundStyle(tokens.muted)
                            .padding(.horizontal, 20)
                            .padding(.bottom, 8)
                            .accessibilityIdentifier("connection-preview-success")
                    }
                    #endif

                    VStack(alignment: .leading, spacing: 6) {
                        Text("Browser sessions stay in the browser")
                            .font(MichiFont.rowTitle)
                            .foregroundStyle(tokens.fg)
                        Text(ConnectionPreflight.browserSessionGuidance)
                            .font(MichiFont.rowSecondary)
                            .foregroundStyle(tokens.muted)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 20)
                    .padding(.vertical, 8)
                    .accessibilityIdentifier("connection-help")

                    if !connection.profiles.isEmpty {
                        MichiSectionHeader(title: "Recent")
                        ForEach(connection.profiles) { profile in
                            VStack(alignment: .leading, spacing: 0) {
                                Button { Task { await connection.connect(profile) } } label: {
                                    MichiHairlineRow(title: profile.name, subtitle: profile.address, leading: {
                                        Image(systemName: "desktopcomputer").foregroundStyle(tokens.muted)
                                    }, trailing: {
                                        Image(systemName: "chevron.right").font(.caption).foregroundStyle(tokens.faint)
                                    })
                                }
                                .buttonStyle(.plain)
                                .disabled(connection.connecting)
                                .swipeActions { Button("Remove", role: .destructive) { connection.remove(profile) } }
                                Toggle(isOn: autoReconnectBinding(profile)) {
                                    Text("Reconnect on launch")
                                        .font(MichiFont.rowSecondary)
                                        .foregroundStyle(tokens.muted)
                                }
                                .padding(.horizontal, 20)
                                .padding(.bottom, 8)
                                .accessibilityIdentifier("connection-auto-reconnect-\(profile.id)")
                            }
                        }
                    }

                    TextField("Name (optional)", text: $name).padding(.horizontal, 20).padding(.top, 12)
                        .disabled(connection.connecting)
                    DisclosureGroup("Direct server authentication") {
                        SecureField("Bearer token", text: $token).textInputAutocapitalization(.never).autocorrectionDisabled()
                        Text("Only for a server you already configured for direct remote access. Tailscale phone links do not use this token.").font(MichiFont.rowSecondary).foregroundStyle(tokens.muted)
                    }.padding(.horizontal, 20).padding(.vertical, 8)
                    .disabled(connection.connecting)

                    if let error = connection.error {
                        Text(error).foregroundStyle(tokens.dangerText).font(MichiFont.rowSecondary).padding(20).accessibilityIdentifier("connection-error")
                    }
                }
            }
            .foregroundStyle(tokens.fg)
            .background(tokens.bg)
            .safeAreaInset(edge: .bottom) {
                VStack(spacing: 16) {
                    MichiPrimaryButton(title: connectTitle, enabled: !connection.connecting && !address.isEmpty) {
                        Task { await connection.connect(address: address, name: name, token: token); if connection.api != nil { token = "" } }
                    }
                    .accessibilityIdentifier("connect")
                    MichiSecondaryButton(title: "Scan QR code", systemImage: "qrcode.viewfinder") {
                        beginScan()
                    }
                    .disabled(connection.connecting)
                    .accessibilityIdentifier("connection-scan")
                    .accessibilityLabel("Scan Phone access QR code")
                    .accessibilityHint("Opens the camera to read the HTTPS address from desktop Michi. You can still enter the address yourself.")
                    Button("How phone access works") { showHelp = true }
                        .font(MichiFont.sans(size: 15, relativeTo: .body))
                        .foregroundStyle(tokens.accent)
                }
                .padding(.horizontal, 20)
                .padding(.bottom, 16)
                .background(tokens.bg)
            }
            .alert("Phone access", isPresented: $showHelp) {
                Button("OK", role: .cancel) {}
            } message: {
                Text("For Tailscale, connect your iPhone to the same account and scan or enter the HTTPS address from desktop Michi. Your computer needs to stay awake. \(ConnectionPreflight.browserSessionGuidance)")
            }
            .alert("Use this computer?", isPresented: $confirmScan) {
                Button("Use this address") {
                    acceptPendingConfirmation()
                }
                Button("Cancel", role: .cancel) {
                    clearPendingConfirmation()
                }
            } message: {
                Text("The code is for \(pendingConfirmation?.destination ?? ""). It does not include a password or token.")
            }
            .sheet(isPresented: $showScanner, onDismiss: presentPendingConfirmationIfNeeded) {
                ConnectionQRScannerScreen { event in
                    applyScan(event)
                }
            }
            #if DEBUG
            .onAppear {
                let args = ProcessInfo.processInfo.arguments
                if ConnectionPreview.active(args), address.isEmpty {
                    address = "https://michi.example.test"
                }
            }
            #endif
        }
    }

    private var connectTitle: String {
        if connection.connecting {
            return connection.preflightStage?.title ?? "Connecting…"
        }
        return "Connect"
    }

    private var previewCompleted: Bool {
        #if DEBUG
        connection.previewReady
        #else
        false
        #endif
    }

    private func beginScan() {
        clearPendingConfirmation()
        showScanner = true
    }

    private func applyScan(_ event: ConnectionScanEvent) {
        switch event {
        case .scanned(let parsed):
            pendingConfirmation = PendingScanConfirmation(
                destination: parsed.confirmationDestination,
                address: parsed.url.absoluteString
            )
            token = ""
            confirmScan = false
        case .rejected(let failure):
            clearPendingConfirmation()
            connection.error = failure.message(scanned: true)
        case .cancelled, .unavailable:
            clearPendingConfirmation()
        }
    }

    private func presentPendingConfirmationIfNeeded() {
        confirmScan = pendingConfirmation != nil
    }

    private func acceptPendingConfirmation() {
        guard let pending = pendingConfirmation else { return }
        address = pending.address
        token = ""
        pendingConfirmation = nil
    }

    private func clearPendingConfirmation() {
        pendingConfirmation = nil
        confirmScan = false
    }

    private func autoReconnectBinding(_ profile: ConnectionProfile) -> Binding<Bool> {
        Binding(
            get: { connection.profiles.first { $0.id == profile.id }?.autoReconnect ?? false },
            set: { connection.setAutoReconnect(profile, enabled: $0) }
        )
    }
}

private struct PendingScanConfirmation: Equatable {
    let destination: String
    let address: String
}

private struct ConnectionPreflightProgress: View {
    let stage: ConnectionPreflight.Stage?
    let connecting: Bool
    let failed: Bool
    var completed = false
    @Environment(\.michiTokens) private var tokens

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(ConnectionPreflight.Stage.allCases, id: \.self) { item in
                HStack(spacing: 10) {
                    mark(for: item)
                    Text(item.title)
                        .font(MichiFont.rowTitle)
                        .foregroundStyle(color(for: item))
                }
                .accessibilityIdentifier("connection-stage-\(item.rawValue)")
                .accessibilityLabel("\(item.title), \(label(for: item))")
            }
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 8)
        .accessibilityIdentifier("connection-preflight")
    }

    private func mark(for item: ConnectionPreflight.Stage) -> some View {
        Group {
            switch status(for: item) {
            case .done:
                Image(systemName: "checkmark.circle.fill").foregroundStyle(tokens.accent)
            case .active:
                ProgressView().controlSize(.small)
            case .failed:
                Image(systemName: "xmark.circle.fill").foregroundStyle(tokens.dangerText)
            case .pending:
                Image(systemName: "circle").foregroundStyle(tokens.faint)
            }
        }
        .font(.body)
        .frame(width: 22, height: 22)
    }

    private func color(for item: ConnectionPreflight.Stage) -> Color {
        switch status(for: item) {
        case .done, .active: return tokens.fg
        case .failed: return tokens.dangerText
        case .pending: return tokens.muted
        }
    }

    private func label(for item: ConnectionPreflight.Stage) -> String {
        switch status(for: item) {
        case .done: return "done"
        case .active: return "in progress"
        case .failed: return "failed"
        case .pending: return "waiting"
        }
    }

    private enum Status { case pending, active, done, failed }

    private func status(for item: ConnectionPreflight.Stage) -> Status {
        guard let stage else { return .pending }
        if completed { return item <= stage ? .done : .pending }
        if item < stage { return .done }
        if item == stage {
            if failed { return .failed }
            return connecting ? .active : .done
        }
        return .pending
    }
}
