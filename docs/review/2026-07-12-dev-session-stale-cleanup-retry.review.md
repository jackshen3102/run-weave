# Dev Session Stale Cleanup Retry Re-review

## Findings

- **P1 严重：`--cleanup-stale` 的 stopped-session 重试会把“上次已成功停止”的 dedicated 服务重新标成 `skipped-stale-identity`，导致重试条件粘住、结果永远不收敛。** 这轮改动允许对 `state === "stopped"` 且曾有 `cleanupStatus === "skipped-stale-identity"` 的 manifest 再次执行 cleanup；但 `cleanupStaleSessionServices()` 对所有 dedicated 服务都会重新 `inspectSessionServices()`。那些在上一次 cleanup 中已经被成功停止的进程，此时因为 PID 已不存在，`health !== "live"` 且 `processIdentityMatches(...)` 为 `false`，会被重新写成 `skipped-stale-identity`。结果是：即便本次已经把原本卡住的 stale 进程清掉了，manifest 里仍会保留新的 `skipped-stale-identity`，下一次仍满足 `retryingPartialCleanup`，调用方也无法区分“还有真实未清理的脏进程”与“只是历史上已停止的服务”。这会让 cleanup 汇总和自动重试逻辑长期处于假阳性状态。定位：`scripts/dev-session/cli.mjs:337-349`、`scripts/dev-session/services.mjs:306-317`、`scripts/dev-session/services.mjs:352-391`。修复方向：重试时只针对上次真正 `skipped-stale-identity` 的 live owned process 重新尝试；已经成功停止且当前 PID 不存在的 dedicated 服务应保持既有成功状态，不能在后续 cleanup 中回退成 skipped。

## Residual Notes

- 本轮没有发现 `electron/resources/hooks/feishu_stop_notify.sh` 与 `plugins/toolkit/hooks/feishu_stop_notify.sh` 的同等级功能风险；现有改动更像通知文案收缩。
- 当前 `verify-registry` 仍只覆盖首次 `--cleanup-stale`，没有覆盖这次新增的 “stopped manifest 再次 cleanup-stale” 路径；上面的状态机问题就是这条未覆盖路径里暴露出来的。

## Check Scope

- `scripts/dev-session/cli.mjs`
- `scripts/dev-session/services.mjs`
- `scripts/dev-session/service-runtime.mjs`
- `scripts/dev-session/shared-services.mjs`
- `scripts/dev-session/verify-registry.mjs`
- `electron/resources/hooks/feishu_stop_notify.sh`
- `plugins/toolkit/hooks/feishu_stop_notify.sh`

## Command Summary

- `git status --short --branch`
- `git diff --stat`
- `git diff -- scripts/dev-session/cli.mjs scripts/dev-session/services.mjs electron/resources/hooks/feishu_stop_notify.sh plugins/toolkit/hooks/feishu_stop_notify.sh`
- `rg` / `nl -ba` 交叉核对 `cleanup-stale` 状态机、process identity 校验与通知脚本上下文
