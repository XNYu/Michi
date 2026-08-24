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

# Cloud Agent workspaces run as ubuntu (uid 1000).
RUN if ! id -u ubuntu >/dev/null 2>&1; then \
      groupadd -g 1000 ubuntu \
      && useradd -m -u 1000 -g ubuntu -s /bin/bash ubuntu; \
    fi

WORKDIR /workspace
USER ubuntu
