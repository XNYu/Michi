import { exec } from "node:child_process";
import { promisify } from "node:util";
import { log } from "./logger";
const execAsync = promisify(exec);
import type { BedrockCredentials } from "./bedrockCredentials";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const MIN_COOLDOWN_MS = 30_000;     // 30 seconds minimum between attempts
const MAX_COOLDOWN_MS = 300_000;    // 5 minutes cap with exponential backoff
const REFRESH_TIMEOUT_MS = 15_000;  // 15 second command execution timeout
/** ada sessions typically expire after 60 minutes; refresh proactively at 45. */
const PROACTIVE_INTERVAL_MS = 45 * 60 * 1000;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface RefreshState {
    lastRefreshAt: number;
    lastError: string | null;
    cooldownMs: number;
    inFlight: Promise<boolean> | null;
}

const states = new Map<string, RefreshState>();
let refreshTimeoutMs = REFRESH_TIMEOUT_MS;

/** Test-only: forget earlier refreshes and optionally shorten the command timeout. */
export function __resetBedrockRefreshStateForTest(options: { timeoutMs?: number } = {}): void {
    states.clear();
    refreshTimeoutMs = options.timeoutMs ?? REFRESH_TIMEOUT_MS;
}

function stateFor(command: string): RefreshState {
    let state = states.get(command);
    if (!state) {
        if (states.size >= 16) {
            const idle = [...states].find(([, value]) => !value.inFlight);
            if (idle) states.delete(idle[0]);
        }
        state = { lastRefreshAt: 0, lastError: null, cooldownMs: 0, inFlight: null };
        states.set(command, state);
    }
    return state;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Proactive refresh: called before each Bedrock API call.
 *
 * When `authRefreshCommand` is configured and the profile-based credential
 * mode is in use, automatically execute the refresh if the last one was
 * more than 45 minutes ago. This mirrors Claude Code's behavior of keeping
 * ada sessions alive before they expire.
 *
 * For non-profile modes (bearer token, access keys), proactive refresh
 * still runs but on a longer interval (same 45 min) — the
 * `authRefreshCommand` might be rotating a short-lived token.
 */
export async function refreshBedrockCredentialsIfNeeded(
    creds: BedrockCredentials,
): Promise<void> {
    if (!creds.authRefreshCommand) return;

    const state = stateFor(creds.authRefreshCommand);
    if (state.inFlight) { await state.inFlight; return; }
    const now = Date.now();
    // Respect cooldown from a recent failure
    if (now - state.lastRefreshAt < state.cooldownMs) return;

    // Proactive: refresh when enough time has elapsed
    if (state.lastRefreshAt === 0 || now - state.lastRefreshAt > PROACTIVE_INTERVAL_MS) {
        await executeRefresh(creds.authRefreshCommand);
    }
}

/**
 * Reactive refresh: called after a Bedrock auth error (401/403/expired token).
 *
 * Executes `authRefreshCommand` with exponential backoff between retries.
 * Returns `true` if the refresh succeeded and the caller should retry the
 * Bedrock request. Returns `false` if no command is configured, cooldown
 * has not elapsed, or the command failed.
 */
export async function refreshOnAuthFailure(
    creds: BedrockCredentials,
): Promise<boolean> {
    if (!creds.authRefreshCommand) return false;

    const state = stateFor(creds.authRefreshCommand);
    if (state.inFlight) return state.inFlight;
    const now = Date.now();
    if (now - state.lastRefreshAt < MIN_COOLDOWN_MS) return false;

    return executeRefresh(creds.authRefreshCommand);
}

/**
 * Check whether a pi-ai stream error event indicates a Bedrock
 * authentication/authorization failure that is potentially recoverable
 * via credential refresh.
 */
export function isBedrockAuthError(ev: any): boolean {
    const msg: string = ev?.error?.errorMessage ?? ev?.error?.message ?? "";
    return (
        /ExpiredToken|AccessDenied|UnrecognizedClient|InvalidIdentityToken|CredentialsError|TokenExpired/i.test(msg) ||
        ev?.error?.statusCode === 401 ||
        ev?.error?.statusCode === 403
    );
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

async function executeRefresh(command: string): Promise<boolean> {
    const state = stateFor(command);
    if (state.inFlight) return state.inFlight;
    const started = performance.now();
    state.inFlight = (async () => {
        try {
            // The configured command can contain credentials. Never log it or
            // child output; only outcome and elapsed time are diagnostic data.
            log.info("auth", "refreshing Bedrock credentials");
            const run = execAsync(command, {
                timeout: refreshTimeoutMs,
                maxBuffer: 1024 * 1024,
                windowsHide: true,
                env: { ...process.env },
            });
            run.child.stdin?.end();
            await run;
            state.lastRefreshAt = Date.now();
            state.lastError = null;
            state.cooldownMs = 0;
            log.info("auth", "Bedrock credential refresh succeeded", { durationMs: Math.round(performance.now() - started) });
            return true;
        } catch (err) {
            state.lastRefreshAt = Date.now();
            state.lastError = "Credential refresh failed";
            state.cooldownMs = Math.min(Math.max(state.cooldownMs * 2 || MIN_COOLDOWN_MS, MIN_COOLDOWN_MS), MAX_COOLDOWN_MS);
            const error = err as { code?: string | number; signal?: string };
            log.warn("auth", "Bedrock credential refresh failed", {
                durationMs: Math.round(performance.now() - started), cooldownMs: state.cooldownMs,
                code: error.code, signal: error.signal,
            });
            return false;
        } finally { state.inFlight = null; }
    })();
    return state.inFlight;
}
