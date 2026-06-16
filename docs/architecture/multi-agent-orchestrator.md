# Multi-Agent Orchestrator

Multi-Agent Orchestrator 是 Runweave 在一个项目内驱动多个终端 agent 协作的控制面。它把“主 agent 决策、worker agent 执行、结果自动回流”收敛到后端状态、终端输入和本地 JSON 文件，不引入外部 LLM API。

## 当前边界

- 主 agent 是一个真实的 Runweave terminal session。启动 run 时，后端会创建或复用该终端，确保对应 CLI agent 就绪，然后把启动提示词投递进去。
- worker 也是 terminal session。主 agent 或控制面通过角色配置把具体 goal 派发给 worker，worker 的输出仍发生在终端内。
- 后端是控制面和结果路由器，不替代主 agent 做智能决策。它负责保存 run package、创建/复用终端、投递 prompt、接收 completion event、读取 outbox 并把结果直发回主 agent。
- 结果回流不等待主 agent 空闲。`OrchestratorService` 收到 worker completion 后读取 outbox，并把结构化结果作为新输入投递到主 agent 终端，由终端输入队列保证顺序。
- 人可以通过 inject 接口继续给 run 注入提示；如果 run 处于 `paused` 或 `need_human`，注入后会恢复为 `running`。

## 持久化文件

Orchestrator 的长期状态落在本机和项目目录中：

| 数据             | 路径                                            | 用途                                                             |
| ---------------- | ----------------------------------------------- | ---------------------------------------------------------------- |
| 角色定义         | `~/.runweave/roles.json`                        | 默认和用户保存的 worker 角色配置。                               |
| run package      | `<project>/.runweave/runs/<runId>.json`         | 单次 run 的主 agent、角色、目标、状态、human inbox 和 timeline。 |
| dispatch sidecar | `<project>/.runweave/dispatch/<sessionId>.json` | worker session 与 `runId`、`goalId`、role 的路由关系。           |
| worker outbox    | `<project>/.runweave/outbox/<sessionId>.json`   | worker 完成后交给结果路由器读取的结构化结果。                    |

`runId` 只允许字母、数字、下划线和连字符，避免跨目录写入。

## Run package 模型

共享协议定义在 `packages/shared/src/orchestrator.ts`。核心状态包括：

- `OrchestratorRunStatus`: `running`、`paused`、`need_human`、`done`、`failed`。
- `OrchestratorGoalStatus`: `pending`、`running`、`done`、`blocked`、`failed`。
- `OrchestratorRunPackage`: run 的项目、任务、主 agent 绑定、角色列表、goal 列表、人工输入和 timeline。
- `OrchestratorWorkerOutbox`: worker 完成时写出的摘要、文件产物、错误、状态和 goal 归属。

前端和外部工具应把 run package 当作展示与恢复状态的事实源；主 agent 的推理上下文仍在其终端对话内。

## HTTP API

所有接口由 backend 的 `/api/orchestrator` 路由提供，需要与现有 Runweave API 一样走登录态。

| 方法    | 路径                   | 说明                                           |
| ------- | ---------------------- | ---------------------------------------------- |
| `GET`   | `/roles`               | 读取角色定义。                                 |
| `PUT`   | `/roles`               | 覆盖保存角色定义。                             |
| `GET`   | `/runs?projectId=<id>` | 列出项目下的 run。                             |
| `GET`   | `/runs/:runId`         | 读取单个 run package。                         |
| `POST`  | `/runs`                | 创建 run，解析主 agent 终端并投递启动 prompt。 |
| `POST`  | `/runs/preview`        | 预览启动 prompt，不创建 run。                  |
| `POST`  | `/dispatch`            | 把 goal 派发给指定角色对应的 worker 终端。     |
| `POST`  | `/runs/:runId/inject`  | 向主 agent 注入人工提示。                      |
| `PATCH` | `/runs/:runId/status`  | 设置 run 状态。                                |

创建和派发接口支持 `binding.mode = "new" | "reuse"`。复用终端时需要提供已有 `sessionId`；新建终端时按角色或主 agent 的 terminal 配置创建。

## 事件回流

1. worker 完成后触发既有 terminal completion event。
2. Orchestrator 结果路由器根据 completion 事件解析 outbox 和 dispatch sidecar。
3. 如果 outbox 有 `runId` 且不是主 agent 自己的 completion，后端更新对应 goal 和 timeline。
4. run 不是 `paused` 且主 agent 终端存在时，后端把 worker result prompt 直接发送给主 agent。
5. timeline 记录 `worker_result` 和 `direct_send`，供 UI 展示。

Completion event 只用于 worker 结果回流。`TerminalState` 仍是 App、Web 和 CLI 判断终端是否 `agent_running` 的权威状态，不从 outbox 反推。

## 验证入口

纯文档或协议核对通常只需要静态检查：

```bash
git diff --check
```

涉及 Orchestrator 代码改动时，优先运行与改动面对应的包级检查：

```bash
pnpm --filter @runweave/shared typecheck
pnpm --filter @runweave/backend typecheck
pnpm --filter @runweave/frontend typecheck
```

需要验证终端 agent 控制面时，配合 `docs/cli/terminal-cli.md` 和 `docs/testing/runweave-cli-control-plane-test-cases.md` 中的 `rw terminal send --agent`、`terminal state`、`terminal history` 流程。

## 已知限制

- 控制面只保证输入已投递或入队，不保证 worker 业务任务成功完成。
- outbox 依赖 worker 按约定写入本地文件；缺失或格式不符时，结果路由不会凭空生成摘要。
- `paused` run 会记录 worker result，但不会自动直发回主 agent；需要人工恢复或注入后继续。
- 如果主 agent 终端不存在，后端只保存 worker result 和 timeline，不自动重建主 agent。
- Orchestrator 不修改代码、不运行测试，也不替用户合并结果；这些动作仍由主 agent、worker 或人工明确执行。
