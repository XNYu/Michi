# Michi Cloud Agent base image.
# Node 22.21.1 bundles SQLite with FTS5 (required by backend/node:sqlite migrations).
# The default /exec-daemon Node 22.14.0 lacks FTS5 and breaks DB setup.
FROM node:22.21.1-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        git \
        curl \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Official node images already use uid/gid 1000 as `node`.
# Cloud Agent workspaces expect the `ubuntu` login at that uid.
RUN if ! id -u ubuntu >/dev/null 2>&1; then \
      usermod -l ubuntu node \
      && groupmod -n ubuntu node \
      && usermod -d /home/ubuntu -m ubuntu; \
    fi

WORKDIR /workspace
USER ubuntu
