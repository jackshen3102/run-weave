# 随记云服务

独立 PostgreSQL HTTP 运行时；只依赖第三方库与 `@runweave/shared/suiji`。
不能导入 Backend、App Server、Electron、CLI 或 UI 实现。

- `src/http` 只处理传输；业务入口是 `records/service.ts`、`auth/service.ts`、`storage/attachments.ts`。
- 所有记录写入通过 `records/mutations.ts` 的单 client 事务。不得在 HTTP 或 MCP adapter 复制状态机。
- `src/mcp` 与 HTTP 共用记录服务和 `src/schema.ts`；actor 由入口决定，不能接受客户端指定。
- MCP 个人凭据独立于 App 会话。关闭或轮换通过服务配置，不改写既有 App 幂等摘要。
- 已执行迁移不可改写；追加 `.cjs` 迁移并保持默认事务，更新运行时支持的 schema 版本。
- API 只取得普通数据库角色；迁移和管理员命令单独取得迁移角色，凭据不进入参数或日志。

最小检查：`pnpm --filter @runweave/suiji-server typecheck`、`lint`、`build`。
真实合同与运行入口见 [README](./README.md)。
