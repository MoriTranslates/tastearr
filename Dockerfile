# Pinned by digest (the multi-arch node:26-alpine index); Dependabot updates it. Keep in step with CI's Node 26 job.
FROM node:26-alpine@sha256:c6ad9e9c1d80f6eb607c26b4b0a132ff7a2344fad1c78ea3baa2a7d4c8de6d94 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts ./
COPY server ./server
COPY shared ./shared
COPY web ./web
RUN npm run build && npm prune --omit=dev

FROM node:26-alpine@sha256:c6ad9e9c1d80f6eb607c26b4b0a132ff7a2344fad1c78ea3baa2a7d4c8de6d94
LABEL org.opencontainers.image.title="Tastearr" \
      org.opencontainers.image.description="Learns your anime taste and recommends next season's shows for Sonarr" \
      org.opencontainers.image.source="https://github.com/MoriTranslates/tastearr" \
      org.opencontainers.image.licenses="GPL-3.0-only"
ENV NODE_ENV=production TASTEARR_CONFIG=/config TASTEARR_APPDATA=/appdata PORT=8383
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# Runs unprivileged by default (Unraid overrides this with --user 99:100).
RUN mkdir -p /config && chown node:node /config
USER node
VOLUME /config
EXPOSE 8383
HEALTHCHECK --interval=60s --timeout=5s CMD wget -qO- "http://127.0.0.1:${PORT:-8383}/ping" >/dev/null || exit 1
CMD ["node", "--no-warnings=ExperimentalWarning", "dist/server/index.js"]
