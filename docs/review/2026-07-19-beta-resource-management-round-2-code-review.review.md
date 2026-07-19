# Beta 固定资源池管理 Round 2 代码复审

## 结论

审查不通过。Round 1 的 recorded PID P1 已修复并由同场景 harness 关闭；claim-first 修复仍有 1 条同 invariant 的 open P1：claim busy 时 failed-start cleanup 仍会进入 Session lock，把并发恢复已经写成 `stopped` 的 manifest 覆盖为 `stale/leaseRetained=true`。

## 审查范围

- Dispatch：`2a9f49a6-0e53-448f-abb2-33ae2fad05a5`
- 基线：`HEAD=af3f8b8091458935dde7b2c7b51c120d991de0fb`
- 本轮 Code Agent 修复文件：`scripts/dev-session/beta-slot-pool-process-inspection.mjs`、`scripts/dev-session/cli.mjs`、`scripts/dev-session/verify-beta-slot-pool.mjs`、`scripts/verify-dev-session.mjs`
- 必查 repairKey：`beta.pool-reset-requires-recorded-processes-absent`、`beta.pool-release-claim-before-session-lock`
- 当前 run 仍未提供冻结 `reviewTarget`，复审以 repair cycle、Code Agent outbox 和当前工作树为边界。

## Findings

### P1：claim busy 路径会把并发恢复完成态回写为 stale

`scripts/dev-session/cli.mjs:240-250` 在 claim 已被其它恢复者持有时构造 `claimFailure`，但 `scripts/dev-session/cli.mjs:251-325` 仍进入 owner Session lock。读取 manifest 后只对 `ready` 早退；即使并发恢复者已写完 `stopped`，当前 helper 仍在 `scripts/dev-session/cli.mjs:302-324` 把它覆盖为 `stale`、`leaseRetained=true`。

隔离 production-helper harness 已复现：使用真实 `acquireBetaSlotRecoveryClaim()` 持有 `pool-01` claim，并放置一个合法 `stopped` Beta manifest；调用当前 `cleanupFailedStart()` 后，manifest 从 `stopped` 变为 `stale`，且 `failure.leaseRetained=true`、`resetFailure="Beta slot recovery claim is busy"`。这对应真实并发窗口：janitor 在 owner Session lock 内完成 recovery、写 stopped 并释放 Session lock后，到 finally 释放 slot claim 前，failed-start cleanup 能观察到 claim busy，然后在 janitor 退出 Session lock后覆盖其终态。

该问题继续违反 BRM-009 的 release transaction 收敛和 BRM-010 的并发 start 单一结果。修复方向：没有拿到 claim 时不得进入 owner Session lock写失败终态；应由 claim owner 保持权威，或在有界重试后真正取得 claim，再在锁内重读 lease/manifest 并按当前终态决定是否无需处理。至少 `stopped/failed-with-released-lease` 不得被旧 failed-start 上下文回写。

## Resolved Findings

### 已关闭：存活 recorded PID 没有阻止 slot reset/release

`scripts/dev-session/beta-slot-pool-process-inspection.mjs:35-49` 现在把所有 `trusted && active` recorded entries 加入 `active` blocker。同场景 harness 返回 `active=["desktop"]`、`safeToReset=false`、`janitorRecovered=[]`、`reason=active-desktop`；真实子进程、原 lease inode 和 mutable marker 全部保留。`beta.pool-reset-requires-recorded-processes-absent` 可以关闭。

## 已执行检查

- `brm-live-recorded-process-corrupt-lease-review-harness-round2`：通过，旧 recorded PID P1 已关闭。
- `brm-start-failure-claim-busy-manifest-convergence-round2`：复现 open P1，`stopped -> stale`。
- `pnpm dev:session:verify`：通过；现有 `beta-start-failure-claim-before-session-lock` 仅检查源码索引顺序，未覆盖 claim-busy 终态竞争。
- `pnpm testplan:validate docs/testing/platform/beta-resource-management.testplan.yaml`：通过，12 个 required cases。
- `pnpm typecheck`：通过。
- `pnpm lint`：通过。
- `git diff --check`：通过。

所有 harness 均只使用隔离临时目录和本地生产模块，已清理；未启动、停止或访问任何真实 Dev Session/外部系统。
