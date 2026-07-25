# Agent Race 第 1 轮代码审查

## 结论

未通过 `AGT-REVIEW-GATE`。当前增量仍有 1 个可稳定复现的 P1 阻断问题；除该问题外，本轮未发现其他 P0/P1。

## Findings

### P1：创建与结束没有互斥，已结束的 Race 会被创建流程重新写回

- 位置：`backend/src/race/race-service.ts:191`、`backend/src/race/race-service.ts:223`、`backend/src/race/race-service.ts:231`、`backend/src/race/race-service.ts:347`、`backend/src/race/race-service.ts:352`
- 风险：`create()` 在资源供给完成前就把 `starting` 记录写入 store，因此其他客户端已经能读取并结束该 Race；但 `end()` 没有检查或取消 `creating`，清空 store 后，原 `create()` 仍会在失败收敛或后续阶段再次 `write(record)`。最终 DELETE 已返回成功，但 GET `/race` 又出现同一个 `raceId`，并可能留下结束请求未覆盖的后续资源。
- RACE-010 影响：该 Case 要求 DELETE 成功后 GET `/race` 为 `null` 且没有遗留 Race 运行记录；受控并发场景中这个不变量被直接违反。
- 受控复现：
  1. 用内存 store 和可暂停的 `RaceWorktreeSupply.plan()` 实例化真实 `RaceService`。
  2. 启动 `create()`，等待初始 `starting` 记录写入。
  3. 对已暴露的 `raceId` 调用 `end()`，确认 store 已为 `null`。
  4. 让暂停的 plan 以可控错误结束，等待原 `create()` 收敛。
- 期望：`end()` 返回后原创建流程不能再写回该 Race，最终 store 保持 `null`。
- 实际：harness 输出 `afterEnd:null`，随后 `finalRaceId` 恢复为原 `raceId`，`writes` 为 `["starting","failed"]`。
- 修复方向：把 create/end/remove 纳入同一生命周期互斥或取消协议；结束已暴露的 creating Race 后，所有后续阶段在创建资源和持久化前都必须检查同一代 Race 仍为当前活动记录，且结束必须等待或取消在途创建后再返回。

## 检查与证据

- `pnpm testplan:validate docs/testing/terminal/agent-race.testplan.yaml`：通过，13 个 required Case。
- `pnpm lint`：通过。
- `pnpm --filter @runweave/frontend build`：通过。
- `git diff --check -- . ':(exclude)docs/review'`：通过。
- `pnpm typecheck`：未通过；失败来自本次未修改的 Evolution 代码缺少 `zod-to-json-schema`、`@modelcontextprotocol/sdk` 依赖及其派生隐式 `any`，不是本 finding 的依据。Shared typecheck、frontend build、全仓 lint 均已通过。
- `traex models`：当前环境执行成功，返回可解析的逐行模型列表；未发现本轮模型目录解析的 P0/P1。

## 残余风险

本轮是只读代码审查，没有执行浏览器或真实产品行为验收；RACE-001 至 RACE-013 的页面、Terminal、Git 与重启行为仍应由 `behavior_verify` 独立验证，不能由本报告替代。
