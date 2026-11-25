# Build from a reviewed Codey source archive. Runtime uses the resulting local image ID.
FROM node:24-bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates fd-find git ripgrep \
    && ln -s /usr/bin/fdfind /usr/local/bin/fd \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/codey
COPY . .
RUN npm ci --ignore-scripts --no-audit --no-fund \
    && node codey/hydrate-model-data.mjs
LABEL org.codey.sandbox="offline-v1"
USER 65534:65534
ENTRYPOINT ["/opt/codey/codey/sandbox/entry.sh"]
CMD []
