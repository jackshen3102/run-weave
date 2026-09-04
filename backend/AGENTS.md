# Backend

`backend/` 是 Runweave 的本机控制面：提供 HTTP/WebSocket API，管理 Terminal、Agent Team、
Activity、Evolution、认证与工作历史等运行时能力。

## 先看哪里

- 进程启动、HTTP 路由和 WebSocket 装配：`src/index.ts`
- 运行时服务组合与生命周期：`src/bootstrap/runtime-services.ts`
- HTTP 边界：`src/routes/`
- WebSocket 边界：`src/ws/`
- Terminal 运行时：`src/terminal/`
- Agent Team / Loop Engine：`src/agent-team/`
- 跨运行时合同：`../packages/shared/`

详细系统语义从 `../docs/architecture/README.md` 进入，不要依据历史 plan 或 prototype 推断。

## 边界

- `src/routes/` 和 `src/ws/` 只做传输层装配、鉴权、输入校验和响应映射；领域状态与生命周期留在
  对应能力目录。
- `src/agent-team`、`src/app-server`、`src/auth`、`src/terminal`、`src/voice` 不反向依赖
  `src/routes` 或 `src/ws`。
- 前后端或跨进程共享的 DTO、事件和协议修改必须落在 `packages/shared`，并同步检查所有真实消费者。
- 不把 Backend-only 存储模型或服务实现迁入 `packages/common`。
- 不新增单元测试；优先使用现有 `scripts/verify/`、测试计划和真实行为验证。

## 验证

```bash
pnpm --filter @runweave/backend typecheck
pnpm --filter @runweave/backend lint
pnpm architecture:check
```

若实际使用 `dev:session` 系列命令，必须按根 `AGENTS.md` 使用
`$toolkit:runweave-dev-session`。
