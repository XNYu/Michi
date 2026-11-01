import Foundation
import MichiCore

/// Byte-exact opaque identity. Swift `String`/`Set<String>` use Unicode
/// canonical equivalence, which would merge distinct server IDs (NFC vs NFD).
struct DesignChatOpaqueID: Hashable, Sendable {
    let raw: String

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.raw.utf8.elementsEqual(rhs.raw.utf8)
    }

    func hash(into hasher: inout Hasher) {
        hasher.combine(raw.utf8.count)
        for byte in raw.utf8 { hasher.combine(byte) }
    }

    static func same(_ a: String, _ b: String) -> Bool {
        a.utf8.elementsEqual(b.utf8)
    }
}

extension Set where Element == DesignChatOpaqueID {
    func includes(_ raw: String) -> Bool { contains(DesignChatOpaqueID(raw: raw)) }
}

/// Message times come only from the durable `created_at` (milliseconds since
/// 1970) that the backend stores with each saved row. Optimistic sends and
/// steering echoes carry no durable time, so they show none.
enum DesignChatTimestamp {
    /// 2000-01-01 and 2100-01-01 in milliseconds. Values outside this window
    /// are not wall-clock times (fixtures use small sequence numbers).
    static let earliestMillis: Double = 946_684_800_000
    static let latestMillis: Double = 4_102_444_800_000

    static func date(_ value: JSONValue) -> Date? {
        guard case .number(let millis) = value, millis.isFinite,
              millis >= earliestMillis, millis < latestMillis else { return nil }
        return Date(timeIntervalSince1970: millis / 1000)
    }

    enum Kind: Equatable { case today, yesterday, thisYear, earlier }

    static func kind(_ date: Date, now: Date = Date(), calendar: Calendar = .current) -> Kind {
        if calendar.isDate(date, inSameDayAs: now) { return .today }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(date, inSameDayAs: yesterday) { return .yesterday }
        if calendar.component(.year, from: date) == calendar.component(.year, from: now) { return .thisYear }
        return .earlier
    }

    /// Short reply-row label: time today, "Yesterday" plus time, then a date.
    static func label(_ date: Date, now: Date = Date(), calendar: Calendar = .current, locale: Locale = .current) -> String {
        let time = Date.FormatStyle(date: .omitted, time: .shortened, locale: locale, calendar: calendar, timeZone: calendar.timeZone)
        switch kind(date, now: now, calendar: calendar) {
        case .today: return date.formatted(time)
        case .yesterday: return "Yesterday " + date.formatted(time)
        case .thisYear:
            return date.formatted(Date.FormatStyle(locale: locale, calendar: calendar, timeZone: calendar.timeZone).month(.abbreviated).day())
        case .earlier:
            return date.formatted(Date.FormatStyle(locale: locale, calendar: calendar, timeZone: calendar.timeZone).year().month(.abbreviated).day())
        }
    }

    /// Full wording for VoiceOver.
    static func accessibilityLabel(_ date: Date, locale: Locale = .current, timeZone: TimeZone = .current) -> String {
        date.formatted(Date.FormatStyle(date: .complete, time: .shortened, locale: locale, timeZone: timeZone))
    }
}

/// "Use prompt again": copy the saved prompt that produced a reply back into
/// the composer. It never sends; the user must tap Send. Mention metadata is
/// not stored with sent messages (only `@label` text is), so mentions cannot
/// be restored and the caller is told when the text may have contained some.
enum DesignChatPromptAgain {
    enum Unavailable: Error, Equatable {
        case notAReply
        case notSaved          // the reply is not in durable history yet
        case noSavedPrompt     // no durable user message precedes it
        case ambiguousPrompt   // several user messages (for example steering) fed this reply
        case emptyPrompt
    }

    struct Source: Equatable {
        let messageID: String
        let composer: NativeComposer
        /// The saved text contains `@word` tokens that may have been mentions.
        let mentionsNotRestored: Bool
    }

    /// The single durable user message between the previous reply and `replyID`.
    static func source(forReply replyID: String, messages: [NativeMessage], durableIDs: [String]) -> Result<Source, Unavailable> {
        guard let index = messages.firstIndex(where: { DesignChatOpaqueID.same($0.id, replyID) }), messages[index].role == "assistant" else { return .failure(.notAReply) }
        guard durableIDs.contains(where: { DesignChatOpaqueID.same($0, replyID) }) else { return .failure(.notSaved) }
        var prompts: [NativeMessage] = []
        var cursor = index - 1
        while cursor >= 0, messages[cursor].role != "assistant" {
            if messages[cursor].role == "user" { prompts.append(messages[cursor]) }
            cursor -= 1
        }
        guard !prompts.isEmpty else { return .failure(.noSavedPrompt) }
        guard prompts.count == 1 else { return .failure(.ambiguousPrompt) }
        let prompt = prompts[0]
        guard durableIDs.contains(where: { DesignChatOpaqueID.same($0, prompt.id) }), !prompt.id.hasPrefix("pending-"), !prompt.metadata["steered"].boolValue else {
            return .failure(prompt.metadata["steered"].boolValue ? .ambiguousPrompt : .noSavedPrompt)
        }
        let composer = composer(from: prompt)
        guard !composer.isEmpty else { return .failure(.emptyPrompt) }
        return .success(Source(messageID: prompt.id, composer: composer, mentionsNotRestored: mayContainMentions(prompt.text)))
    }

    /// Replies that currently offer the action, computed in one pass for a transcript.
    static func availableReplyIDs(messages: [NativeMessage], durableIDs: [String]) -> Set<DesignChatOpaqueID> {
        Set(messages.compactMap { reply -> DesignChatOpaqueID? in
            guard reply.role == "assistant" else { return nil }
            return (try? source(forReply: reply.id, messages: messages, durableIDs: durableIDs).get()) == nil
                ? nil : DesignChatOpaqueID(raw: reply.id)
        })
    }

    /// Text, quote and attachment references from the saved user metadata.
    /// Mentions are deliberately empty: their ids were never persisted.
    static func composer(from message: NativeMessage) -> NativeComposer {
        var composer = NativeComposer()
        composer.value = message.text
        let quote = message.metadata["quotedText"].stringValue
        if !quote.isEmpty {
            composer.quotedText = quote
            let source = message.metadata["quoteSource"]
            if source["type"] == "attached" || (source["type"] == "artifact" && !source["filePath"].stringValue.isEmpty) { composer.quoteSource = source }
        }
        composer.attachments = message.metadata["attachments"].arrayValue.compactMap { file in
            let name = file["name"].stringValue, path = file["absPath"].stringValue
            guard !name.isEmpty, !path.isEmpty else { return nil }
            return ["name": .string(name), "absPath": .string(path)]
        }
        return composer
    }

    static func mayContainMentions(_ text: String) -> Bool {
        text.range(of: #"(^|\s)@\S"#, options: .regularExpression) != nil
    }

    /// Why the controller refuses to fill the composer right now.
    enum Blocked: Equatable {
        case readOnly
        case notLoaded
        /// A response, command or recovery record is unresolved; filling the
        /// composer could lead to a duplicate submission.
        case submissionUnresolved
        /// The composer already holds unsent work; it is never overwritten.
        case draftNotEmpty
        case unavailable(Unavailable)
    }

    enum Outcome: Equatable {
        case filled(mentionsNotRestored: Bool)
        case blocked(Blocked)
    }

    static func notice(for outcome: Outcome) -> String? {
        switch outcome {
        case .filled(let dropped):
            return dropped ? "Mentions from the original message are plain text now. Mention those chats or files again to include them." : nil
        case .blocked(.draftNotEmpty): return "Your unsent draft was kept. Send or clear it, then use the prompt again."
        case .blocked(.submissionUnresolved): return "Wait until the current response or saved submission is resolved."
        case .blocked(.readOnly): return "Archived conversations are read-only."
        case .blocked(.notLoaded): return "Wait for the saved conversation to load."
        case .blocked(.unavailable): return "The prompt for this reply is not available."
        }
    }
}
