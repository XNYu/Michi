export const HEARTBEAT_INTERVAL_MS = 10_000;

/**
 * Largest JSON message Michi carries for a tool call, in bytes (50 MiB): the
 * limit of the backend's express.json and of the MCP host behind it, so a
 * large save_artifact body is refused by neither before the other, and the
 * read buffer of the stdio MCP transports in between (the Crew relay, the
 * backend's client of external MCP servers). It lives here, free of other
 * imports, so the Crew relay bundles take this number and nothing else.
 */
export const JSON_BODY_LIMIT_BYTES = 50 * 1024 * 1024;
