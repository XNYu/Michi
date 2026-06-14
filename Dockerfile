# syntax=docker/dockerfile:1.7

# ---------- builder ----------
# node:22-slim (Debian/glibc) instead of alpine. Vite 8's rolldown bundler
# and esbuild ship platform-specific native bindings as optional deps; a
# musl-libc base would need yet another set of bindings, and Alpine is
# also more prone to subtle ABI mismatches with native modules we'll add
# later (sqlite, argon2 for Better-Auth, etc.).
FROM node:22-slim AS builder
WORKDIR /app

# Force public npm registry. We deliberately do NOT copy the repo's root
# .npmrc; local registry settings should not affect container builds.
ENV npm_config_registry=https://registry.npmjs.org/

# Install workspace deps first (better cache: source changes don't bust this layer)
COPY package.json package-lock.json ./
COPY frontend/package.json frontend/
COPY backend/package.json backend/
COPY shared/package.json shared/

RUN npm ci --include=dev --no-audit --no-fund

# Source
COPY . .

# Frontend feature flags. Vite inlines VITE_* env vars at build time, so
# these MUST be set before `frontend:build` runs. Default-off flags get
# turned on for cloud deploys here.
ENV VITE_MICHI_PROFILE_PAGE=1

# Frontend (Vite reads frontend/.env.production → VITE_API_URL=/api)
RUN npm run frontend:build

# Backend (tsc --noEmit + esbuild bundle of backend/src → backend/dist/server.js)
# The bundle is self-contained except for `node:*` builtins; runtime stage
# does NOT need node_modules.
RUN npm run backend:build


# ---------- runtime ----------
FROM node:22-slim AS runtime
WORKDIR /app

# wget for HEALTHCHECK; ca-certificates for outbound HTTPS to Anthropic etc.
RUN apt-get update \
    && apt-get install -y --no-install-recommends wget ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=3000 \
    MICHI_ENABLED_RUNTIMES=pi \
    MICHI_DEFAULT_RUNTIME=pi \
    MICHI_DATA_DIR=/data \
    MICHI_REQUIRE_AUTH=true

# /data is the SQLite + agent-config volume mount in production
RUN mkdir -p /data && chown node:node /data

# Self-contained backend bundle + the static frontend it serves.
# server.ts reads frontend/build via path.join(__dirname, '../../frontend/build')
# so the relative layout matters: backend/dist/server.js + frontend/build at the same depth.
COPY --from=builder /app/backend/dist ./backend/dist
COPY --from=builder /app/frontend/build ./frontend/build

# Entrypoint: Railway (and most volume-mount platforms) reset the
# ownership of the mount point to root:root after we COPY/chown above,
# so the node user can no longer write to /data and SQLite fails with
# "unable to open database file". We run the entrypoint as root just
# long enough to fix /data's ownership, then drop privileges to node
# via runuser (shipped in util-linux on the slim base).
COPY <<'EOF' /entrypoint.sh
#!/bin/sh
set -e
chown -R node:node /data || true
exec runuser -u node -- node /app/backend/dist/server.js
EOF
RUN chmod +x /entrypoint.sh

EXPOSE 3000

# Container-level healthcheck mirrors railway.toml's /api/health probe.
# wget is in the base image; curl is not.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD wget -q --spider http://127.0.0.1:3000/api/health || exit 1

ENTRYPOINT ["/entrypoint.sh"]
