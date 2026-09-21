FROM node:22.22.2-bookworm-slim AS build
WORKDIR /repo
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable && corepack prepare pnpm@10.6.2 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared packages/shared
COPY packages/push-gateway packages/push-gateway
RUN pnpm install --frozen-lockfile --filter @runweave/push-gateway... --ignore-scripts \
    && pnpm --filter @runweave/push-gateway exec npm rebuild better-sqlite3 \
    && pnpm --filter @runweave/push-gateway typecheck \
    && pnpm --filter @runweave/push-gateway deploy --legacy /output

FROM node:22.22.2-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build --chown=node:node /output /app
ENV NODE_ENV=production PUSH_GATEWAY_BIND=0.0.0.0 PUSH_GATEWAY_PORT=8092 \
    PUSH_GATEWAY_DATA_DIR=/data APNS_PRIVATE_KEY_FILE=/run/secrets/apns_key
USER node
EXPOSE 8092
ENTRYPOINT ["node", "--env-file=/run/secrets/gateway_env", "--import", "tsx"]
CMD ["src/index.ts"]
