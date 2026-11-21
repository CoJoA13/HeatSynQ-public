FROM node:26-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci

FROM node:26-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# prisma.config.ts declares its datasource via env("DATABASE_URL"), which throws at
# config-load time (before any command logic runs) if the var is unset. `prisma generate`
# never connects to a database, so a placeholder is enough to satisfy the check; the real
# value is supplied at container runtime via compose and overrides this build-time default.
ENV DATABASE_URL="postgresql://build:build@localhost:5432/build"
RUN npx prisma generate && npm run build && npm prune --omit=dev

FROM node:26-alpine AS run
WORKDIR /app
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
# Phase 8C §6.1: "Back up now" runs pg_dump inside the app container, so the run image needs the
# client tools. The MAJOR must match the db service's server — pg_dump hard-refuses a server newer
# than itself — so this stays version-locked to docker-compose.yml's `postgres:` image tag, the same
# rule the backup container already follows. pg_restore ships alongside it for the restore runbook.
RUN apk add --no-cache postgresql18-client
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
COPY --from=build /app/prisma ./prisma
# Prisma 7 moved the datasource URL out of schema.prisma's `datasource` block (no more
# `url = env("DATABASE_URL")` there) and into prisma.config.ts's `datasource.url`. `prisma
# migrate deploy` reads the config file, not the schema, for that URL, so prisma.config.ts
# has to ship in the run image too — without it the CLI fails at container start with
# "The datasource.url property is required in your Prisma config file when using prisma
# migrate deploy," even though DATABASE_URL is set correctly in the environment.
COPY --from=build /app/prisma.config.ts ./
# `prisma migrate deploy` at container start needs the full "prisma" CLI. Copying only
# node_modules/prisma + node_modules/@prisma (as CLI docs historically suggest) is not
# enough on Prisma 6.19: the CLI unconditionally loads @prisma/config, which pulls in its
# own real dependencies (effect, c12, deepmerge-ts, empathic) that npm hoists to the
# top-level node_modules rather than nesting under @prisma/config — cherry-picking two
# subfolders leaves those missing ("Cannot find module 'effect'"), and also drops
# node_modules/.bin/prisma so `npx prisma` can't resolve at all ("prisma: not found").
# Copying the full, already-resolved node_modules from the build stage is the reliable
# fix and overlays cleanly onto (a superset of) the standalone trace above.
COPY --from=build /app/node_modules ./node_modules
COPY scripts/container-health.mjs ./scripts/container-health.mjs
COPY --from=build /app/scripts/public-runtime ./scripts/public-runtime
# Next's image optimizer keeps a disk LRU cache at `<distDir>/cache/images`. It is created lazily,
# on the FIRST `/_next/image` request rather than at server start. The line numbers below are Next
# 16.4.0's, under node_modules/next/dist/server; they move with every Next release, so find the
# named function when they no longer match. next-server.js constructs an ImageOptimizerCache per
# image request (next-server.js:183), whose constructor kicks off the shared LRU init
# (`getOrInitDiskLRU`, image-optimizer.js:350), which begins with a recursive `mkdir` of that
# directory (lib/disk-lru-cache.external.js:36). Every path COPYed above lands
# root-owned 0755, so an installation that runs this image as a non-root user — the maintained one
# uses `user: "1000:1000"` with `cap_drop: [ALL]` and `no-new-privileges:true` — cannot create it.
# The mkdir then fails EACCES; nothing is awaiting that init promise yet, so the rejection surfaces
# as an `unhandledRejection` log line (`unhandledRejectionListener`,
# node-environment-extensions/process-error-handlers.js:82, which lib/router-server.js:727
# registers), the optimized image is served anyway as a permanent cache MISS, and the write attempt
# logs again (`Failed to write image to cache`, image-optimizer.js:460). Six
# log lines per image request, forever, and disk caching that never works. Creating the directory
# here, owned by uid/gid 1000 (alpine's `node` user — the uid the maintained installation runs as),
# is the packaging half of the contract: no bind mount required, and a root-run container is
# unaffected. 0700 rather than something broader because nothing else in the image reads it, and
# deliberately NO `USER node`: docker-compose.yml starts this image as root with a bind-mounted
# ./backups that Docker creates root-owned, so switching the image's default user would break
# "Back up now" for installations that never asked for a runtime-user change.
RUN mkdir -p /app/.next/cache \
 && chown 1000:1000 /app/.next/cache \
 && chmod 0700 /app/.next/cache
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 CMD ["node", "scripts/container-health.mjs"]
EXPOSE 3000
CMD ["node", "scripts/public-runtime/public-command.mjs", "container"]
