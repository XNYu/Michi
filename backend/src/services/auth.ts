import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { getMichiDataDir } from "./dataDir";

// Standard Auth instance type — we re-derive it via `Auth` so the
// lazy-init proxy and `getAuth()` share the same return shape and
// don't widen to `Auth<typeof opts>`.
type Auth = ReturnType<typeof betterAuth>;

/**
 * Better-Auth instance, backed by its own SQLite file (separate from the
 * application's michi.db so the auth schema can evolve independently).
 *
 * The DB lives under `MICHI_DATA_DIR/auth.sqlite` so it ends up on the
 * Railway volume in production. Locally it falls back to ~/.michi.
 *
 * Required env:
 *   - BETTER_AUTH_SECRET        — random 32+ bytes; signs the session cookie
 *   - BETTER_AUTH_URL           — fallback full origin, e.g. http://localhost:3000
 *   - GOOGLE_CLIENT_ID          — from Google Cloud Console
 *   - GOOGLE_CLIENT_SECRET      — from Google Cloud Console
 *
 * Optional env:
 *   - MICHI_CORS_ORIGINS        — comma-separated list of full origins. When set,
 *                                 each origin gets its own per-host Auth instance
 *                                 with that origin as baseURL. Lets the same
 *                                 service handle multiple domains (e.g. a custom
 *                                 domain + the Railway-default fallback) where
 *                                 OAuth callbacks must round-trip back to the
 *                                 originating host.
 *
 * Mounting: server.ts picks an instance per-request via getAuthForHost(host)
 * and forwards /api/auth/* to its handler. Cookies stay scoped to whichever
 * origin signed the user in — sessions are per-origin, but the underlying
 * user/account rows are shared (same SQLite DB, same email = same user).
 */

function resolveAuthDbPath(): string {
    return path.join(getMichiDataDir(), "auth.sqlite");
}

function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(
            `Missing required env var ${name} — see backend/.env.example. Auth will not start until this is set.`,
        );
    }
    return value;
}

// Lazy init — defer the `requireEnv` checks and DB open until the first
// access. This matters because:
//
//   1. dotenv.config() runs at the top of server.ts; importing
//      auth.ts at the top of server.ts would fire env checks BEFORE
//      .env is loaded in some run modes (electron dev loop, tests).
//   2. Tests / scripts that import other backend modules don't always
//      need an auth instance — failing fast at import time forces them
//      to set fake auth env vars they don't actually use.
//
// One Auth instance per allowed origin. Better-Auth bakes the origin
// into cookie domain checks and OAuth state validation, so a single
// instance can only safely serve one origin. The DB connection is
// shared across instances (same SQLite file) — user/session/account
// rows live in one place, only the per-request cookie + redirect URL
// differ.
//
// Callers read via getAuth(host) / getAuthForHost(host); the legacy
// `auth` proxy and `getAuth()` (no-arg) still resolve to the fallback
// instance keyed off BETTER_AUTH_URL.

const authInstances = new Map<string, Auth>();
let authDbPath: string | null = null;
let authDb: DatabaseSync | null = null;

function getDb(): DatabaseSync {
    if (!authDb) {
        authDbPath = resolveAuthDbPath();
        authDb = new DatabaseSync(authDbPath);
    }
    return authDb;
}

function buildAuthForBaseURL(baseURL: string): Auth {
    const opts: BetterAuthOptions = {
        database: getDb() as any,
        baseURL,
        secret: requireEnv("BETTER_AUTH_SECRET"),
        socialProviders: {
            google: {
                clientId: requireEnv("GOOGLE_CLIENT_ID"),
                clientSecret: requireEnv("GOOGLE_CLIENT_SECRET"),
            },
        },
        session: {
            expiresIn: 60 * 60 * 24 * 30,        // 30 days
            updateAge: 60 * 60 * 24,             // refresh once per day if active
            cookieCache: {
                enabled: true,
                maxAge: 5 * 60,                  // 5 min — avoids hitting DB on every request
            },
        },
        advanced: {
            cookiePrefix: "michi",
            useSecureCookies: process.env.NODE_ENV === "production",
            defaultCookieAttributes: {
                sameSite: "lax",
                httpOnly: true,
            },
        },
    };
    return betterAuth(opts);
}

function normalizeOrigin(originOrUrl: string): string {
    // Strip path/query and trailing slash so "https://x/" and "https://x" key the same.
    try {
        const u = new URL(originOrUrl);
        return `${u.protocol}//${u.host}`;
    } catch {
        return originOrUrl.replace(/\/+$/, "");
    }
}

/**
 * Returns the Auth instance whose baseURL matches `host` (the value of
 * the incoming Host header). Falls back to BETTER_AUTH_URL when host is
 * absent or doesn't match any configured origin — that fallback is what
 * preserves single-domain deployments and CLI/script callers that never
 * see a request.
 */
export function getAuthForHost(host: string | undefined): Auth {
    const fallbackBase = normalizeOrigin(requireEnv("BETTER_AUTH_URL"));
    const allowed = (process.env.MICHI_CORS_ORIGINS || fallbackBase)
        .split(",")
        .map((s) => normalizeOrigin(s.trim()))
        .filter(Boolean);
    let chosen = fallbackBase;
    if (host) {
        const match = allowed.find((origin) => {
            try { return new URL(origin).host === host; } catch { return false; }
        });
        if (match) chosen = match;
    }
    let inst = authInstances.get(chosen);
    if (!inst) {
        inst = buildAuthForBaseURL(chosen);
        authInstances.set(chosen, inst);
    }
    return inst;
}

export function getAuth(): Auth {
    return getAuthForHost(undefined);
}

/**
 * Idempotent migration runner. Called from server.ts boot path so a
 * fresh container with an empty `auth.sqlite` builds the user / session
 * / account tables before the first request hits Better-Auth.
 *
 * `runMigrations()` is a no-op when the schema is already current, so
 * calling it on every boot is safe.
 */
export async function runAuthMigrations(): Promise<void> {
    const dbPath = resolveAuthDbPath();
    authDbPath = dbPath;
    const authDb = new DatabaseSync(dbPath);
    const opts: BetterAuthOptions = {
        database: authDb as any,
        baseURL: requireEnv("BETTER_AUTH_URL"),
        secret: requireEnv("BETTER_AUTH_SECRET"),
        socialProviders: {
            google: {
                clientId: requireEnv("GOOGLE_CLIENT_ID"),
                clientSecret: requireEnv("GOOGLE_CLIENT_SECRET"),
            },
        },
    };
    const { runMigrations } = await getMigrations(opts);
    await runMigrations();
}
