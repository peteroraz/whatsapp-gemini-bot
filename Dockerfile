FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    CHROMIUM_NO_SANDBOX=true \
    DATA_DIR=/data \
    PORT=3000

RUN apt-get update \
    && apt-get install -y --no-install-recommends chromium tini util-linux fonts-noto-color-emoji fonts-liberation ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev --omit=optional --ignore-scripts --no-audit --no-fund \
    && npm cache clean --force
COPY --chown=node:node index.js ./
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
COPY --chown=node:node scripts ./scripts
RUN mkdir -p /data && chown node:node /data \
    && chmod 700 /data && chmod 755 /app/scripts/entrypoint.sh

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["node", "scripts/healthcheck.js"]
ENTRYPOINT ["tini", "-g", "--", "/app/scripts/entrypoint.sh"]
CMD ["node", "index.js"]
