import SwiftUI
import AVKit
import MichiCore

/// Provider pages use the system's HTTPS browser/app handoff. Only direct
/// media candidates are passed to AVPlayer; no embedded webpage is loaded.
struct NativeMediaPlayer: View {
    let item: JSONValue
    @StateObject private var controller = NativeMediaPlaybackController()
    @State private var handoffFailed = false
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.openURL) private var openURL

    private var media: NativeMediaModel { NativeMediaModel(item: item) }
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            switch media.source {
            case .unavailable:
                Label("This media address cannot play here.", systemImage: "play.slash")
                Text(media.rawURL).font(.caption).textSelection(.enabled)
            case .provider(let provider, let url):
                VStack(alignment: .leading, spacing: 10) {
                    Label(provider.title, systemImage: media.kind.symbol).font(.headline)
                    Text("Watch on \(provider.title) using its app or your browser.").font(.subheadline).foregroundStyle(.secondary)
                    openButton(url, title: "Open on \(provider.title)")
                }
                .padding(12).frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
                .accessibilityElement(children: .contain)
                .accessibilityLabel(media.caption.isEmpty ? provider.title : media.caption)
            case .direct(let url):
                if case .failed(let reason) = controller.playback.status {
                    Label("This \(media.kind.rawValue) couldn’t play.", systemImage: "play.slash")
                    if let reason, !reason.isEmpty { Text(reason).font(.caption).foregroundStyle(.secondary) }
                    openButton(url, title: "Open \(media.kind.rawValue) in browser")
                } else {
                    if controller.playbackEnabled {
                        VideoPlayer(player: controller.player)
                            .frame(height: media.kind == .audio ? 120 : 240)
                            .accessibilityLabel(media.accessibilityLabel)
                    } else {
                        Button { controller.start(kind: media.kind) } label: {
                            Label("Play \(media.kind.rawValue)", systemImage: "play.fill")
                                .frame(maxWidth: .infinity, minHeight: media.kind == .audio ? 120 : 240)
                        }
                        .accessibilityLabel("Play \(media.accessibilityLabel)")
                        .disabled(controller.player == nil)
                    }
                    if let error = controller.audioSessionError { Text(error).font(.caption).foregroundStyle(.orange) }
                    if controller.playback.status == .loading { ProgressView("Loading \(media.kind.rawValue)").font(.caption) }
                    // Also reachable while a slow server has not reported a
                    // terminal AVPlayerItem error yet.
                    openButton(url, title: "Open externally").font(.caption)
                }
            }
            if handoffFailed { Text("This address could not open. You can copy it and try another browser.").font(.caption).foregroundStyle(.orange); Text(media.rawURL).font(.caption).textSelection(.enabled) }
            if !media.caption.isEmpty { Text(media.caption).font(.caption).foregroundStyle(.secondary) }
        }
        .buttonStyle(.borderless)
        .task(id: media.source) {
            handoffFailed = false
            controller.stop()
            if case .direct(let url) = media.source { controller.prepare(url) }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase != .active { controller.pause() }
        }
        .onDisappear { controller.stop() }
    }

    private func openButton(_ url: URL, title: String) -> some View {
        Button {
            controller.pause()
            handoffFailed = false
            openURL(url) { accepted in handoffFailed = !accepted }
        } label: { Label(title, systemImage: "arrow.up.right.square") }
        .accessibilityHint("Opens the address in its app or your browser")
    }
}

@MainActor
private final class NativeMediaPlaybackController: ObservableObject {
    @Published private(set) var player: AVPlayer?
    @Published private(set) var playback = NativeMediaPlaybackState()
    @Published private(set) var playbackEnabled = false
    @Published private(set) var audioSessionError: String?
    // The audio session is app-wide. A disappearing sibling card must never
    // deactivate the session that another card is currently using.
    private static weak var audioOwner: NativeMediaPlaybackController?
    private var item: AVPlayerItem?
    private var statusObservation: NSKeyValueObservation?
    private var failureObservation: NSObjectProtocol?
    private var endObservation: NSObjectProtocol?

    func prepare(_ url: URL) {
        stop()
        // Revalidate the initial address only. AVPlayer owns HTTPS redirects,
        // playlists and HLS segment requests; this is not a network egress
        // filter and does not validate their eventual destinations.
        guard case .direct(let safeURL) = NativeMediaModel.source(url.absoluteString) else { return }
        let generation = UUID()
        playback.begin(generation)
        let next = AVPlayerItem(url: safeURL)
        item = next
        player = AVPlayer(playerItem: next)
        statusObservation = next.observe(\.status, options: [.initial, .new]) { [weak self, weak next] _, _ in
            Task { @MainActor [weak self, weak next] in
                guard let self, let next, self.item === next else { return }
                switch next.status {
                case .readyToPlay: self.playback.receive(.ready, generation: generation)
                case .failed: self.fail(next.error?.localizedDescription, generation: generation)
                case .unknown: break
                @unknown default: self.fail("This media format is unavailable.", generation: generation)
                }
            }
        }
        failureObservation = NotificationCenter.default.addObserver(forName: .AVPlayerItemFailedToPlayToEndTime, object: next, queue: .main) { [weak self, weak next] notification in
            let message = (notification.userInfo?[AVPlayerItemFailedToPlayToEndTimeErrorKey] as? Error)?.localizedDescription
            Task { @MainActor [weak self, weak next] in
                guard let self, let next, self.item === next else { return }
                self.fail(message ?? next.error?.localizedDescription, generation: generation)
            }
        }
        endObservation = NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: next, queue: .main) { [weak self, weak next] _ in
            Task { @MainActor [weak self, weak next] in
                guard let self, let next, self.item === next else { return }
                self.pause()
                self.player?.seek(to: .zero)
            }
        }
        // Preparing metadata never activates the audio session or starts play.
    }
    func start(kind: NativeMediaKind) {
        guard let player, item != nil else { return }
        if let owner = Self.audioOwner, owner !== self { owner.pause() }
        let session = AVAudioSession.sharedInstance()
        audioSessionError = nil
        do {
            try session.setCategory(.playback, mode: kind == .video ? .moviePlayback : .default)
            try session.setActive(true)
            Self.audioOwner = self
            playbackEnabled = true
            // This follows the user's Play button; never appearance/resume.
            player.play()
        } catch {
            playbackEnabled = false
            audioSessionError = "Audio could not start: \(error.localizedDescription)"
        }
    }
    private func releaseAudioSession() {
        guard Self.audioOwner === self else { return }
        Self.audioOwner = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
    private func fail(_ message: String?, generation: UUID) {
        guard playback.receive(.failed(message), generation: generation) else { return }
        pause()
        player?.replaceCurrentItem(with: nil)
        releaseObservers()
        item = nil
        player = nil
    }
    func pause() {
        player?.pause()
        playbackEnabled = false
        releaseAudioSession()
    }
    func stop() {
        playback.stop()
        releaseObservers()
        pause()
        player?.replaceCurrentItem(with: nil)
        item = nil
        player = nil
        audioSessionError = nil
    }
    private func releaseObservers() {
        statusObservation?.invalidate(); statusObservation = nil
        if let failureObservation { NotificationCenter.default.removeObserver(failureObservation) }
        failureObservation = nil
        if let endObservation { NotificationCenter.default.removeObserver(endObservation) }
        endObservation = nil
    }
    deinit {
        statusObservation?.invalidate()
        if let failureObservation { NotificationCenter.default.removeObserver(failureObservation) }
        if let endObservation { NotificationCenter.default.removeObserver(endObservation) }
        // The view invokes main-actor stop() on disappearance/replacement.
        // Do not access @Published actor-isolated player from this deinit.
    }
}
