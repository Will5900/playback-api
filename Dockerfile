# Multi-stage build: TS compile → minimal node:22-alpine runtime.

FROM node:22-alpine AS build
WORKDIR /app

# Install deps with --include=dev for the build stage.
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- Runtime ----
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY --from=build /app/dist ./dist
COPY migrations ./migrations

EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:4000/healthz || exit 1

# Run pending migrations on every container start, then exec the server.
CMD sh -c "node dist/db/migrate.js up || exit 1; node dist/server.js"
