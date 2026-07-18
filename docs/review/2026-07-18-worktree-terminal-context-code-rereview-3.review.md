# Worktree Terminal Context 代码复审（Round 13）

结论：通过。WTC-012 的 Agent Team missing-child 读取崩溃已修复，本轮未发现 open P0/P1，`AGT-REVIEW-GATE` 应记为 `pass`。

## Findings

未发现仍处于 open 状态的 P0/P1。

## 已关闭问题

### P0（resolved）：missing child 的 Agent Team GET 越过错误边界并终止 backend

修复同时闭合了 service 与 HTTP 两层：

- `AgentTeamServiceContext.assertReadableProjectRoot` 在读取 run-store 前拒绝不可用的 `wt:` child Project；`listRuns` 与 `getRunByTerminalSession` 两个读取分支均复用该 guard。
- `GET /api/agent-team/runs` 的带 `terminalSessionId` 和纯列表分支都通过 `handleServiceCall` 执行；`AgentTeamError(409)` 被转换为 JSON 响应，不再成为 Express 4 async handler 的未处理 rejection。

定位：`backend/src/agent-team/service-context.ts:83-109`、`backend/src/routes/agent-team.ts:204-228,416-440`。

独立 service harness 确认 missing child 的两个分支都在调用 run-store 前抛出 409，available child 与 legacy parent 仍进入原读取路径。独立 HTTP harness 确认两种 missing-child 查询均返回 409，随后合法 parent 请求仍返回 200，说明错误被响应边界吸收且服务继续工作。

code worker 的同场景真实产品交接还记录：Agent Team、New Terminal、Preview、Prototype 四类请求均为 409，existing Terminal 继续可用，backend 保持 ready，关闭最后一个 child Terminal 后 missing 节点消失。该证据作为修复交接使用，不替代后续独立 `behavior_verify`。

## 审查范围

- 核对 active reviewer dispatch `e245e50b-5397-4534-8a04-d351d2984505` 与最终 code dispatch `c7e118c4-c4cc-46e4-a5cd-88832d7e48f3`。
- 重新读取当前 live diff，重点检查 `service-context.ts` 的 guard 覆盖、`agent-team.ts` 的异步错误边界、合法读取兼容性，以及 missing context 与 run-store 路径解析的交互。
- 本轮 `reviewCheckpoint` 为 `null`，因此以 WTC-012 repair cycle、最新 code outbox 与当前 live source 为审查边界；未复用 round 6 的 verdict。

## 已执行验证

- service guard review harness：通过，两个 missing-child 分支均为 `AgentTeamError(409)`，available/legacy 调用计数符合预期。
- Express route review harness：通过，带/不带 `terminalSessionId` 的 missing-child 请求均为 409，后续健康请求为 200。
- `pnpm --filter @runweave/backend typecheck`：通过。
- `pnpm --filter @runweave/backend lint`：通过。
- `git diff --check -- . ':(exclude)docs/review'`：通过。

本轮仅给出 code review 结论；未启动新的 Dev Session，也不把 review harness 表述为 reviewer 自己完成的真实产品运行时验收。
