# -- Build stage: install deps, compile TypeScript, build the React client --
FROM node:20-bookworm AS builder

WORKDIR /app

# Install build dependencies for better-sqlite3 native module
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

# Copy dependency manifests first (layer cache)
COPY package.json package-lock.json ./
RUN npm ci

# Copy source and build
COPY tsconfig.json tsconfig.server.json ./
COPY src/ src/
COPY vite.config.ts ./
RUN npm run build

# Prune devDependencies so the final image is lean
RUN npm prune --production

# -- Runtime stage --
FROM node:20-bookworm

# Git is required at runtime for cloning repos and running git log
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy node_modules (already pruned) and built output from the builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./package.json

# Persistent volume for SQLite database and repo working copies
ENV RAT_DATA_DIR=/app/data
ENV RAT_HOST=0.0.0.0
ENV RAT_PORT=8787
VOLUME ["/app/data"]

EXPOSE 8787

CMD ["node", "dist/server/index.js"]
