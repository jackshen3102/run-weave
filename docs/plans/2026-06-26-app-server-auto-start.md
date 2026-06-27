# app-server CLI-owned 启动重构计划

## 背景

app-server 是 Runweave 本机全局 Event Center。它可以被 backend、hook、Electron 和 CLI
共同使用，但生命周期不应由产品客户端通过源码依赖启动。

## 目标架构

```text
Electron
  -> runtime release CLI entry
  -> rw app-server start
  -> bundled app-server executable
  -> lock/token/health
  -> backend discover/connect

Backend / hook
  -> discover only
  -> degraded when unavailable
```

## 决策

- CLI 是唯一产品级启动入口。
- Electron 可以启动 app-server，但只能通过 runtime release 中的 CLI entry。
- backend 不启动 app-server，只通过环境变量或状态目录发现。
- hook bridge 不启动 app-server。
- `@runweave/app-server` 不提供公共 `runtime/ensure` 子路径。
- shared 只保存 Node 侧发现协议：lock/token/health/status。

## 影响范围

- `packages/shared/src/app-server-node.ts`：共享 app-server 状态目录、lock、token、health 和 discover 逻辑。
- `packages/runweave-cli/src/commands/app-server.ts`：实现 `rw app-server status/start`，并通过子进程启动 bundled app-server。
- `electron/src/app-server-cli.ts`：Electron 通过 CLI entry 触发启动。
- `electron/src/runtime-release.ts`：runtime manifest 必须包含 `cli.entry` 和 `appServer.entry`。
- `backend/src/index.ts`：只 discover，不 ensure。

## 验收

```bash
pnpm app-server:verify
pnpm app-server:verify-cli-start
pnpm toolkit:verify-hooks
pnpm --filter @runweave/cli typecheck
pnpm --filter @runweave/electron typecheck
pnpm --filter @runweave/backend typecheck
pnpm --filter @runweave/shared typecheck
git diff --check
```
