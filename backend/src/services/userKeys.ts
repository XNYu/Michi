import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { getDb } from "./db";

/**
 * Per-user, per-provider API key store with AES-256-GCM encryption at rest.
 *
 * Threat model
 * ------------
 * - DB file leak: ciphertext + IV + tag are useless without
 *   MICHI_ENCRYPTION_KEY.
 * - MICHI_ENCRYPTION_KEY leak alone: useless without DB.
 * - Both leak together: all stored keys decryptable. (Acceptable v1
 *   trade-off — see docs/cloud-deployment.md.)
 *
 * Key rotation: NOT supported. Setting a new MICHI_ENCRYPTION_KEY
 * bricks every existing user_provider_keys row.
 */

const KEY_BYTES = 32; // AES-256
const IV_BYTES = 12;  // GCM-recommended

let cachedKey: Buffer | null = null;

function getMasterKey(): Buffer {
    if (cachedKey) return cachedKey;
    const raw = process.env.MICHI_ENCRYPTION_KEY;
    if (!raw) {
        throw new Error(
            "MICHI_ENCRYPTION_KEY is not set. Generate one with `openssl rand -base64 32` and set it in the deployment environment.",
        );
    }
    let buf: Buffer;
    try {
        buf = Buffer.from(raw, "base64");
    } catch {
        throw new Error("MICHI_ENCRYPTION_KEY must be base64-encoded");
    }
    if (buf.length !== KEY_BYTES) {
        throw new Error(
            `MICHI_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes (was ${buf.length}). Re-generate with \`openssl rand -base64 32\`.`,
        );
    }
    cachedKey = buf;
    return buf;
}

function encrypt(plaintext: string): { ciphertext: Buffer; iv: Buffer; tag: Buffer } {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", getMasterKey(), iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return { ciphertext, iv, tag };
}

function decrypt(ciphertext: Buffer, iv: Buffer, tag: Buffer): string {
    const decipher = createDecipheriv("aes-256-gcm", getMasterKey(), iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext.toString("utf8");
}

export interface UserKeyRow {
    provider: string;
    updatedAt: number;
}

export function setUserProviderKey(userId: string, provider: string, plaintext: string): void {
    if (!userId || !provider) throw new Error("userId and provider are required");
    if (!plaintext || plaintext.length < 8) throw new Error("API key looks too short");
    const { ciphertext, iv, tag } = encrypt(plaintext);
    const db = getDb();
    db.prepare(
        `INSERT INTO user_provider_keys (user_id, provider, ciphertext, iv, tag, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, provider) DO UPDATE SET
            ciphertext = excluded.ciphertext,
            iv         = excluded.iv,
            tag        = excluded.tag,
            updated_at = excluded.updated_at`,
    ).run(userId, provider, ciphertext, iv, tag, Date.now());
}

export function getUserProviderKey(userId: string, provider: string): string | null {
    if (!userId || !provider) return null;
    const row = getDb()
        .prepare("SELECT ciphertext, iv, tag FROM user_provider_keys WHERE user_id = ? AND provider = ?")
        .get(userId, provider) as { ciphertext: Buffer; iv: Buffer; tag: Buffer } | undefined;
    if (!row) return null;
    try {
        return decrypt(row.ciphertext, row.iv, row.tag);
    } catch {
        // Auth tag mismatch — likely the master key was rotated. We treat
        // this as "no usable key" and let the caller surface a clean error.
        return null;
    }
}

export function clearUserProviderKey(userId: string, provider: string): void {
    if (!userId || !provider) return;
    getDb()
        .prepare("DELETE FROM user_provider_keys WHERE user_id = ? AND provider = ?")
        .run(userId, provider);
}

/** List which providers this user has a stored key for, with mtime. */
export function listUserProviderKeys(userId: string): UserKeyRow[] {
    if (!userId) return [];
    const rows = getDb()
        .prepare("SELECT provider, updated_at FROM user_provider_keys WHERE user_id = ? ORDER BY provider")
        .all(userId) as Array<{ provider: string; updated_at: number }>;
    return rows.map((r) => ({ provider: r.provider, updatedAt: r.updated_at }));
}
