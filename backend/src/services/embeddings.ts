/**
 * Embeddings provider interface — Phase B placeholder.
 *
 * Phase A uses enhanced FTS5 (query expansion + BM25 + recency scoring).
 * Phase B will add local embeddings via @xenova/transformers + cosine similarity.
 *
 * Future schema addition:
 *   CREATE TABLE message_embeddings (
 *     message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
 *     embedding  BLOB NOT NULL
 *   );
 */

export interface EmbeddingProvider {
  embed(text: string): Promise<Float32Array>;
  readonly dimension: number;
}

export interface SearchResult {
  messageId: string;
  nodeId: string;
  score: number;
}

// Phase B: implement XenovaProvider
// import { pipeline } from '@xenova/transformers';
// export class XenovaProvider implements EmbeddingProvider { ... }

// Phase B: cosine similarity search
// export function vectorSearch(query: string, limit: number): SearchResult[]
