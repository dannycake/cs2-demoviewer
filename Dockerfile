# demoviewer: the phase 1 server plus the web app. Build from the repo root:
# `docker build -t demoviewer .`

# Stage 1: build the web app (web/dist).
FROM node:22-slim AS web

WORKDIR /build/web

# Dependencies first, so a source change does not reinstall them.
COPY web/package.json web/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci --no-audit --no-fund

# The guides' HTML fragments live with the server; web/src/site/guides.ts imports them raw.
COPY server/crates/server/guides/ ../server/crates/server/guides/
COPY web/ ./
RUN npm run build

# Stage 2: build the server binary.
# The compiler server/rust-toolchain.toml pins, the desktop's too, rather than the floating
# `rust:1-bookworm`: rust-discord-archiver lost a deploy to a compiler version skew between
# its image and the desktop. Bump the tag with that file.
FROM rust:1.99.1-bookworm AS builder

WORKDIR /build

# Only what the build needs, and the toolchain file: rustup then builds with the version it
# names, the one this image has installed (were the tag above to differ, it would fetch it).
COPY server/rust-toolchain.toml server/Cargo.toml server/Cargo.lock ./
COPY server/crates/ crates/
COPY server/vendor/ vendor/

# The vendored build scripts are `fn main() {}`: no git clone, no protoc (vendor/README.md).
# The cargo registry and target/ live in BuildKit cache mounts so a rebuild after a source
# change does not recompile every dependency; the binary is copied out before they unmount.
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,target=/usr/local/cargo/git,sharing=locked \
    --mount=type=cache,target=/build/target,sharing=locked \
    cargo build --release --locked -p demoviewer-server \
    && mkdir -p /out \
    && cp target/release/demoviewer-server /out/demoviewer-server

# Stage 3: runtime.
FROM debian:bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# uid 1000, so a bind-mounted data directory owned by the desktop user is writable as is.
RUN useradd --uid 1000 --user-group --no-create-home --shell /usr/sbin/nologin app \
    && mkdir -p /data /assets \
    && chown app:app /data

WORKDIR /app
COPY --from=builder /out/demoviewer-server /app/demoviewer-server
COPY --from=web /build/web/dist /app/static

# /data: uploads, work files, packs, match summaries (matches/), preview images (og/) and
# demos.json (must be writable by uid 1000).
# /assets: what is served under /maps/, /players/, /weapons/, /viewmodels/ and /effects/
# (read only is fine).
VOLUME ["/data", "/assets"]

ENV DEMOVIEWER_DATA=/data \
    DEMOVIEWER_ASSETS=/assets \
    DEMOVIEWER_WEB=/app/static \
    DEMOVIEWER_PORT=8095

USER app
EXPOSE 8095

# No curl here: the binary is its own health check. `healthcheck` GETs /healthz from
# 127.0.0.1:$DEMOVIEWER_PORT and exits 0 on `ok`, 1 on anything else or no answer in 3 s.
HEALTHCHECK --interval=30s CMD ["/app/demoviewer-server", "healthcheck"]

# The server handles SIGTERM itself (graceful shutdown on `docker stop`).
CMD ["/app/demoviewer-server"]
