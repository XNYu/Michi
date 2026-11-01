import Foundation

/// Generated from Michi's shared catalog and validated by its actual block parser.
/// Loaded as data only; native previews never execute JavaScript.
public enum PageBlockCatalogResource {
    public static func load() throws -> JSONValue {
        guard let url = Bundle.module.url(forResource: "PageBlockCatalog", withExtension: "json") else {
            throw CatalogError.missing
        }
        return try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: url))
    }

    private enum CatalogError: LocalizedError {
        case missing
        var errorDescription: String? { "The built-in block catalog could not be loaded." }
    }
}
