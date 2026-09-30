FROM node:24-alpine AS build
WORKDIR /build/game
COPY game/package*.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY game/ ./
RUN npm run server:build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=7360
COPY --from=build --chown=node:node /build/game/dist-server/ ./dist-server/
COPY LICENSE NOTICE ./
USER node
EXPOSE 7360/tcp
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 CMD wget -qO- "http://127.0.0.1:${PORT}/health" >/dev/null || exit 1
ENTRYPOINT ["node", "dist-server/main.js"]
