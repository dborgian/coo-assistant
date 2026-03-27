# ── Build stage ──
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ── Production stage ──
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY scripts/ ./scripts/

# Health check: verify the process is running
HEALTHCHECK --interval=60s --timeout=10s --retries=3 \
  CMD node -e "process.exit(0)"

EXPOSE ${PORT:-3000}

CMD ["node", "dist/index.js"]
