# Beta slot pool incremental code review（round 23）

## 状态

通过。对 `e7813bf8aa24137073c6c79252fd0e070d2b55ea` 基线上的 3-file staged diff 独立审查后，未发现开放 P0/P1。index tree=`d34a8876623f5c649e7a68e7f8b8b24525275fbb` 与 reviewTarget 完全一致。

## 已解决问题

### `beta-slot.shared-app-server-stop-preserves-shared-service`

round 22 的真实 BSP-013 失败表明：自然 planner 选择 Backend dedicated / App Server shared-declared 后，Beta ready 成功，但 manifest 中的 stop control 没有携带 shared ownership，`runweave-beta stop` 因而调用不存在的 slot-local App Server CLI，导致 manifest stale、reset/retention 未执行、lease 未释放。

本轮修复把同一个 `buildBetaStopArgs()` 同时用于启动失败收尾和持久化到 manifest 的 `betaControl.args`：

- shared App Server 时显式携带 `--shared-app-server-lock-path <planner-validated-lock>`；
- dedicated App Server 时不携带该参数；
- `runweave-beta stop` 仅在没有 shared 标记时调用 slot-local App Server CLI；
- `stopSessionServices()` 继续执行 Beta control，随后 `finalizeBetaSlot()` 保持 reset → retention → stopped manifest → lease release 的既有顺序。

复用 `scenarioId=BSP-013-round21-shared-stop` 的 production-function review harness 得到：

```text
sharedPreserveMarker=true
dedicatedPreserveMarker=false
shared low-level stop exit=0
dedicated missing-local-CLI harness exit=1
```

这证明修复只跳过 shared App Server stop，没有把 dedicated cleanup 一并跳过。真实 ready→stop/janitor/retention 产品验收仍应由 behavior_verify 在隔离 HOME 中执行；本代码审查不以静态 harness 冒充行为通过。

## 回归点

- round 20 的 `beta-slot.shared-app-server-update-isolation` 仍保持 resolved：本轮没有改动 managed update target/discovery 分离逻辑，Beta/Update verifier 通过。
- `beta-slot.lease-release-requires-quiescence` 仍保持 resolved：stop consumer 仍在服务停止成功后才执行 reset/retention、写 stopped manifest 并释放 lease；Dev Session verifier 通过。

## 非阻断残余项

P2 `agent-team.review-target-preserves-target-commit` 仍存在于未改动的 Agent Team outbox 规范化链路；本轮 reviewTarget 的 `targetCommit` 按 prompt 原样为 `null`。该项不影响 staged tree、dispatchId 与 requestedAt 对本轮内容的绑定。

## 验证

- `git rev-parse HEAD`=`e7813bf8aa24137073c6c79252fd0e070d2b55ea`。
- `git write-tree`=`d34a8876623f5c649e7a68e7f8b8b24525275fbb`；3 个 staged paths 精确匹配；`git diff --cached --check` 通过。
- `BSP-013-round21-shared-stop` 参数与低层 stop 双分支 harness：shared exit 0，dedicated 缺 CLI exit 1，符合预期。
- `pnpm dev:session:verify`、`pnpm runweave:beta:verify`、`pnpm runweave:update:test-cases`、`pnpm typecheck`、`pnpm lint`：全部 exit 0；Update 20 cases passed。

## 产物

- 本报告：`docs/review/2026-07-16-beta-slot-pool-case-18-incremental-round-23.review.md`
- Pane outbox：`.runweave/outbox/6828267c.panel-a3561d45-31c3-4118-b88d-cad5524116e3.json`

## 建议下一步

代码审查门禁已通过，交由 behavior_verify 对 `BSP-013-round21-shared-stop` 执行新的真实 ready→stop→janitor/retention 复验，确认 shared PID/home/lock/token/event 摘要不变且 dedicated 生命周期完整收敛。
