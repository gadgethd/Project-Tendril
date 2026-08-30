FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
COPY scripts ./scripts
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS runtime
ARG VERSION=dev
ARG REVISION=unknown
LABEL org.opencontainers.image.title="Project Tendril" \
      org.opencontainers.image.description="Local-first Chromium browser and web-research runtime for AI agents" \
      org.opencontainers.image.source="https://github.com/gadgethd/Project-Tendril" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.licenses="Apache-2.0"
RUN apt-get update \
    && apt-get install -y --no-install-recommends chromium chromium-sandbox dumb-init ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN groupadd --system tendril && useradd --system --gid tendril --create-home tendril
RUN mkdir -p /data /tmp/tendril && chown -R tendril:tendril /data /tmp/tendril
# The runtime only executes the compiled server; strip node's bundled npm to
# shrink the image and clear trivy HIGH/CRITICAL findings in npm's vendored
# toolchain (sigstore, pacote, tar, brace-expansion, ip-address, picomatch).
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
    /usr/local/bin/corepack /usr/local/lib/node_modules/corepack
WORKDIR /app
COPY --from=build --chown=tendril:tendril /app/package.json /app/package-lock.json ./
COPY --from=build --chown=tendril:tendril /app/node_modules ./node_modules
COPY --from=build --chown=tendril:tendril /app/dist ./dist
ENV NODE_ENV=production \
    TENDRIL_HOST=0.0.0.0 \
    TENDRIL_PORT=3210 \
    TENDRIL_EXECUTABLE_PATH=/usr/bin/chromium \
    TENDRIL_DATA_DIR=/data \
    TENDRIL_RUNTIME_DIR=/tmp/tendril
USER tendril
VOLUME ["/data"]
EXPOSE 3210
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:3210/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
ENTRYPOINT ["dumb-init", "--", "node", "dist/cli.js"]
CMD ["serve"]
