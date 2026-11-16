# ==============================================================================
# Stage 1: Build Frontend Assets (Vite + React 19 + Tailwind CSS v4)
# ==============================================================================
FROM node:22-alpine AS builder

WORKDIR /app

# Install dependencies first for optimal Docker layer caching
COPY package.json ./
RUN npm install

# Copy application source & build static frontend bundle into /app/dist
COPY index.html vite.config.ts tsconfig.json metadata.json server.ts ./
COPY public ./public
COPY src ./src

RUN npm run build

# ==============================================================================
# Stage 2: Production Runtime (Express + Audio-ID / MusicBrainz / LRCLIB Proxy)
# ==============================================================================
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
# Enable tsx loader so `npm start` (`node server.ts`) executes TypeScript & extensionless imports directly
ENV NODE_OPTIONS="--import tsx"

# Copy runtime files and built assets from builder stage
COPY --from=builder --chown=node:node /app/package.json ./package.json
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/public ./public
COPY --from=builder --chown=node:node /app/src ./src
COPY --from=builder --chown=node:node /app/server.ts ./server.ts
COPY --from=builder --chown=node:node /app/metadata.json ./metadata.json

# Run as non-root user for container security
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT:-3000}/api/health || exit 1

CMD ["npm", "start"]
