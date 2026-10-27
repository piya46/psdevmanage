FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
COPY apps/web/package.json apps/web/package.json
COPY packages/core/package.json packages/core/package.json
COPY services/gateway/package.json services/gateway/package.json
COPY services/identity/package.json services/identity/package.json
COPY services/documents/package.json services/documents/package.json
COPY services/signing/package.json services/signing/package.json
COPY services/audit/package.json services/audit/package.json
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/assets ./assets
COPY --from=build /app/scripts/setup.mjs ./scripts/setup.mjs
COPY --from=build /app/scripts/health.mjs ./scripts/health.mjs
COPY --from=build /app/scripts/init-cloud-db.mjs ./scripts/init-cloud-db.mjs
COPY --from=build /app/package.json ./package.json
RUN mkdir -p /bootstrap/gateway /bootstrap/identity /bootstrap/documents /bootstrap/signing /bootstrap/audit && chown -R node:node /bootstrap
USER node
ENV HOST=0.0.0.0 PSTON_MODE=demo NODE_ENV=development PSTON_DATA_DIR=/data
CMD ["node", "dist/services/gateway/index.js"]
