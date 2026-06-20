# Multi-Agent Orchestrator

Multi-Agent Orchestrator 让一个常驻主 Agent 终端调度多个带角色的 worker 终端。它的稳定边界是“终端里的 CLI agent + 后端薄路由 + 任务包状态”，不是服务端直接调用 LLM API。

## 当前架构

核心组成：

- 主 Agent 终端：一个长期存在的终端 agent，持有本次 run 的上下文，并通过 Runweave 的 Orchestrator 面板和调度接口派发 worker。
- Worker 终端：按角色执行具体工作，完成后通过 completion hook 和 outbox 回传结构化 summary。
- 后端结果路由器：消费 worker completion，匹配 run/goal，读取 outbox，把 worker result 直发回主 Agent 终端。
- 任务包：保存在项目 `.runweave/runs/<runId>.json`，是 UI、后端恢复和人工门禁的共享状态源。

后端只是薄路由和状态守卫，不替主 Agent 做智能决策。worker 完成结果会直接写入主 Agent 终端输入队列；如果主 Agent 当前还在一轮输出中，终端输入队列负责顺序消费，后端不轮询主 Agent 是否空闲。

## 默认角色

首期默认角色是 Do-A-IDEM 流程的三类 worker：

| roleId          | 名称     | 职责                                      |
| --------------- | -------- | ----------------------------------------- |
| `plan_reviewer` | 计划审查 | 审查主 Agent 的计划，只返回 summary。     |
| `code_agent`    | 代码执行 | 按主 Agent 指令实现任务，只返回 summary。 |
| `code_reviewer` | 代码审查 | 审查指定内容，只返回 summary。            |

历史默认角色 `coder`、`reviewer`、`tester` 如果仍是旧默认集合，会迁移到当前三角色。用户自定义角色仍可保存，但非内置 Do-A-IDEM 角色不会自动推进固定阶段。

## Do-A-IDEM 阶段

run 上有机器可读的 `currentPhase`，用于 UI 和后端约束当前流程位置：

```text
plan
→ plan_review
→ human_plan_approval
→ code
→ code_review
→ human_verify
→ finalize
→ done
```

稳定规则：

- 创建 run 后进入 `plan`。
- 派发 `plan_reviewer` 后进入 `plan_review`；该 worker 完成后进入 `human_plan_approval`，run 状态变为 `need_human`。
- 人工计划审批通过后进入 `code`；拒绝则回到 `plan`。
- 派发 `code_agent` 后保持或进入 `code`；该 worker 完成后默认进入 `code_review`。
- 派发 `code_reviewer` 后进入 `code_review`；该 worker 完成后进入 `human_verify`，run 状态变为 `need_human`。
- 人工验收通过后进入 `finalize`；拒绝则回到 `code`。
- 只有 `currentPhase=finalize` 时，run 才允许标记为 `done`。

人工门禁结论写入 `humanGateVerdicts[]`。拒绝必须带原因，避免只靠自由文本提示恢复状态。

## 每轮确认

`options.requireHumanConfirmationEachRound` 开启后，非人工门禁的阶段跳转也会生成 `pendingRoundConfirmation`：

- worker result 原本会自动从 `code` 进入 `code_review` 时，run 改为 `need_human`，并保留 `fromPhase`、`nextPhase`、`goalId`、worker summary。
- 用户批准后写入 `roundConfirmations[]`，清空 pending，进入 `nextPhase`。
- 用户拒绝时必须提供原因，run 回到 `fromPhase` 并记录拒绝结论。
- 已经是 `human_plan_approval` 或 `human_verify` 的跳转不会再套一层每轮确认。

## 自动门禁

run 创建时可以配置两类人工门禁自动通过选项：

- `options.autoApprovePlanGate`：进入 `human_plan_approval` 时自动写入通过结论，并继续到 `code`。
- `options.autoApproveVerifyGate`：进入 `human_verify` 时自动写入通过结论，并继续到 `finalize`。

自动通过仍会写入 `humanGateVerdicts[]`，并向主 Agent 注入门禁通过提示，避免状态跳转只存在于后端任务包里。它只跳过对应人工门禁，不跳过 worker dispatch、worker result 路由或 `finalize -> done` 的阶段约束。

## API 边界

主要 HTTP 入口位于 `/api/orchestrator`：

- `GET /roles`、`PUT /roles`：读取或保存角色定义。
- `POST /runs`：创建 run。
- `POST /runs/preview`：预览主 Agent 启动提示语。
- `GET /runs?projectId=...`、`GET /runs/:runId`：读取 run。
- `POST /dispatch`：派发 goal 到指定 role/worker。
- `POST /runs/:runId/inject`：向主 Agent 注入人工文本。
- `POST /runs/:runId/human-gate`：提交计划审批或人工验收。
- `POST /runs/:runId/round-confirmation`：提交每轮确认。
- `PATCH /runs/:runId/status`：暂停、继续、失败或在允许阶段标记完成。

worker 完成仍走终端 completion 链路，outbox 文件位于项目 `.runweave/outbox/<sessionId>.json`。

## 约束和风险

- Orchestrator 依赖真实终端 agent 和 completion hook。hook 缺失时，worker result 不会自动回流。
- 结果路由器只按结构化 outbox 和任务包匹配，不判断 worker 输出质量。
- `finalize` 是人工验收后的收尾阶段，提交、push 或发布动作应在该阶段由主 Agent 或指定终端完成，不能绕过 `human_verify`。
- 非内置角色可以参与协作，但不会触发 Do-A-IDEM 固定阶段自动推进。
