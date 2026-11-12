# One image per service, built the way Render builds them (render.yaml). Used by docker-compose.selfhost.yml; see docs/self-host.md.
FROM node:22.23.2-bookworm-slim AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=1
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile

# Migrations, the first operator, and the destination's schema and role. Each step is safe to run again.
FROM base AS setup
CMD ["sh", "-c", "pnpm db:migrate && pnpm db:seed && if [ -n \"$DESTINATION_OWNER_URL\" ]; then pnpm destination:setup; fi"]

FROM base AS web
RUN pnpm --filter @billingrelay/web build
ENV NODE_ENV=production
EXPOSE 3100
CMD ["pnpm", "--filter", "@billingrelay/web", "start"]

FROM base AS worker
RUN pnpm --filter @billingrelay/worker build
ENV NODE_ENV=production
WORKDIR /app/apps/worker
CMD ["node", "dist/index.mjs"]

FROM base AS merchant-app
RUN pnpm --filter @billingrelay/example-merchant-app build
ENV NODE_ENV=production
EXPOSE 3200
CMD ["pnpm", "--filter", "@billingrelay/example-merchant-app", "start"]
