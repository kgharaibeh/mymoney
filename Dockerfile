# syntax=docker/dockerfile:1
# Multi-stage production image for MyMoney. The builder installs everything and
# compiles all packages + the web app; the runner keeps only the API's
# production dependency graph plus the built output, so dev tooling
# (TypeScript, Vitest, Vite, tsx, source files) is left behind.

# ---- builder: install all deps and build ----
FROM node:20-alpine AS builder
RUN apk add --no-cache openssl
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate
COPY . .
RUN pnpm install --frozen-lockfile \
  && pnpm --filter @mymoney/api prisma:generate \
  && pnpm -r build

# ---- runner: production dependencies + built artifacts only ----
FROM node:20-alpine AS runner
RUN apk add --no-cache openssl
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate
ENV NODE_ENV=production \
    STORE=postgres \
    PORT=3000 \
    WEB_DIST=/app/apps/web/dist

# Workspace manifests + lockfile, for a filtered production install.
COPY --from=builder /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=builder /app/packages/money-core/package.json packages/money-core/
COPY --from=builder /app/packages/domain/package.json packages/domain/
COPY --from=builder /app/apps/api/package.json apps/api/
COPY --from=builder /app/apps/web/package.json apps/web/

# Install only the API's production dependency graph (incl. workspace packages).
RUN pnpm install --prod --frozen-lockfile --filter @mymoney/api...

# Built artifacts from the builder.
COPY --from=builder /app/packages/money-core/dist packages/money-core/dist
COPY --from=builder /app/packages/domain/dist packages/domain/dist
COPY --from=builder /app/apps/api/dist apps/api/dist
COPY --from=builder /app/apps/api/prisma apps/api/prisma
COPY --from=builder /app/apps/web/dist apps/web/dist

# Generate the Prisma client into the production node_modules.
RUN pnpm --filter @mymoney/api prisma:generate

EXPOSE 3000

# Apply committed migrations, then start the API (which also serves the web app).
CMD ["sh", "-c", "pnpm --filter @mymoney/api prisma:migrate:deploy && node apps/api/dist/server.js"]
