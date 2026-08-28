# Production image for MyMoney: builds every package + the web app, then runs
# the Fastify API which also serves the built web app as static files (one
# deployable service). Pair with docker-compose.prod.yml for Postgres.
FROM node:20-alpine

# OpenSSL is needed by the Prisma engines on Alpine (musl).
RUN apk add --no-cache openssl

WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate

# Install with the committed lockfile, then build everything.
COPY . .
RUN pnpm install --frozen-lockfile \
  && pnpm --filter @mymoney/api prisma:generate \
  && pnpm -r build

ENV NODE_ENV=production \
    STORE=postgres \
    PORT=3000 \
    WEB_DIST=/app/apps/web/dist

EXPOSE 3000

# Apply the schema, then start the API (which serves the web app too).
# `db push` is fine for a single-service deploy; switch to `prisma migrate deploy`
# once you adopt migration files.
CMD ["sh", "-c", "pnpm --filter @mymoney/api prisma:push --skip-generate && node apps/api/dist/server.js"]
