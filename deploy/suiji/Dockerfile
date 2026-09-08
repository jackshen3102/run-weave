FROM node:22.22.2-bookworm-slim AS build
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@10.6.2 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared packages/shared
COPY packages/suiji-server packages/suiji-server
RUN pnpm install --frozen-lockfile --filter @runweave/suiji-server... --ignore-scripts
RUN pnpm --filter @runweave/suiji-server build && pnpm --filter @runweave/suiji-server deploy --prod --legacy /output

FROM node:22.22.2-bookworm-slim
ARG CODEX_VERSION=0.153.4
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global @openai/codex@${CODEX_VERSION} && npm cache clean --force
WORKDIR /app
COPY --from=build --chown=node:node /output /app
COPY --chown=node:node deploy/suiji/entrypoint.mjs /app/entrypoint.mjs
ENV NODE_ENV=production SUIJI_HOST=0.0.0.0 SUIJI_PORT=4783 SUIJI_STORAGE_DIR=/data/attachments
ENTRYPOINT ["node", "/app/entrypoint.mjs"]
CMD ["serve"]
