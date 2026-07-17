import { createAuthClient } from "better-auth/react";

/**
 * Better-Auth client. Talks to the backend's /api/auth/* handlers via
 * standard fetch with credentials: 'include' so the session cookie is
 * sent on every request.
 *
 * `baseURL` is the FULL origin of the backend, not just the path —
 * Better-Auth's client appends `/api/auth/*` itself.
 */

function resolveAuthBaseURL(): string {
    // VITE_API_URL is normally `/api` (same-origin) or
    // `http://localhost:3000/api` (cross-origin dev).
    // Strip the trailing `/api` because better-auth/client expects an
    // origin, not the api root.
    const apiUrl = import.meta.env.VITE_API_URL || "/api";
    if (apiUrl.startsWith("http")) {
        return apiUrl.replace(/\/api\/?$/, "");
    }
    // Same-origin path → use the current page origin.
    return typeof window !== "undefined" ? window.location.origin : "";
}

export const authClient = createAuthClient({
    baseURL: resolveAuthBaseURL(),
    fetchOptions: {
        credentials: "include",
    },
});

export interface AuthConfig {
    requireAuth: boolean;
}

/** Probe the backend to decide whether to mount the sign-in UI. */
export async function fetchAuthConfig(): Promise<AuthConfig> {
    const apiBase = import.meta.env.VITE_API_URL || "/api";
    try {
        const res = await fetch(`${apiBase}/auth-config`, {
            credentials: "include",
        });
        if (!res.ok) return { requireAuth: false };
        const body = await res.json();
        return { requireAuth: !!body.requireAuth };
    } catch {
        // Pre-auth backend (or unreachable) — render shell as before.
        return { requireAuth: false };
    }
}
