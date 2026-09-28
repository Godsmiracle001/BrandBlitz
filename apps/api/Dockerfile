# syntax=docker/dockerfile:1.7

# Issue #227: Harden Dockerfile with pinned base image, multi-stage build, and non-root user
# - Pinned to specific Node Alpine digest for reproducibility
# - Multi-stage build to minimize final image size
# - Non-root user for security
# Note: Update digest regularly by running: docker pull node:22.11-alpine && docker inspect node:22.11-alpine | grep -i digest

# ── Stage 1: Dependencies ───────────────────────────────────────────────────
# Pinned to Node 22.11-alpine with specific SHA256 digest
# To update: docker pull node:22.11-alpine && docker inspect node:22.11-alpine | grep -i digest
FROM node:22.11-alpine@sha256:acfe48528d337d95603fbeaf249da67a07c4082e22f2c6ec85cf0fdffcfd63ff AS deps
RUN corepack enable pnpm
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json ./apps/api/
COPY packages/stellar/package.json ./packages/stellar/
COPY packages/storage/package.json ./packages/storage/
RUN pnpm install --frozen-lockfile

# ── Stage 2: Dev (tsx hot reload) ────────────────────────────────────────────
FROM node:22.11-alpine@sha256:acfe48528d337d95603fbeaf249da67a07c4082e22f2c6ec85cf0fdffcfd63ff AS dev
RUN corepack enable pnpm
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules
COPY . .
WORKDIR /app/apps/api
EXPOSE 3000
CMD ["pnpm", "dev"]

# ── Stage 3: Builder (TypeScript → JavaScript) ──────────────────────────────
FROM node:22.11-alpine@sha256:acfe48528d337d95603fbeaf249da67a07c4082e22f2c6ec85cf0fdffcfd63ff AS builder
RUN corepack enable pnpm
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
WORKDIR /app/apps/api
RUN pnpm build

# ── Stage 4: Production dependencies (pruned) ────────────────────────────────
FROM node:22.11-alpine@sha256:acfe48528d337d95603fbeaf249da67a07c4082e22f2c6ec85cf0fdffcfd63ff AS prod-deps
RUN corepack enable pnpm
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json ./apps/api/
COPY packages/stellar/package.json ./packages/stellar/
COPY packages/storage/package.json ./packages/storage/
RUN pnpm install --frozen-lockfile --prod

# ── Stage 5: Runner (Production) ─────────────────────────────────────────────
# Issue #227: Run as non-root user for security
FROM node:22.11-alpine@sha256:acfe48528d337d95603fbeaf249da67a07c4082e22f2c6ec85cf0fdffcfd63ff AS runner

# Create non-root user and group
RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001

WORKDIR /app

# Copy dependencies and built files with proper ownership
COPY --from=prod-deps --chown=nodejs:nodejs /app/node_modules ./node_modules
COPY --from=builder  --chown=nodejs:nodejs /app/apps/api/dist ./dist
COPY --from=builder  --chown=nodejs:nodejs /app/packages ./packages

ENV NODE_ENV=production

# Switch to non-root user
USER nodejs

EXPOSE 3000
STOPSIGNAL SIGTERM

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "dist/index.js"]
