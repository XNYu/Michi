import Foundation

/// Lossless JSON for backend-owned extensible records. Required domain fields
/// are validated by the workflow using them rather than discarded on decoding.
public enum JSONValue: Codable, Equatable, Sendable {
    case object([String: JSONValue]), array([JSONValue]), string(String)
    case number(Double), bool(Bool), null

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let x = try? c.decode(Bool.self) { self = .bool(x) }
        else if let x = try? c.decode(Double.self) { self = .number(x) }
        else if let x = try? c.decode(String.self) { self = .string(x) }
        else if let x = try? c.decode([JSONValue].self) { self = .array(x) }
        else { self = .object(try c.decode([String: JSONValue].self)) }
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .object(let x): try c.encode(x)
        case .array(let x): try c.encode(x)
        case .string(let x): try c.encode(x)
        case .number(let x): try c.encode(x)
        case .bool(let x): try c.encode(x)
        case .null: try c.encodeNil()
        }
    }
    public subscript(_ key: String) -> JSONValue {
        get { objectValue[key] ?? .null }
        set { var values = objectValue; values[key] = newValue; self = .object(values) }
    }
    public var objectValue: [String: JSONValue] { if case .object(let x) = self { return x }; return [:] }
    public var arrayValue: [JSONValue] { if case .array(let x) = self { return x }; return [] }
    public var stringValue: String { if case .string(let x) = self { return x }; return "" }
    public var optionalString: String? { if case .string(let x) = self { return x }; return nil }
    public var doubleValue: Double { if case .number(let x) = self { return x }; return 0 }
    public var intValue: Int { let n = doubleValue; return n.isFinite && n >= Double(Int.min) && n < Double(Int.max) ? Int(n) : 0 }
    public var boolValue: Bool { if case .bool(let x) = self { return x }; return false }
    public var isNull: Bool { self == .null }
    public var id: String { self["id"].stringValue }
    public var prettyPrinted: String {
        let e = JSONEncoder(); e.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return (try? e.encode(self)).flatMap { String(data: $0, encoding: .utf8) } ?? "null"
    }
    public static func parse(_ string: String) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: Data(string.utf8))
    }
    public var parsedJSON: JSONValue { (try? Self.parse(stringValue)) ?? self }
    public func merging(_ values: [String: JSONValue]) -> JSONValue {
        .object(objectValue.merging(values) { _, new in new })
    }
}
extension JSONValue: ExpressibleByStringLiteral {
    public init(stringLiteral value: String) { self = .string(value) }
}
extension JSONValue: ExpressibleByIntegerLiteral {
    public init(integerLiteral value: Int) { self = .number(Double(value)) }
}
extension JSONValue: ExpressibleByBooleanLiteral {
    public init(booleanLiteral value: Bool) { self = .bool(value) }
}
extension JSONValue: ExpressibleByDictionaryLiteral {
    public init(dictionaryLiteral elements: (String, JSONValue)...) { self = .object(Dictionary(elements, uniquingKeysWith: { _, new in new })) }
}
extension JSONValue: ExpressibleByArrayLiteral {
    public init(arrayLiteral elements: JSONValue...) { self = .array(elements) }
}
