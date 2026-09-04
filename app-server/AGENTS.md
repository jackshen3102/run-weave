# App Server

`app-server/` 是独立的本机事件与状态服务，负责持久化 Agent thread 事件、投影状态、提供
HTTP/WebSocket 消费入口，并以 singleton 运行。

## 先看哪里

- 进程装配与生命周期：`src/index.ts`
- 事件写入与订阅：`src/events/center.ts`
- append-only 存储：`src/events/store.ts`
- 状态投影：`src/state/projector.ts`、`src/state/store.ts`
- HTTP/WebSocket 边界：`src/server/http.ts`、`src/server/websocket.ts`
- 发现、配置与 singleton：`src/config.ts`、`src/singleton.ts`
- 当前架构合同：`../docs/architecture/app-server-architecture.md`

## 边界

- App Server 是独立进程，不是 `backend/` 的子模块；Backend 通过
  `backend/src/app-server/` 集成。
- 事件合同、发现信息和跨进程类型进入 `packages/shared/app-server*`。
- 事件日志是事实源，状态文件是可重建投影；不要让投影反向成为事件真相。
- 保持 singleton、token 鉴权和 at-least-once consumer cursor 语义；修改前同时阅读
  `../docs/architecture/app-server-event-center.md`。
- 不新增单元测试；使用仓库现有 `app-server:verify*` 脚本和真实进程行为验证。

## 验证

```bash
pnpm app-server:typecheck
pnpm --filter @runweave/app-server lint
pnpm app-server:verify
```
