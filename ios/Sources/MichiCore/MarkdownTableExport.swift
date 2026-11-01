import Foundation

/// Exports the complete table, independently of any UI paging or cell previews.
/// Cell strings are inline Markdown source, as produced by MarkdownDocument.
public enum MarkdownTableExport {
    public static let maximumColumns = 200
    public static let maximumRows = 10_000
    public static let maximumCells = 100_000
    public static let maximumUTF8Bytes = 8 * 1_024 * 1_024

    public enum Failure: Error, Equatable, LocalizedError {
        case tooManyColumns, tooManyRows, tooManyCells, tooLarge

        public var errorDescription: String? {
            switch self {
            case .tooManyColumns: return "This table has too many columns to export. Nothing was copied or shared."
            case .tooManyRows: return "This table has too many rows to export. Nothing was copied or shared."
            case .tooManyCells: return "This table has too many cells to export. Nothing was copied or shared."
            case .tooLarge: return "The complete Markdown table exceeds the 8 MB export limit. Nothing was copied or shared."
            }
        }
    }

    public static func serialize(headers: [String], alignments: [MarkdownAlignment], rows: [[String]]) throws -> String {
        guard rows.count <= maximumRows else { throw Failure.tooManyRows }
        let width = max(headers.count, rows.map(\.count).max() ?? 0)
        guard width <= maximumColumns else { throw Failure.tooManyColumns }
        guard width > 0 else { return "" }
        // Includes the header and delimiter rows; check before allocating padding.
        guard rows.count + 2 <= maximumCells / width else { throw Failure.tooManyCells }
        var result = ""
        var byteCount = 0
        func append(_ value: String) throws {
            let count = value.utf8.count
            guard count <= maximumUTF8Bytes - byteCount else { throw Failure.tooLarge }
            result += value
            byteCount += count
        }
        func appendRow(_ cells: [String]) throws {
            try append("| ")
            for column in 0..<width {
                if column > 0 { try append(" | ") }
                if column < cells.count {
                    // A single cell cannot be larger than the entire export.
                    guard cells[column].utf8.count <= maximumUTF8Bytes else { throw Failure.tooLarge }
                    try append(escapeCell(cells[column]))
                }
            }
            try append(" |")
        }
        try appendRow(headers)
        let delimiters = (0..<width).map { column -> String in
            guard column < alignments.count else { return "---" }
            switch alignments[column] {
            case .leading: return "---"
            case .center: return ":---:"
            case .trailing: return "---:"
            }
        }
        try append("\n")
        try appendRow(delimiters)
        for row in rows {
            try append("\n")
            try appendRow(row)
        }
        return result
    }

    /// Keep inline emphasis, links and code intact. Escape table delimiters even
    /// inside code spans, as GFM requires. A pre-existing odd backslash run must
    /// be made even first, otherwise the pipe would create an extra column.
    /// Markdown's portable in-cell line break representation is <br>.
    private static func escapeCell(_ value: String) -> String {
        let normalized = value.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
        var output = "", backslashes = 0
        // Markdown delimiters are ASCII scalars, not extended grapheme clusters.
        // A pipe followed by a combining mark/variation selector is still a pipe.
        for scalar in normalized.unicodeScalars {
            if scalar == "|" {
                if backslashes % 2 == 1 { output.append("\\") }
                output += "\\|"
            } else if scalar == "\n" { output += "<br>" }
            else { output.unicodeScalars.append(scalar) }
            backslashes = scalar == "\\" ? backslashes + 1 : 0
        }
        return output
    }
}
