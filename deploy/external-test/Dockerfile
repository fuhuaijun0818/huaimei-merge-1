# External-test runtime deliberately omits ffmpeg. The controlled preview does
# not enable digital-human media generation, while omitting this optional OS
# package keeps a single-host deployment independent from apt mirror latency.
ARG NODE_IMAGE=node:22.22.1-bookworm-slim

FROM ${NODE_IMAGE} AS node-dependencies
WORKDIR /build/runtime
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

FROM ${NODE_IMAGE} AS advisor-build
WORKDIR /build/apps/acquisition-advisor
COPY apps/acquisition-advisor/package.json apps/acquisition-advisor/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY apps/acquisition-advisor/index.html apps/acquisition-advisor/vite.config.mjs ./
COPY apps/acquisition-advisor/public ./public
COPY apps/acquisition-advisor/src ./src
RUN ./node_modules/.bin/vite build --base=/advisor/

FROM ${NODE_IMAGE} AS runtime
ARG HUAMEI_BUILD_REVISION=unknown
ARG HUAMEI_BUILD_CREATED=unknown
LABEL org.opencontainers.image.title="Huamei AI SaaS MVP External Test" \
      org.opencontainers.image.revision="${HUAMEI_BUILD_REVISION}" \
      org.opencontainers.image.created="${HUAMEI_BUILD_CREATED}"
ENV NODE_ENV=production \
    PORT=4173 \
    HUAMEI_HOST=0.0.0.0 \
    HUAMEI_LEAD_STORE_FILE=/data/acquisition-leads.json \
    PHYSICIAN_AVATAR_RUNTIME_ROOT=/data/physician-avatar \
    PHYSICIAN_AVATAR_REFERENCE_ROOT=/app/assets/physicians/references \
    MINIMAX_REAL_CALL_ENABLED=false
WORKDIR /app
COPY --chown=node:node package.json server.mjs index.html styles.css ./
COPY --chown=node:node package-lock.json ./
COPY --from=node-dependencies --chown=node:node /build/runtime/node_modules ./node_modules
COPY --chown=node:node src ./src
COPY --chown=node:node server ./server
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node db ./db
COPY --chown=node:node config ./config
COPY --chown=node:node assets ./assets
COPY --from=advisor-build --chown=node:node /build/apps/acquisition-advisor/dist/client ./apps/acquisition-advisor/dist/client
RUN mkdir -p /data/physician-avatar && chown -R node:node /data
USER node
EXPOSE 4173 4180
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || '4173') + '/api/health').then((response) => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1));"]
CMD ["node", "server.mjs"]
