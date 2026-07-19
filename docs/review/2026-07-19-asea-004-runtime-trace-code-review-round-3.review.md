# ASEA-004 RuntimeTrace 独立代码复审 Round 3

## 结论

不通过。Round 2 的两个 blocking invariant 已闭合：同一 `assetId` 跨 revision 的 assignment 稳定；缺失或错引 feedback 会形成与 exposed trace 关联的显式 `missing` 观察。但本轮确认 1 条新的 blocking P1：真实 Agent Team 任务完成后，调用方只知道 run/dispatch，随机 `traceId` 没有写回 run/dispatch，认证 API 又只支持按已知 traceId 查询，导致 `ASEA-004` 的“执行任务并读取 RuntimeTrace”无法从真实产品入口完成。

## 审查边界

- Dispatch：`285990cb-08b9-4e30-8376-b9839e6e4791`
- Run：`atr_dd8353fe_20260719020754`，Round 3。
- `reviewTarget=null`、`reviewCheckpointMode=disabled`；以两个 Round 3 repair cycle、Code Worker `fixVerifications` 和 ASEA-004 的真实读取合同为边界。
- 只写本报告和 pane-scoped outbox；未修改实现、配置、测试或测试计划。

## Remaining Finding

### P1：RuntimeTrace 不能由真实任务的 run/dispatch 身份发现

`backend/src/evolution/injection/memory-provider.ts:89-110` 每次生成随机 `traceId`；`backend/src/agent-team/service-execution.ts:193-210` 调用 provider 后只保留 `result.context`，没有把 traceId 写回 Agent Team run/dispatch。`backend/src/routes/evolution-activation.ts:85-98` 只暴露 `GET /runtime-traces/:traceId`，而 route inventory 没有按 `runId`/`dispatchId` 查询或列出 trace 的端点。

review harness 枚举生产 router，得到四条 route：candidates、policy GET/PUT、`/runtime-traces/:traceId`；`hasTraceLookupByRunOrDispatch=false`。真实任务持有的 run/dispatch 身份无法推导随机 UUID，也不能通过 CLI/Web 查询，直接阻断 Case 第一步“执行匹配任务并读取 RuntimeTrace”。

修复方向：提供认证的 run/dispatch 查询，例如 `GET /api/evolution/runtime-traces?runId=...&dispatchId=...`，或把 traceId 持久化到对应 Agent Team dispatch 并从已有 run API 返回；必须沿用现有 auth，不能要求行为验收直接读 `learning.sqlite`。

## Resolved Findings

### P1 resolved：`evolution.assignment-stable-per-run-asset`

assignment hash 已使用 `learningScopeId + runId + assetId + policyRevision`；同一 asset 从 `rev-a-1` 更新到 `rev-a-2` 后 bucket/hash 完全相同，同时 assignment 仍记录实际 revisionId。独立 harness 输出 `sameAssetRevisionStable=true`、`revisionAudited=true`。

### P1 resolved：`evolution.runtime-trace-dispatch-attribution`

code completion 现在总是调用 dispatch-scoped observer。已暴露上下文但 outbox 省略 feedback 时，会写一条 `disposition=missing`、`missing=true`、`advisoryOnly=true` 的事件；control trace 不产生伪 feedback，合法三态仍原样记录，错引 revision 形成明确 missing 观察。该行为符合 Round 2 finding 既定 expected 的“协议纠正或明确缺失观察”。

## 验证

- `asea-004-stable-asset-revision-change`：通过，bucket/hash 稳定且 revision 审计更新。
- `asea-004-feedback-omission-silently-accepted`：通过，`recorded=1` 且生成 missing feedback 观察。
- `asea-004-runtime-trace-discovery`：失败，生产 router `hasTraceLookupByRunOrDispatch=false`。
- `pnpm evolution:verify-activation`：通过。
- `pnpm testplan:validate docs/testing/evolution/agent-self-evolution-activation.testplan.yaml`：通过，7 条 required Case。
- `pnpm typecheck`：通过，9 个 workspace project。
- `pnpm lint`：通过。
- `pnpm --filter @runweave/shared build && pnpm --filter @runweave/backend build`：通过。
- `git diff --check`：通过。

## 残余风险

本轮只完成结构性 code review。补齐 trace 发现入口后，仍必须由 behavior worker 用多个真实 code task 读取 control/canary trace，并验证 review/behavior、repair、用户纠偏与完成事件的真实闭环。
