/**
 * Largest JSON request body the backend accepts, in bytes (50 MiB): the limit
 * of server.ts's express.json and of the MCP host behind it (mcpServer.ts),
 * so a large save_artifact body is refused by neither before the other.
 */
export const JSON_BODY_LIMIT_BYTES = 50 * 1024 * 1024;
