# -- Build stage: install deps, compile TypeScript, build the React client --
FROM node:22-bookworm-slim AS builder

WORKDIR /app

# Copy dependency manifests first (layer cache)
COPY package.json package-lock.json ./
RUN npm ci

# Copy source and build
COPY tsconfig.json tsconfig.server.json ./
COPY src/ src/
COPY vite.config.ts ./
RUN npm run build

# Prune devDependencies so the final image is lean
RUN npm prune --omit=dev

# -- Runtime stage --
FROM node:22-bookworm-slim

# Git is required at runtime for cloning repos and running git log
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy node_modules (already pruned) and built output from the builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./package.json
RUN mkdir -p /app/data/repos /app/data/uploads && chown -R node:node /app/data

# Compose mounts persistent repository storage here; PostgreSQL lives on Neon.
ENV RAT_DATA_DIR=/app/data
ENV RAT_HOST=0.0.0.0
ENV RAT_PORT=8787

EXPOSE 8787

USER node
CMD ["node", "dist/server/index.mjs"]
