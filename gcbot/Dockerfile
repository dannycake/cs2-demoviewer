# demoviewer-gcbot: turns match share codes into Valve replay URLs (gcbot/README.md). Build from
# the repo root: `docker build -f gcbot/Dockerfile -t demoviewer-gcbot .`
# (gcbot/Dockerfile.dockerignore keeps the context to gcbot's manifest and sources).
FROM node:22-slim

WORKDIR /app

# Dependencies first, so a source change does not reinstall them. Install scripts are skipped:
# the only ones in the tree are protobufjs's version-scheme warnings.
COPY gcbot/package.json gcbot/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci --omit=dev --ignore-scripts --no-audit --no-fund

COPY gcbot/src/ src/

# /state: refresh-token and steam-user's files. The image's `node` user is uid 1000, so a
# bind-mounted directory owned by 1000 is writable as is.
RUN mkdir -p /state && chown node:node /state
VOLUME ["/state"]

ENV NODE_ENV=production \
    GCBOT_STATE=/state \
    GCBOT_PORT=8097

USER node
EXPOSE 8097

# Alive, not healthy: a gcbot without a token or with Steam down still answers (offline), and
# the monitor reads `node src/status.mjs` for the rest.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["node", "src/status.mjs", "--alive"]

# server.mjs handles SIGTERM itself (logs the alt off; graceful on `docker stop`).
CMD ["node", "src/server.mjs"]
