# app-server auto start 代码评审

## 检查范围

- 当前工作区 `HEAD` vs live worktree，包括 tracked、deleted、untracked 文件。
- 重点覆盖 app-server singleton、CLI `rw app-server status/start`、Electron packaged runtime、backend discover-only、hook fallback、runtime manifest/build/install，以及相关文档和验证脚本。

## 发现与修复状态

- **P1 已修复：CLI 构建可能复制陈旧的 app-server dist，导致启动/验证/发布都运行旧代码。** `packages/runweave-cli` 的 build 现在会执行 bundle，再由 `scripts/copy-cli-app-server.mjs` 无条件先运行 `pnpm --filter @runweave/app-server build`，之后清理并复制最新 `app-server/dist`。`pnpm app-server:verify-cli-start` 已覆盖该路径。

- **P2 已修复：CLI 复制了一套 app-server discover/status 协议，和 shared 真实公共实现形成漂移风险。** `packages/runweave-cli/src/commands/app-server.ts` 现在只保留 CLI 启动编排和输出脱敏，状态解析、health、stale lock、state dir 解析都复用 `@runweave/shared/src/app-server-node`。CLI 入口通过 esbuild bundle 成自包含 `dist/index.js`，packaged CLI 运行时不再依赖源码路径。

- **P2 已修复：`pnpm-lock.yaml` 出现大规模格式 churn，实际依赖变化被噪音淹没。** lockfile 已恢复为仓库原格式，当前 diff 只保留 `packages/runweave-cli` importer 的语义依赖变更。

## 残余风险

- 未做浏览器页面验收，因为本次改动没有新增 Web/App 页面行为；若后续暴露 app-server 状态到浏览器页面，应按仓库约束使用 `$playwright-cli`。
- 检查方案中列出的 runtime manifest 损坏矩阵、backend consumer handler 失败重放等仍是自动化缺口；当前文档已记录，但本轮只验证了已有脚本覆盖面。

## 已执行验证

- `pnpm --filter @runweave/cli typecheck`
- `pnpm --filter @runweave/cli lint`
- `pnpm --filter @runweave/app-server typecheck`
- `pnpm --filter @runweave/app-server lint`
- `pnpm --filter @runweave/electron typecheck`
- `pnpm --filter @runweave/electron lint`
- `pnpm --filter @runweave/electron build`
- `pnpm --filter @runweave/shared typecheck`
- `pnpm --filter @runweave/backend typecheck`
- `pnpm --filter @runweave/backend lint`
- `pnpm app-server:verify`
- `pnpm app-server:verify-cli-start`
- `pnpm toolkit:verify-hooks`
- `pnpm runtime:build`
- `node electron/dist/cli/index.cjs app-server start`，配合 `RUNWEAVE_CLI_APP_SERVER_ENTRY=electron/dist/app-server/index.cjs`
- `git diff --check`

以上命令均通过。构建命令生成的 `.runtime-artifacts/`、`frontend/dist/`、`electron/dist/`、`app-server/dist/`、`packages/runweave-cli/dist/` 均为 ignored 产物，未改变 tracked 工作区。
