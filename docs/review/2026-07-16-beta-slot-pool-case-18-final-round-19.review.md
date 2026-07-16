# Beta slot pool final code review（round 19）

## 状态

失败。对 `fc2362ca9614e5baa07e918c73fc7f611b292f0d..13c3a8794eb957ddd3263250bd950d708e87cfdf` 的 81-path final diff 独立审查后，确认 1 个开放 P1，直接阻断 BSP-013；另有 1 个非阻断 P2。

## P1 阻断

### `beta-slot.shared-app-server-update-isolation`：shared App Server home 被 Beta update isolation 确定性拒绝

`startDedicatedBeta()` 在选择 shared App Server 时使用 `--app-server=skip`，并把 shared lock 传给 `runweave-beta.mjs`。新实现随后将 global shared home 作为 `--app-server-home` 交给 `runweave-update.mjs`。但生产 `validateUpdateTargetIsolation()` 对 Beta 无条件要求 App Server home 等于 slot-local `~/.runweave/app-server-beta/pool-01`；该检查不因 `--app-server=skip` 放宽，因此 update 在 Electron/Backend/CDP ready 前立即失败。

可执行 review harness 使用生产 `resolveBetaPaths`、`buildUpdateArgs` 与 `validateUpdateTargetIsolation` 复现：

```text
appServerMode=skip
actualHome=/tmp/runweave-review-bsp013/.runweave/app-server
expectedSlotHome=/tmp/runweave-review-bsp013/.runweave/app-server-beta/pool-01
error=Refusing Beta update: App Server home must be .../app-server-beta/pool-01; received .../app-server
```

这直接违反 BSP-013：planner 合法选择至少一个 shared 服务时，Beta 应进入 ready，后续 stop/janitor/retention 才能证明 shared PID/home/lock/token/event 不受槽位清理影响；当前实现连 ready 前置都无法建立。

修复方向：`--app-server=skip` 时保持 update isolation 的 slot-local `--app-server-home`，仅通过显式 discovery env 将 Electron 绑定到 shared App Server；或者让 isolation 校验显式区分“被 update 管理的 home”和“仅用于 discovery 的 shared home”，但不能整体放宽 Beta 路径隔离。

## P2

`agent-team.review-target-preserves-target-commit` 仍未修复：`normalizeReviewTarget()` 丢弃 `targetCommit`，`completionReviewTargetMismatch()` 也未比较该字段。review harness 再次输出 `normalizedTargetCommit=null`。targetTree、dispatchId、requestedAt 仍保护内容与派发，因此该项不升级为 P0/P1。

## 已验证

- HEAD=`13c3a8794eb957ddd3263250bd950d708e87cfdf`，tree=`50c278d5bd1209dae88de7df4d1fcc79199007bb`，81 个 changedPaths 与 final reviewTarget 完全一致；`git diff --check` 通过。
- `pnpm typecheck`、`pnpm lint`、`pnpm build` 全部 exit 0。
- `pnpm agent-team:verify-review-checkpoints`、`pnpm dev:session:verify`、`pnpm runweave:beta:verify`、`pnpm runweave:update:test-cases` 全部 exit 0。
- `pnpm activity:verify`、`pnpm work-history:verify`、`pnpm app-server:typecheck`、`pnpm app-server:verify`、`pnpm app-server:verify-state-sync` 全部 exit 0。
- `playwright-cli` 0.1.15 可用；`pnpm dev:status --json` 返回无 live Dev Session candidate。`playwright-cli list --json` 仅发现无关的 `terminal-risk-repro` attached session，按仓库归因规则未接管；浏览器证据标记为环境阻塞，不冒充当前 checkpoint 验证。

## 产物

- 本报告：`docs/review/2026-07-16-beta-slot-pool-case-18-final-round-19.review.md`
- Pane outbox：`.runweave/outbox/6828267c.panel-a3561d45-31c3-4118-b88d-cad5524116e3.json`

## 建议下一步

修复 `beta-slot.shared-app-server-update-isolation` 后，用同一 scenarioId 的 review harness 先证明 `--app-server=skip` 不再触发路径拒绝，再由 behavior gate 在隔离 HOME 真实重跑 BSP-013；同时补一条调用生产 isolation validator 的回归覆盖，不能只断言生成的参数值。
