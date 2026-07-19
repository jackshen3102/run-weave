# Beta 固定资源池管理 Round 3 代码复审

## 结论

审查通过。Round 3 已关闭 `beta.pool-release-claim-before-session-lock`：failed-start cleanup 未取得 recovery claim 时直接返回，不再进入 Session lock 写 owner manifest；取得 claim 后会在 Session lock 内重读 manifest，并保留 `stopped` 或已释放 lease 的 `failed` 终态。Round 1 的 recorded PID reset blocker 也已再次独立复验。当前未发现未修复的 P0/P1。

## 审查范围

- Dispatch：`a5d76d7a-19ae-4913-a7f4-1da240f3484e`
- 基线：`HEAD=af3f8b8091458935dde7b2c7b51c120d991de0fb`
- Round 3 Code Agent 修复文件：`scripts/dev-session/cli.mjs`、`scripts/dev-session/verify-beta-slot-pool.mjs`、`scripts/verify-dev-session.mjs`
- 独立复验 repairKey：`beta.pool-reset-requires-recorded-processes-absent`、`beta.pool-release-claim-before-session-lock`
- 当前 run 未提供冻结 `reviewTarget`；本轮以 repair cycle、Code Agent outbox 和当前工作树为边界。

## Resolved Findings

### 已关闭：claim busy 后覆盖 stopped manifest

`scripts/dev-session/cli.mjs:241-255` 现在先取得 slot recovery claim；claim busy 时在进入 Session lock 前返回。取得 claim 后，helper 在锁内重读 manifest，并对不再保留 Beta lease 的终态早退。`scripts/dev-session/cli.mjs:274-289` 仅在持有 claim 时调用 finalizer，并显式传入 `claimAlreadyHeld: true`；`scripts/dev-session/cli.mjs:326-329` 在 finally 释放 claim。

两个隔离 production-helper harness 覆盖了原并发窗口的两端：

- `brm-start-failure-claim-busy-manifest-convergence-round3`：并发 recovery 持有 claim 时，执行前后均为 `stopped`，manifest 字节不变，未写 `leaseRetained` 或 `resetFailure`。
- `brm-terminal-manifest-after-own-claim-round3`：helper 自己取得 claim 后，在 Session lock 内读到 `stopped`，manifest 字节不变，退出后 recovery claim 已释放。

因此旧 failed-start 上下文已不能把并发 recovery 的完成态回写成 `stale/leaseRetained=true`，`beta.pool-release-claim-before-session-lock` 可以关闭。

### 已关闭：存活 recorded PID 没有阻止 slot reset/release

`scripts/dev-session/beta-slot-pool-process-inspection.mjs:35-49` 将所有 `trusted && active` recorded entries 纳入 reset blocker。Round 3 同场景 harness 返回 `active=["desktop"]`、`safeToReset=false`、`janitorRecovered=[]`；真实子进程、原 lease identity 和 mutable marker 全部保留。`beta.pool-reset-requires-recorded-processes-absent` 保持关闭。

## 已执行检查

- `brm-start-failure-claim-busy-manifest-convergence-round3`：通过，`stopped -> stopped`，manifest 完全不变。
- `brm-terminal-manifest-after-own-claim-round3`：通过，持有 claim 后重读终态并早退，manifest 完全不变，claim 已释放。
- `brm-live-recorded-process-corrupt-lease-review-harness-round3`：通过，live recorded PID 阻止 reset/release。
- `pnpm dev:session:verify`：通过，包含 claim-first、claim-busy preserve 与 recorded-process blocker 检查。
- `pnpm testplan:validate docs/testing/platform/beta-resource-management.testplan.yaml`：通过，12 个 required cases。
- `pnpm typecheck`：通过。
- `pnpm lint`：通过。
- `git diff --check`：通过。

所有 harness 只使用隔离临时目录和本地生产模块，临时目录已清理；未启动、停止或访问任何真实 Dev Session 或外部系统。
