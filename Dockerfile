FROM node:22-bookworm-slim AS base

WORKDIR /app
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

COPY package.json pnpm-lock.yaml ./
RUN corepack pnpm install --frozen-lockfile
COPY . .

FROM base AS api
ENV HOST=0.0.0.0 PORT=3000
EXPOSE 3000
CMD ["sh", "-c", "corepack pnpm migrate:postgres && corepack pnpm dev:api"]

FROM base AS web
EXPOSE 5173
CMD ["corepack", "pnpm", "dev:web"]
