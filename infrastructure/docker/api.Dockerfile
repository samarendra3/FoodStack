# syntax=docker/dockerfile:1.7
# FoodStack API - multi-stage build. Build context: repository root.
ARG NODE_VERSION=26

FROM node:${NODE_VERSION}-alpine AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
# Node 25+ no longer bundles corepack; install the pnpm version pinned in package.json.
RUN npm i -g pnpm@12.16.1
WORKDIR /repo

# Prune the monorepo to the api and its workspace dependencies.
FROM base AS prune
RUN npm i -g turbo@2.11.10
COPY . .
RUN turbo prune @foodstack/api --docker

FROM base AS build
COPY --from=prune /repo/out/json/ .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
COPY --from=prune /repo/out/full/ .
RUN pnpm turbo run build --filter=@foodstack/api \
 && pnpm --filter @foodstack/api deploy --prod --legacy /prod/api

FROM node:${NODE_VERSION}-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN apk add --no-cache tini
COPY --from=build --chown=node:node /prod/api/node_modules ./node_modules
COPY --from=build --chown=node:node /repo/apps/api/dist ./dist
COPY --from=build --chown=node:node /repo/apps/api/package.json ./package.json
USER node
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/v1/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]
