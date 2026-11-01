import Foundation

/// One dispatched Server-Sent Event. `data` is the payload decoded losslessly;
/// a payload that is not JSON is kept verbatim as `.string`. Event names the
/// client does not know are delivered unchanged.
public struct SSEEvent: Equatable, Sendable {
    public let event: String
    public let data: JSONValue
    /// The stream's last event ID at dispatch, when the server set one.
    public let id: String?

    public init(event: String, data: JSONValue, id: String? = nil) {
        self.event = event
        self.data = data
        self.id = id
    }
}

/// Incremental event-stream parser following the WHATWG SSE rules. Lines are
/// split on CRLF, LF or CR before UTF-8 decoding, so any chunking (including a
/// split multi-byte character or CRLF pair) parses identically. Data lines are
/// joined with "\n"; comments are skipped; an unterminated trailing event is
/// never dispatched. Line and event sizes are bounded, and exceeding either
/// throws `MichiAPIError.Code.streamLimitExceeded`.
public struct SSEParser: Sendable {
    public static let defaultMaxLineBytes = 16 * 1024 * 1024
    public static let defaultMaxEventBytes = 16 * 1024 * 1024

    public let maxLineBytes: Int
    public let maxEventBytes: Int
    /// The `id` field most recently set by the stream ("" when none).
    public private(set) var lastEventID = ""
    /// The reconnection delay the stream requested, if any.
    public private(set) var retryMilliseconds: Int?

    private static let lf: UInt8 = 0x0A
    private static let cr: UInt8 = 0x0D
    private static let colon: UInt8 = 0x3A
    private static let space: UInt8 = 0x20
    private static let byteOrderMark: [UInt8] = [0xEF, 0xBB, 0xBF]
    private static let retainedCapacity = 64 * 1024

    private var line: [UInt8] = []
    private var data: [UInt8] = []
    private var eventType = ""
    private var afterCR = false
    private var atStreamStart = true

    public init(maxLineBytes: Int = SSEParser.defaultMaxLineBytes, maxEventBytes: Int = SSEParser.defaultMaxEventBytes) {
        self.maxLineBytes = max(1, maxLineBytes)
        self.maxEventBytes = max(1, maxEventBytes)
    }

    /// Consumes the next bytes of the stream and returns the events they complete.
    public mutating func feed<Bytes: Sequence>(_ bytes: Bytes) throws -> [SSEEvent] where Bytes.Element == UInt8 {
        var events: [SSEEvent] = []
        for byte in bytes {
            if afterCR {
                afterCR = false
                if byte == Self.lf { continue }
            }
            switch byte {
            case Self.lf:
                try endLine(into: &events)
            case Self.cr:
                afterCR = true
                try endLine(into: &events)
            default:
                guard line.count < maxLineBytes else { throw Self.limitError("line", maxLineBytes) }
                line.append(byte)
            }
        }
        return events
    }

    private mutating func endLine(into events: inout [SSEEvent]) throws {
        defer { resetLine() }
        var start = line.startIndex
        if atStreamStart {
            atStreamStart = false
            if line.starts(with: Self.byteOrderMark) { start += Self.byteOrderMark.count }
        }
        let content = line[start...]
        guard let first = content.first else {
            dispatch(into: &events)
            return
        }
        if first == Self.colon { return }
        let colon = content.firstIndex(of: Self.colon)
        let field = content[..<(colon ?? content.endIndex)]
        var valueStart = colon.map { $0 + 1 } ?? content.endIndex
        if valueStart < content.endIndex, content[valueStart] == Self.space { valueStart += 1 }
        let value = content[valueStart...]

        if field.elementsEqual("data".utf8) {
            guard data.count + value.count + 1 <= maxEventBytes else { throw Self.limitError("event", maxEventBytes) }
            data.append(contentsOf: value)
            data.append(Self.lf)
        } else if field.elementsEqual("event".utf8) {
            eventType = String(decoding: value, as: UTF8.self)
        } else if field.elementsEqual("id".utf8) {
            if !value.contains(0) { lastEventID = String(decoding: value, as: UTF8.self) }
        } else if field.elementsEqual("retry".utf8) {
            if !value.isEmpty, value.allSatisfy({ $0 >= 0x30 && $0 <= 0x39 }) {
                retryMilliseconds = Int(String(decoding: value, as: UTF8.self))
            }
        }
    }

    private mutating func dispatch(into events: inout [SSEEvent]) {
        defer {
            eventType = ""
            if data.capacity > Self.retainedCapacity { data = [] } else { data.removeAll(keepingCapacity: true) }
        }
        guard !data.isEmpty else { return }
        data.removeLast()
        let raw = String(decoding: data, as: UTF8.self)
        events.append(SSEEvent(event: eventType.isEmpty ? "message" : eventType,
                               data: (try? JSONValue.parse(raw)) ?? .string(raw),
                               id: lastEventID.isEmpty ? nil : lastEventID))
    }

    private mutating func resetLine() {
        if line.capacity > Self.retainedCapacity { line = [] } else { line.removeAll(keepingCapacity: true) }
    }

    private static func limitError(_ unit: String, _ limit: Int) -> MichiAPIError {
        MichiAPIError(statusCode: nil, code: MichiAPIError.Code.streamLimitExceeded,
                      message: "An event stream \(unit) exceeded \(limit) bytes.")
    }
}
