import fs from "fs";
import path from "path";
import os from "os";

const CONFIG_DIR = path.join(os.homedir(), ".michi");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BedrockCredentials {
    region: string;
    bearerToken?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    profile?: string;
    authRefreshCommand?: string;
}

export type BedrockCredentialSource = "bearer-token" | "access-keys" | "profile" | "auto";

export interface BedrockConfig {
    region?: string;
    credentialSource?: BedrockCredentialSource;
    bearerToken?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    profile?: string;
    authRefreshCommand?: string;
}

export interface BedrockConfigSanitized {
    configured: boolean;
    region: string | null;
    credentialSource: BedrockCredentialSource | "env" | null;
    hasProfile: boolean;
    hasBearerToken: boolean;
    hasAccessKeys: boolean;
    hasAuthRefresh: boolean;
    envDetected: boolean;
    envProfile?: string;
    envRegion?: string;
}

// ---------------------------------------------------------------------------
// Config I/O
// ---------------------------------------------------------------------------

function readDiskFile(): Record<string, any> | null {
    try {
        return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    } catch {
        return null;
    }
}

function writeDiskFile(data: Record<string, any>): void {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2), { mode: 0o600 });
}

function readBedrockConfigFromDisk(): BedrockConfig | null {
    const disk = readDiskFile();
    if (!disk || typeof disk !== "object") return null;
    const cfg = disk.bedrock;
    if (!cfg || typeof cfg !== "object") return null;
    return cfg as BedrockConfig;
}

// ---------------------------------------------------------------------------
// Credential Resolution
// ---------------------------------------------------------------------------

/**
 * Detect whether any AWS credential environment variables are set.
 * Used to decide if env vars should take priority over config.json.
 */
function detectEnvCredentials(): BedrockCredentials | null {
    const envRegion = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;
    const envProfile = process.env.AWS_PROFILE;
    const envBearer = process.env.AWS_BEARER_TOKEN_BEDROCK;
    const envAccessKey = process.env.AWS_ACCESS_KEY_ID;
    const envSecret = process.env.AWS_SECRET_ACCESS_KEY;

    if (envProfile || envBearer || envAccessKey) {
        return {
            region: envRegion || "us-east-1",
            profile: envProfile || undefined,
            bearerToken: envBearer || undefined,
            accessKeyId: envAccessKey || undefined,
            secretAccessKey: envSecret || undefined,
        };
    }
    return null;
}

/**
 * Resolve credentials from config.json bedrock field.
 */
function resolveFromConfig(): BedrockCredentials | null {
    const cfg = readBedrockConfigFromDisk();
    if (!cfg) return null;

    const region = cfg.region || "us-east-1";
    const authRefreshCommand = cfg.authRefreshCommand || undefined;

    switch (cfg.credentialSource) {
        case "bearer-token":
            if (cfg.bearerToken) {
                return { region, bearerToken: cfg.bearerToken, authRefreshCommand };
            }
            break;
        case "access-keys":
            if (cfg.accessKeyId && cfg.secretAccessKey) {
                return {
                    region,
                    accessKeyId: cfg.accessKeyId,
                    secretAccessKey: cfg.secretAccessKey,
                    authRefreshCommand,
                };
            }
            break;
        case "profile":
            if (cfg.profile) {
                return { region, profile: cfg.profile, authRefreshCommand };
            }
            break;
        case "auto":
            // Let the AWS SDK default chain handle resolution.
            // We still need at least a region.
            return { region, authRefreshCommand };
        default:
            break;
    }
    return null;
}

/**
 * Resolve Bedrock credentials.
 *
 * Priority:
 *   1. Environment variables (`AWS_PROFILE`, `AWS_REGION`, `AWS_BEARER_TOKEN_BEDROCK`, etc.)
 *   2. `~/.michi/config.json` → `bedrock` field
 *   3. `null` (no credentials available)
 */
export function resolveBedrockCredentials(): BedrockCredentials | null {
    // 1. Environment variables always win
    const envCreds = detectEnvCredentials();
    if (envCreds) {
        // Merge in authRefreshCommand from config if env doesn't carry one
        const cfg = readBedrockConfigFromDisk();
        if (cfg?.authRefreshCommand) {
            envCreds.authRefreshCommand = cfg.authRefreshCommand;
        }
        return envCreds;
    }

    // 2. Config.json
    return resolveFromConfig();
}

/**
 * True when any credential source resolves. Used by `hasKey` checks
 * in `/api/agent/status`.
 */
export function hasBedrockCredentials(): boolean {
    return resolveBedrockCredentials() !== null;
}

// ---------------------------------------------------------------------------
// Sanitized Config (for GET endpoint — no secret values)
// ---------------------------------------------------------------------------

/**
 * Return a sanitized view of the Bedrock config for the frontend.
 * Never includes actual token/key values.
 */
export function getBedrockConfigSanitized(): BedrockConfigSanitized {
    const envCreds = detectEnvCredentials();
    const cfg = readBedrockConfigFromDisk();

    if (envCreds) {
        return {
            configured: true,
            region: envCreds.region,
            credentialSource: "env",
            hasProfile: !!envCreds.profile,
            hasBearerToken: !!envCreds.bearerToken,
            hasAccessKeys: !!envCreds.accessKeyId,
            hasAuthRefresh: !!cfg?.authRefreshCommand,
            envDetected: true,
            envProfile: envCreds.profile,
            envRegion: envCreds.region,
        };
    }

    if (cfg) {
        const creds = resolveFromConfig();
        return {
            configured: !!creds,
            region: cfg.region || null,
            credentialSource: cfg.credentialSource || null,
            hasProfile: !!cfg.profile,
            hasBearerToken: !!cfg.bearerToken,
            hasAccessKeys: !!cfg.accessKeyId,
            hasAuthRefresh: !!cfg.authRefreshCommand,
            envDetected: false,
        };
    }

    return {
        configured: false,
        region: null,
        credentialSource: null,
        hasProfile: false,
        hasBearerToken: false,
        hasAccessKeys: false,
        hasAuthRefresh: false,
        envDetected: false,
    };
}

// ---------------------------------------------------------------------------
// Config Persistence
// ---------------------------------------------------------------------------

/**
 * Save Bedrock config to `~/.michi/config.json`.
 * Merges into the existing file — does not overwrite other fields.
 */
export function saveBedrockConfig(cfg: BedrockConfig): void {
    const disk = readDiskFile() ?? {};
    const bedrock: Record<string, unknown> = {};

    if (cfg.region) bedrock.region = cfg.region;
    if (cfg.credentialSource) bedrock.credentialSource = cfg.credentialSource;
    if (cfg.bearerToken) bedrock.bearerToken = cfg.bearerToken;
    if (cfg.accessKeyId) bedrock.accessKeyId = cfg.accessKeyId;
    if (cfg.secretAccessKey) bedrock.secretAccessKey = cfg.secretAccessKey;
    if (cfg.profile) bedrock.profile = cfg.profile;
    if (cfg.authRefreshCommand !== undefined) bedrock.authRefreshCommand = cfg.authRefreshCommand;

    writeDiskFile({ ...disk, bedrock });
}

/**
 * Clear Bedrock config from `~/.michi/config.json`.
 */
export function clearBedrockConfig(): void {
    const disk = readDiskFile();
    if (!disk) return;
    const { bedrock: _, ...rest } = disk;
    writeDiskFile(rest);
}
