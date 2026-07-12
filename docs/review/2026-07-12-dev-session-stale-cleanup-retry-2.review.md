# Dev Session Stale Cleanup Retry Re-review 2

## Findings

- **P1 严重：`cleanup-stale` 的重试收敛只修好了普通 dedicated 进程，带 `betaControl` 的 dedicated Electron/Beta 路径仍会陷入“永远可重试但永远清不掉”。** 这轮改动把 stopped-session 的重试范围缩到 `cleanupStatus === "skipped-stale-identity"` 且 `processIdentityMatches(...)` 的服务，并新增了 convergence 测试；对普通 dedicated backend/frontend 这是正确的。但 `cleanupStaleSessionServices()` 在真正执行重试时，只对 `!originalService.betaControl && processIdentityMatches(originalService.process)` 的 stale 服务执行停止；如果服务是带 `betaControl` 的 dedicated Electron/Beta 实例，且它之所以 stale 是 `inspectElectronHandshake()` 的 status/CDP drift 而不是进程签名漂移，那么它会同时满足“可重试”与“执行时继续 skipped”两个条件。结果是下次 `stop --cleanup-stale` 仍会把它选进 `retryServiceNames`，但本轮 cleanup 仍只会把它重新写回 `skipped-stale-identity`，状态机再次不收敛。定位：`scripts/dev-session/cli.mjs:338-348`、`scripts/dev-session/services.mjs:317-334`、`scripts/dev-session/service-runtime.mjs:272-315`、`scripts/dev-session/beta-service.mjs:183-209`。修复方向：要么在 `retryServiceNames` 里显式排除 `betaControl` 服务，避免假重试；要么在 `processIdentityMatches(service.process)` 仍成立时，允许对这类 dedicated Electron/Beta 服务走 `betaControl` 停止路径，并补一条对应验证用例。

## Residual Notes

- `pnpm dev:session:verify` 本轮通过，说明普通 dedicated 服务的 retry convergence 已经修好；问题只剩 `betaControl` 这条未被新测试覆盖的分支。
- `electron/resources/hooks/feishu_stop_notify.sh` 与 `plugins/toolkit/hooks/feishu_stop_notify.sh` 这轮没有发现同等级功能风险。

## Check Scope

- `scripts/dev-session/cli.mjs`
- `scripts/dev-session/services.mjs`
- `scripts/dev-session/service-runtime.mjs`
- `scripts/dev-session/beta-service.mjs`
- `scripts/dev-session/verify-registry.mjs`
- `scripts/verify-dev-session.mjs`
- `electron/resources/hooks/feishu_stop_notify.sh`
- `plugins/toolkit/hooks/feishu_stop_notify.sh`

## Command Summary

- `git status --short --branch`
- `git diff --stat`
- `git diff -- scripts/dev-session/cli.mjs scripts/dev-session/services.mjs scripts/dev-session/verify-registry.mjs scripts/verify-dev-session.mjs ...`
- `pnpm dev:session:verify`
- `rg` / `nl -ba` 交叉核对 `cleanup-stale` 重试筛选、`betaControl` 路径、Electron handshake 与新增验证覆盖
