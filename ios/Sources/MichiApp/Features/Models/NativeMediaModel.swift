import Foundation
import MichiCore

enum NativeMediaKind: String, Equatable {
    case video, audio
    var title: String { self == .audio ? "Audio" : "Video" }
    var symbol: String { self == .audio ? "waveform" : "play.rectangle" }
}

enum NativeMediaProvider: String, Equatable {
    case youtube, vimeo
    var title: String { self == .youtube ? "YouTube" : "Vimeo" }
}

enum NativeMediaSource: Equatable {
    case unavailable
    case provider(NativeMediaProvider, URL)
    /// A direct media candidate; AVPlayer determines format/codec support.
    case direct(URL)
}

struct NativeMediaModel: Equatable {
    let kind: NativeMediaKind
    let rawURL: String
    let caption: String
    let source: NativeMediaSource
    var accessibilityLabel: String { caption.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "\(kind.title) player" : caption }

    init(item: JSONValue) {
        kind = item["type"] == "audio" ? .audio : .video
        rawURL = item["url"].stringValue
        caption = item["caption"].stringValue
        source = Self.source(rawURL)
    }

    static func source(_ raw: String) -> NativeMediaSource {
        // Keep the shared native public-HTTPS policy for both playback and
        // external handoff. No authenticated Michi request or custom scheme.
        guard let url = RichPageBlockModel.mediaURL(raw) else { return .unavailable }
        if let provider = provider(url) { return .provider(provider, url) }
        return .direct(url)
    }

    private static func provider(_ url: URL) -> NativeMediaProvider? {
        guard var host = url.host?.lowercased() else { return nil }
        // A trailing DNS dot still denotes the provider, never a media file.
        while host.hasSuffix(".") { host.removeLast() }
        if host.hasPrefix("www.") { host.removeFirst(4) }
        else if host.hasPrefix("m.") { host.removeFirst(2) }
        // Exact host matches mirror vendor media/players.tsx. A channel,
        // playlist, shorts, embed, or private/unlisted URL stays a provider
        // page even when it does not identify a single embeddable video.
        if ["youtube.com", "youtube-nocookie.com", "youtu.be"].contains(host) { return .youtube }
        if ["vimeo.com", "player.vimeo.com"].contains(host) { return .vimeo }
        return nil
    }
}

enum NativeMediaLoadStatus: Equatable {
    case idle, loading, ready
    case failed(String?)
}

/// Observers can arrive after replacement/cleanup. Only the current item's
/// generation may change the UI, and a failed item never becomes ready again.
struct NativeMediaPlaybackState: Equatable {
    private(set) var generation: UUID?
    private(set) var status: NativeMediaLoadStatus = .idle

    mutating func begin(_ id: UUID) { generation = id; status = .loading }
    @discardableResult
    mutating func receive(_ next: NativeMediaLoadStatus, generation id: UUID) -> Bool {
        guard generation == id else { return false }
        if case .failed = status { return false }
        guard next != .idle else { return false }
        status = next
        return true
    }
    mutating func stop() { generation = nil; status = .idle }
}
