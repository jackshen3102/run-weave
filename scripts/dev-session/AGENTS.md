# Dev Session 控制面

`scripts/dev-session/` 规划并管理隔离的 Runweave Dev Session、固定 Beta Pool、surface 和资源清理。

## 先看哪里

- 用户命令入口：`cli.mjs`
- profile 与影响闭包规划：`planner.mjs`
- Session 持久化与查找：`registry.mjs`
- dedicated/shared 服务生命周期：`dedicated-services.mjs`、`shared-services.mjs`
- 固定 Beta Pool：`beta-slot-pool.mjs` 及 `beta-slot-pool-*.mjs`
- 外部使用合同：`../../docs/deployment/runweave-beta.md`
- 验收矩阵：`../../docs/testing/platform/development-control-plane.testplan.yaml`

## 边界

- `pnpm dev:session` 是未提交源码的唯一启动入口；不要通过低层模块或手工端口绕过 planner。
- Session 身份、profile、source root、surface 和清理必须来自 manifest / registry，不从进程名或默认端口猜测。
- 未知所有权的进程、目录、槽位和 lease 必须 fail closed；只清理能证明属于当前 Session 的资源。
- CLI 输出的 JSON 是工具合同。新增字段保持向后兼容，不把诊断日志写入 stdout。
- 修改生命周期后同步检查 start、status、open、stop 和 stale recovery，不只验证 happy path。

## 操作与验证

实际执行 `dev:session`、`dev:status`、`dev:open` 或 `dev:stop` 前，必须使用
`$toolkit:runweave-dev-session`。代码级验证入口：

```bash
pnpm dev:session:verify
pnpm testplan:validate docs/testing/platform/development-control-plane.testplan.yaml
```
