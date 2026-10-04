FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
COPY public ./public
COPY scripts/build-offline.mjs ./scripts/build-offline.mjs
RUN npm run build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4174 STUDY77_DATA_DIR=/app/data STUDY77_CODEX_WORKER=0
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY server ./server
COPY scripts/backup-server.mjs ./scripts/backup-server.mjs
RUN mkdir /app/data /app/backups && chown node:node /app/data /app/backups
USER node
EXPOSE 4174
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4174/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "server/index.mjs"]
