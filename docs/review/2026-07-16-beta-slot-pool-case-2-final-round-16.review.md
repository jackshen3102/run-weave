# Beta slot pool / Agent Team final review（round 16）

## 状态

通过。对 `fc2362ca9614e5baa07e918c73fc7f611b292f0d..09926c4d8ddcad27051c434a2c1266eb4a6f63fa` 的 80-path final diff 独立审查后，未发现开放 P0/P1；记录 1 个不影响 BSP-017 代码内容或本次 dispatch 身份的 P2 审计缺口。

## 结论

- BSP-017 的关键顺序成立：slot lease 使用 ownerSessionId + nonce 绑定；stop/start 失败链路只有在 identity-safe stop、mutable reset、release metadata 落盘后才释放 lease。显式请求 `pool-01` 不会退化为其他 slot。
- mutable reset 只清理 user-data、App Server mutable state 和临时目录，保留 warm-state、Desktop/App Server runtime 与既有 warm App；retention 按 warm-state 的 current/previous 指针维护归属链，`mode=app` 的 `runtimeReleaseId=null` 不会被当作非法状态。
- round 15 的真实产品证据显示 Session A/B 均固定获得 `pool-01`，两轮 nonce 不同，B acquiredAt 晚于 A lastReleasedAt；两轮 stop 后 manifest、lease、mutable state 均安全收敛，Stable 摘要不变。Computer Use 不可用仅影响窗口证据，不构成产品失败。
- Agent Team final checkpoint 的 targetCommit、targetTree、changedPaths 与 dispatch 身份均被当前实现及 review harness 绑定；本轮 outbox 不复用任何旧 dispatch 结果。

## 关键发现

无 remaining P0/P1。

remaining P2：`agent-team.review-target-preserves-target-commit`。`AgentTeamWorkerOutbox.reviewTarget` 已允许携带 `targetCommit`，但 `backend/src/agent-team/outbox-resolver.ts` 的 `normalizeReviewTarget()` 未回传该字段，`completionReviewTargetMismatch()` 也未比较它。可执行 review harness 确认输入 `targetCommit=target-commit` 后规范化结果为 `null`。现有 `targetTree`、dispatchId 与 requestedAt 仍绑定当前被审代码内容和派发，因此不构成 BSP-017 的 P0/P1 阻断，但会降低 commit-level 审计完整性。

此前已确认的 P1 回归点均保持 resolved：

- `beta-slot.disk-budget-additive-estimate`
- `beta-slot.lease-release-requires-quiescence`
- `beta-legacy.cleanup-requires-all-components-inactive`
- `beta-slot.failed-manifest-lease-state`
- `beta-slot.janitor-single-owner-recovery`
- `agent-team.resume-preserves-failed-dispatch-role`
- `agent-team.starting-state-requires-readiness`

## 证据

- `git rev-parse HEAD` = `09926c4d8ddcad27051c434a2c1266eb4a6f63fa`；`git rev-parse HEAD^{tree}` = `d78d7bfec23ed16e7421b4fa49cbcb77081b46f0`；80 个 changedPaths 与 reviewTarget 一致；`git diff --check` 通过。
- `pnpm typecheck`、`pnpm lint`、`pnpm build` 全部 exit 0。
- `pnpm agent-team:verify-review-checkpoints` exit 0，覆盖 dispatch 持久化、starting readiness、failed role resume、repair finding 合同、final target/rebased anchor 等 100+ checks。
- `pnpm dev:session:verify` exit 0，覆盖 lease owner identity、reset barrier、stale/orphan recovery、single-owner janitor、warm preservation、failed manifest/lease 生命周期与磁盘门禁。
- `node scripts/dev-session/verify-beta-slot-pool.mjs` exit 0。
- `pnpm activity:verify`、`pnpm work-history:verify`、`pnpm app-server:typecheck`、`pnpm app-server:verify`、`pnpm app-server:verify-state-sync` 全部 exit 0。
- `pnpm --dir backend exec tsx -e <review-harness:review-target-preserves-target-commit>` exit 0，输出 `{"inputTargetCommit":"target-commit","normalizedTargetCommit":null,"dropped":true}`，确认 P2 审计缺口。
- BSP-017 产品证据：`.runweave/agent-team/atr_6828267c_20260715095649.json` 中 Session A `dvs-d74bea` 与 Session B `dvs-a4c2ca` 均为 `pool-01`；A nonce `5f65b1e4-129d-48af-a003-85d6fba38d8e`，B nonce `2708e186-9312-4537-9dcc-f4775aa49580`；A `lastReleasedAt=2026-07-15T18:42:57.061Z`，B `acquiredAt=2026-07-15T18:43:18.684Z`。

## 产物

- 本报告：`docs/review/2026-07-16-beta-slot-pool-case-2-final-round-16.review.md`
- Pane outbox：`.runweave/outbox/6828267c.panel-a3561d45-31c3-4118-b88d-cad5524116e3.json`

## 建议下一步

消费当前 dispatch outbox，确认 `case_2=pass` 且 `finalReviewedCommit=09926c4d8ddcad27051c434a2c1266eb4a6f63fa` 后结束本 run。
