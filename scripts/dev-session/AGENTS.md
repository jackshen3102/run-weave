# Dev Session 控制面

`scripts/dev-session/` 规划并管理隔离的 Runweave Dev Session、固定 Beta Pool、surface 和资源清理。

## 先看哪里

- 用户命令入口：`cli.mjs`
- profile 与影响闭包规划：`planner.mjs`
- Session 持久化与查找：`registry.mjs`
- dedicated 服务启动与 shared 发现：`services/dedicated.mjs`、`services/shared.mjs`
- launcher 信号、进程组退出确认与超时升级：`services/process-stop.mjs`
- 固定 Beta Pool：`beta-pool/`
- 外部使用合同：`../../docs/deployment/runweave-beta.md`
- 验收矩阵：`../../docs/testing/platform/development-control-plane.testplan.yaml`

## 边界

- `pnpm dev:session` 是未提交源码的唯一启动入口；不要通过低层模块或手工端口绕过 planner。
- Session 身份、profile、source root、surface 和清理必须来自 manifest / registry，不从进程名或默认端口猜测。
- 未知所有权的进程、目录、槽位和 lease 必须 fail closed；只清理能证明属于当前 Session 的资源。
- CLI 输出的 JSON 是工具合同。新增字段保持向后兼容，不把诊断日志写入 stdout。
- 停止 detached 服务时只向身份匹配的 launcher 发送一次 SIGTERM，由 pnpm/tsx 自己转发；
  不同时向进程组发 SIGTERM。等待整个自有进程组退出，超时升级前再次校验 launcher 身份；
  launcher 消失但组内仍有进程时 fail closed，不把它当作 already-stopped。
- `stopResult.outcome` 的 `exited/forced/already-stopped` 只描述进程回收方式，不证明业务清理成功；
  Backend 优雅退出仍需 `shutdown.completed`、worker 和 owner lock 证据。Beta control 专属停止入口不变。
- 修改生命周期后同步检查 start、status、open、stop 和 stale recovery，不只验证 happy path。

## 操作与验证

实际执行 `dev:session`、`dev:status`、`dev:open` 或 `dev:stop` 前，必须使用
`$toolkit:runweave-dev-session`。代码级验证入口在 `verify/`：

```bash
pnpm dev:session:verify
pnpm dev:session:verify --process-stop-only
pnpm testplan:validate docs/testing/platform/development-control-plane.testplan.yaml
```

watcher、失败启动回滚、stale cleanup 与活跃终端关闭的专项计划：
[`dev-session-shutdown.testplan.yaml`](../../docs/testing/platform/dev-session-shutdown.testplan.yaml)。
`--process-stop-only` 使用真实 pnpm/tsx/Node fixture，不启动产品服务；不能替代计划中的浏览器验收。
