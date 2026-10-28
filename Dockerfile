# syntax=docker/dockerfile:1
# community_service — multi-stage Bun image.
# Images are built by CI (the agent runtime has no Docker daemon).

FROM oven/bun:1 AS base
WORKDIR /app

# ---- dependencies (production only) -------------------------------------------------
FROM base AS deps
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# ---- build (type-check + bundle) ----------------------------------------------------
FROM base AS build
COPY package.json bun.lock tsconfig.json ./
RUN bun install --frozen-lockfile
COPY src ./src
RUN bun build ./src/index.ts --target bun --outdir ./dist --sourcemap=external

# ---- runtime (non-root, slim) -------------------------------------------------------
FROM oven/bun:1-slim AS runtime
ENV NODE_ENV=production
ENV BUN_ENV=production
WORKDIR /app

# `bun` (uid 1000) ships with the base image; run as that unprivileged user.
COPY --chown=bun:bun --from=deps /app/node_modules ./node_modules
COPY --chown=bun:bun --from=build /app/dist ./dist
COPY --chown=bun:bun package.json ./

USER bun
EXPOSE 3000

# `--smol` keeps the memory footprint predictable for the hot internal access path.
CMD ["bun", "run", "--smol", "dist/index.js"]
