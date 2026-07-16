# Beta slot pool final code review（round 20）

## 状态

通过。对 `fc2362ca9614e5baa07e918c73fc7f611b292f0d..e7813bf8aa24137073c6c79252fd0e070d2b55ea` 的 81-path final diff 及 round 20 增量修复独立审查后，未发现开放 P0/P1。round 19 的 `beta-slot.shared-app-server-update-isolation` P1 已由原 `scenarioId=bsp013-shared-app-server-beta-isolation` 的可执行 review harness 确认修复。

## 已修复 P1

### `beta-slot.shared-app-server-update-isolation`：managed update target 与 shared discovery 已隔离

round 20 将 `buildUpdateArgs()` 的 `--app-server-home` 固定恢复为 slot-local `paths.appServerHome`，同时继续由 `buildUpdateEnv()` 通过 `RUNWEAVE_APP_SERVER_DISCOVERY=explicit`、shared home/token/url/lock/PID 将 Electron 绑定到 shared App Server。这样生产 `validateUpdateTargetIsolation()` 校验的是 slot-owned managed target，而不是 shared discovery home。

复用 round 19 的同一 review harness 后得到：

```text
scenarioId=bsp013-shared-app-server-beta-isolation
appServerMode=skip
managedAppServerHome=/tmp/runweave-review-round20-bsp013/.runweave/app-server-beta/pool-01
discoveryAppServerHome=/tmp/runweave-review-round20-bsp013/.runweave/app-server
isolationAccepted=true
separated=true
```

这解除 BSP-013 的结构性阻断：合法 shared App Server 不再在 Beta ready 前被 update target isolation 拒绝；slot retention/reset 仍只面向 slot-local App Server 路径。

## 非阻断残余项

### P2 `agent-team.review-target-preserves-target-commit`

`normalizeReviewTarget()` 仍丢弃 `targetCommit`，`completionReviewTargetMismatch()` 也未比较该字段。review harness 输出 `normalizedTargetCommit=null`。原始 outbox、pending review、targetTree、dispatchId 和 requestedAt 仍绑定本轮内容与派发，因此不构成 P0/P1，但会削弱归一化后审计信息。

## 已验证

- HEAD=`e7813bf8aa24137073c6c79252fd0e070d2b55ea`，tree=`3538a6c7d19581afabf2ea433611f69811abe98c`；81 个 changedPaths 与 final reviewTarget 完全一致，`git diff --check` 通过。
- 原 BSP-013 production-function review harness：exit 0，managed/discovery home 分离且 isolation accepted。
- `pnpm typecheck`、`pnpm lint`、`pnpm build`：全部 exit 0。
- `pnpm agent-team:verify-review-checkpoints`、`pnpm dev:session:verify`、`pnpm runweave:beta:verify`、`pnpm runweave:update:test-cases`：全部 exit 0。
- `pnpm activity:verify`、`pnpm work-history:verify`、`pnpm app-server:typecheck`、`pnpm app-server:verify`、`pnpm app-server:verify-state-sync`：全部 exit 0。
- `playwright-cli` 0.1.15 可用；`pnpm dev:status --json` 返回当前 source root 无 live Dev Session candidate。`playwright-cli list --json` 仅存在无关的 `terminal-risk-repro` attached session，未接管；浏览器验证标记为环境阻塞，不作为产品失败或通过证据。

## 产物

- 本报告：`docs/review/2026-07-16-beta-slot-pool-case-18-final-round-20.review.md`
- Pane outbox：`.runweave/outbox/6828267c.panel-a3561d45-31c3-4118-b88d-cad5524116e3.json`

## 建议下一步

代码审查门禁已通过；后续由 behavior gate 在隔离 HOME 中按 BSP-001 至 BSP-017 顺序执行真实产品验收。P2 可单独修复，不阻断本轮 Beta slot pool 收口。
