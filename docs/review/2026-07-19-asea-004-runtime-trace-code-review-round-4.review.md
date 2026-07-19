# ASEA-004 RuntimeTrace Code Review（Round 4）

## 结论

通过。本轮未发现 open P0/P1。Round 3 的阻断项 `evolution.runtime-trace-discoverable-by-run-dispatch` 已修复：认证 API 现在可以用真实任务已知的 `runId`，以及可选的 `dispatchId`，发现对应 RuntimeTrace；查询保持 dispatch 精确归因，并拒绝缺失 `runId` 的无界请求。

本结论仅覆盖代码审查与 review harness。ASEA-004 所要求的多个真实 Agent Team code task、control/canary 实际暴露和后续 `behavior_verify`，仍应由行为验收 worker 独立执行；code review pass 不等同于 behavior pass。

## Findings

无 remaining findings。

## 已解决问题

### P1 resolved — RuntimeTrace 不能由真实任务的 run/dispatch 身份发现

- invariantKey：`evolution.runtime-trace-discoverable-by-run-dispatch`
- verificationMode：`structural`
- 修复：新增 `GET /api/evolution/runtime-traces?runId=<id>&dispatchId=<id?>`。`runId` 必填且有长度边界，`dispatchId` 可选并执行精确匹配；结果设置 `Cache-Control: no-store`。
- 鉴权：Evolution router 继续挂载在 `requireAuth` 之后。
- 独立 harness：run + dispatch 只返回 `trace-d2`；缺少 run 返回 `400 invalid_evolution_request`；不存在的 dispatch 返回 `200` 和空集合。

### P1 resolved — assignment 以 revisionId 为键导致同一 asset 换 revision 翻桶

- invariantKey：`evolution.assignment-stable-per-run-asset`
- verificationMode：`structural`
- 回归：`pnpm evolution:verify-activation` 通过，稳定 assignment 与 revision 审计合同保持成立。

### P1 resolved — 缺失 evolutionFeedback 的 exposed code outbox 静默留下空 trace

- invariantKey：`evolution.runtime-trace-dispatch-attribution`
- verificationMode：`structural`
- 回归：完整 activation verifier 覆盖 dispatch-scoped feedback、missing/advisory 观察、review/behavior/user correction/completed 等客观事件，执行通过。

## 独立证据

1. 代码边界：`backend/src/routes/evolution-activation.ts:13-18,91-119` 实现有界查询并保留 UUID 详情接口；`backend/src/index.ts:230-234` 证明路由受认证保护。
2. 独立 handler harness：目标 dispatch 返回 `traceIds=["trace-d2"]` 和 `Cache-Control=no-store`；缺少 `runId` 返回 400；不存在的 dispatch 返回空集合。
3. `pnpm evolution:verify-activation`：exit 0，ASEA-001 至 ASEA-007 全部 verifier 通过。
4. `pnpm testplan:validate docs/testing/evolution/agent-self-evolution-activation.testplan.yaml`：exit 0，7 个 required cases schema 有效。
5. `pnpm typecheck`、`pnpm lint`、`pnpm --filter @runweave/shared build`、`pnpm --filter @runweave/backend build`、`git diff --check`：全部 exit 0。

## 审查范围

只读审查；未修改实现代码或测试。仅新增本报告，并按调度合同更新指定 pane outbox。
