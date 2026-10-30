# syntax=docker/dockerfile:1.7
# Shared Dockerfile for all Next.js apps. Usage: --build-arg APP=admin|pos|kds|qr
ARG NODE_VERSION=26

FROM node:${NODE_VERSION}-alpine AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1
# Node 25+ no longer bundles corepack; install the pnpm version pinned in package.json.
RUN npm i -g pnpm@12.16.1
WORKDIR /repo

FROM base AS prune
ARG APP
RUN npm i -g turbo@2.11.10
COPY . .
RUN turbo prune @foodstack/${APP} --docker

FROM base AS build
ARG APP
# Public build-time configuration only; never pass secrets as build args.
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_APP_ENV=production
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL} NEXT_PUBLIC_APP_ENV=${NEXT_PUBLIC_APP_ENV}
COPY --from=prune /repo/out/json/ .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
COPY --from=prune /repo/out/full/ .
RUN pnpm turbo run build --filter=@foodstack/${APP}

FROM node:${NODE_VERSION}-alpine AS runtime
ARG APP
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0 APP=${APP}
WORKDIR /app
RUN apk add --no-cache tini
COPY --from=build --chown=node:node /repo/apps/${APP}/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/${APP}/.next/static ./apps/${APP}/.next/static
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT).then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["sh", "-c", "node apps/${APP}/server.js"]
