import Foundation
import XCTest
import MichiCore
#if canImport(Michi)
@testable import Michi
#else
@testable import MichiState
#endif

final class NativeMediaTests: XCTestCase {
    func testYouTubeHostVariantsAndNonVideoPagesNeverBecomeDirectMedia() {
        for raw in [
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=45",
            "https://m.youtube.com/shorts/dQw4w9WgXcQ",
            "https://youtu.be/dQw4w9WgXcQ",
            "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
            "https://youtube.com/playlist?list=abc", "https://youtube.com/@channel",
            "https://YOUTUBE.COM./not-a-single-video",
        ] {
            guard case .provider(.youtube, let url) = NativeMediaModel.source(raw) else { return XCTFail(raw) }
            XCTAssertEqual(url, URL(string: raw), "Provider handoff preserves the user's original path, query and playback position")
        }
    }

    func testVimeoPrivateAndPlayerURLsPreserveAccessHash() {
        for raw in ["https://vimeo.com/123456/abc123", "https://player.vimeo.com/video/123456?h=ab12cd&autoplay=0", "https://www.vimeo.com/channels/staffpicks", "https://m.vimeo.com/123456"] {
            XCTAssertEqual(NativeMediaModel.source(raw), .provider(.vimeo, URL(string: raw)!))
        }
    }

    func testProviderLookalikesAreNotTrustedAsProviders() {
        for raw in ["https://youtube.com.example.net/watch?v=x", "https://notyoutube.com/a.mp4", "https://vimeo.com.evil.example/video", "https://example.com/youtube.com/watch"] {
            XCTAssertEqual(NativeMediaModel.source(raw), .direct(URL(string: raw)!))
        }
        XCTAssertEqual(NativeMediaModel.source("https://youtube.com@evil.example/watch"), .unavailable)
    }

    func testPublicHTTPSMediaCandidatesKeepQueriesAndAudioCaptions() {
        let raw = "https://media.example.com/asset?id=42&token=public-link#part"
        let video = NativeMediaModel(item: ["type": "video", "url": .string(raw), "caption": "Launch demo"])
        XCTAssertEqual(video.source, .direct(URL(string: raw)!))
        XCTAssertEqual(video.accessibilityLabel, "Launch demo")
        let audio = NativeMediaModel(item: ["type": "audio", "url": "https://media.example.com/podcast.mp3", "caption": "Interview"])
        XCTAssertEqual(audio.kind, .audio); XCTAssertEqual(audio.accessibilityLabel, "Interview")
        XCTAssertEqual(NativeMediaModel(item: ["type": "audio", "caption": "  "]).accessibilityLabel, "Audio player")
        // A provider webpage cannot be used as a native audio stream either.
        XCTAssertEqual(NativeMediaModel(item: ["type": "audio", "url": "https://youtu.be/dQw4w9WgXcQ"]).source,
                       .provider(.youtube, URL(string: "https://youtu.be/dQw4w9WgXcQ")!))
    }

    func testHandoffAndPlaybackShareTheExistingPublicAddressPolicy() {
        for raw in [
            "http://youtube.com/watch?v=id", "file:///tmp/clip.mp4", "javascript:alert(1)", "youtube://watch?id=x",
            "https://user:password@youtube.com/watch?v=id", "https://127.0.0.1/video.mp4", "https://10.0.0.1/audio.mp3",
            "https://[::1]/movie.mp4", "https://[::ffff:127.0.0.1]/movie.mp4", "https://machine.local/movie.mp4",
        ] { XCTAssertEqual(NativeMediaModel.source(raw), .unavailable, raw) }
        XCTAssertEqual(NativeMediaModel.source("https://8.8.8.8/movie.mp4"), .direct(URL(string: "https://8.8.8.8/movie.mp4")!))
    }

    func testItemFailureStaysFailedAndOldObserverCannotChangeReplacement() {
        var state = NativeMediaPlaybackState()
        let first = UUID(), second = UUID()
        state.begin(first)
        XCTAssertEqual(state.status, .loading)
        XCTAssertTrue(state.receive(.ready, generation: first))
        XCTAssertTrue(state.receive(.failed("Unsupported codec"), generation: first))
        XCTAssertFalse(state.receive(.ready, generation: first), "A queued ready notification must not hide the failure fallback")
        XCTAssertEqual(state.status, .failed("Unsupported codec"))
        state.begin(second)
        XCTAssertFalse(state.receive(.failed("Old failure"), generation: first))
        XCTAssertEqual(state.status, .loading)
        XCTAssertTrue(state.receive(.ready, generation: second))
        state.stop()
        XCTAssertFalse(state.receive(.failed("Late notification"), generation: second))
        XCTAssertNil(state.generation); XCTAssertEqual(state.status, .idle)
    }
}
