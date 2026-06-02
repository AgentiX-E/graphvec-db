# ============================================================
# Multi-stage Dockerfile for AgentiX GraphVec
# ============================================================
# Stage 1: Dependencies — Install production & dev deps
# ============================================================
FROM node:20-alpine AS deps

WORKDIR /app

# Install build tools needed for native modules (zeromq, etc.)
RUN apk add --no-cache python3 make g++ git

COPY package.json package-lock.json* ./
# Install ALL deps (including devDependencies needed for build/typecheck)
RUN npm ci

# ============================================================
# Stage 2: Build — TypeScript compilation
# ============================================================
FROM node:20-alpine AS build

WORKDIR /app

RUN apk add --no-cache python3 make g++ git

COPY package.json package-lock.json* ./
COPY --from=deps /app/node_modules ./node_modules
COPY tsconfig.json ./
COPY src/ ./src/
COPY scripts/ ./scripts/

# Compile TypeScript
RUN npm run build

# Copy type declarations and config
COPY vitest.config.ts ./
COPY vitest.fast.config.ts ./

# ============================================================
# Stage 3: Production — Minimal runtime image
# ============================================================
FROM node:20-alpine AS production

WORKDIR /app

# Security: create non-root user
RUN addgroup -g 1001 -S appgroup && \
    adduser -S appuser -u 1001 -G appgroup

# Install runtime system dependencies (zeromq)
RUN apk add --no-cache python3 libzmq

# Copy production-only deps
COPY package.json package-lock.json* ./
RUN npm ci --production && npm cache clean --force

# Copy built artifacts from build stage
COPY --from=build /app/dist ./dist
COPY --from=build /app/scripts ./scripts

# Create data & config directories
RUN mkdir -p /data /config && chown -R appuser:appgroup /data /config /app

# Default environment
ENV NODE_ENV=production
ENV NODE_OPTIONS="--max-old-space-size=4096"
EXPOSE 443

USER appuser

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:443/api/health || exit 1

ENTRYPOINT ["node", "dist/index.js"]
