# ---- build ----
# Built once on the runner's native platform: .output is plain JavaScript,
# so the same build serves amd64 and arm64 (npm under QEMU emulation crashes).
FROM --platform=$BUILDPLATFORM node:22-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY . .
RUN npm run build

# ---- runtime ----
FROM node:22-alpine
LABEL org.opencontainers.image.title="PackageFlow" \
      org.opencontainers.image.description="Web installer of PS4 PKG files over the local network" \
      org.opencontainers.image.source="https://github.com/demagoc3-cpu/playstation_installer" \
      org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    PACKAGEFLOW_DOCKER=1

WORKDIR /app
COPY --from=build --chown=node:node /src/.output ./.output
RUN mkdir -p /app/.data /games && chown node:node /app/.data /games

USER node
VOLUME ["/app/.data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/" >/dev/null || exit 1

CMD ["node", ".output/server/index.mjs"]
