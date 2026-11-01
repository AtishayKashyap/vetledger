# syntax=docker/dockerfile:1.7
# Build context: repository root (pnpm workspace).
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile --filter @vetledger/api...
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter @vetledger/api build \
 && pnpm --filter @vetledger/api deploy --prod --legacy /out \
 && cp -r apps/api/dist /out/dist

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:${PORT:-4000}/healthz || exit 1
# Migrations run on boot (advisory-locked, so parallel instances are safe), then the server.
CMD ["sh", "-c", "node dist/migrate.js && exec node --enable-source-maps dist/server.js"]
