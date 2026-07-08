# Agent Team / Loop Engine

Agent Team 让当前终端里的主 Agent 调度同一 tmux session 内的 worker pane。它的稳定边界是“终端里的 CLI agent + 后端薄路由 + pane 级任务包状态”，不是服务端直接调用 LLM API。

`multi-agent-orchestrator.md` 这个文件名保留给旧链接；当前模块名、路由和数据模型都以 `agent-team` 为准。

## 当前架构

核心组成：

- 主 Agent pane：绑定当前 terminal session 的主 pane，持有本次 run 的上下文，并通过 Agent Team sidecar 推进拆分和执行。
- Worker pane：按角色运行在同一 tmux session 的额外 pane 中，完成后通过 completion hook 和 outbox 回传 summary 或验收结果。
- 后端结果路由器：消费 terminal completion 事件，按 run/worker/pane 匹配 outbox，把结果折叠回 Agent Team run。
- 任务包：保存在项目 `.runweave/agent-team/<runId>.json`，是 UI、后端恢复和人工介入的共享状态源。

后端只负责状态守卫、pane 创建、prompt 注入和 completion/outbox 路由，不替主 Agent 做智能决策。worker 完成结果先进入结构化 outbox，再由 Agent Team 服务按当前 phase 和 loop 状态处理。

## 默认角色

当前角色集合面向 Loop Engineering：

| roleId            | 职责                                               |
| ----------------- | -------------------------------------------------- |
| `code`            | 执行代码或文档改动。                               |
| `code_review`     | 复核改动，输出可执行的审查结论。                   |
| `behavior_verify` | 跑浏览器/行为验收，把通过、失败和证据写回 outbox。 |

worker 角色定义在 `packages/shared/src/agent-team.ts`；prompt 构造在 `backend/src/agent-team/prompt-builders.ts`。Agent Team 不再使用旧 `coder`、`reviewer`、`tester` 默认集合。

## 生命周期

一个 terminal session 同一时间最多绑定一个 active Agent Team run。run 的主状态为：

```text
intake
→ proposal
→ executing
```

稳定规则：

- 创建 run 后进入 `proposal`，状态为 `need_human`；`options.autoApproveSplit=true` 时直接进入 `executing`。
- 主 Agent 或用户仍可通过提案接口调整拆分提案。
- 人工确认拆分后创建或复用 worker pane，绑定 worker role、alias、`panelId` 和 `tmuxPaneId`，再向 worker pane 注入启动 prompt。
- `executing` 状态下，`behavior_verify` 的验收结果和代码 diff 作为 loop 进展信号。
- 连续无进展达到 `maxNoProgress`（默认 3）时触发熔断，run 进入 `need_human`，worker 冻结。
- 人工 note 恢复后清空重复失败 fingerprint，重新计数，并把 note 注入主 Agent 上下文。

## Loop Engine

Agent Team 的 Loop Engine 由 `backend/src/agent-team/loop.ts` 维护：

- `round`：验收轮次。
- `bestPassCount`：历史最高通过数量，作为客观进展信号。
- `errorFingerprints`：归一化失败签名，用来识别重复失败。
- `noProgressCount` / `maxNoProgress`：无进展熔断计数。
- `stableFailThreshold`：同一 case 连续失败达到阈值后才反弹给 code pane。

当 stable fail case 尚未反弹时，后端会通过 `buildBounceBackPrompt` 注入 code worker pane；当验收通过数提升或出现明确 diff 进展时，无进展计数会清零。熔断只冻结后续自动注入，不删除 pane 或 outbox，方便人工聚焦现场。

## API 边界

主要 HTTP 入口位于 `/api/agent-team`：

- `GET /runs?projectId=...&terminalSessionId=...`：读取项目或当前 terminal session 的 run。
- `GET /runs/:runId`：读取单个 run。
- `POST /runs`：在指定 terminal session 上创建 run。
- `POST /runs/:runId/propose-split`：提交主 Agent 或用户产出的拆分提案。
- `POST /runs/:runId/split-gate`：确认或驳回拆分提案。
- `POST /runs/:runId/round`：记录一轮验收结果或进展信号。
- `POST /runs/:runId/resume`：人工 note 介入并恢复 loop。
- `POST /runs/:runId/focus-pane`：聚焦属于该 run 的主 pane 或 worker pane。
- `GET /runs/:runId/export`：导出复盘包，供 CLI 和人工排障读取 run、pane、outbox、history tail 与验收摘要。

旧 `/api/orchestrator/*`、Orchestrator 前端 tab 和 shared `orchestrator` 类型已下线；当前 UI 入口是 Terminal tab 右键打开 Agent Team，并在右侧 sidecar 显示 Agent Team tab。

CLI 复盘入口：

```bash
rw agent-team export <runId> --tail 1000 --json
rw agent-team export --project-id <projectId> --terminal-session-id <terminalSessionId> --history none --json
rw agent-team export <runId> --plain
```

导出结果用于回看一次 run 的任务包、run-bound panels、session-other panels、pane-scoped outbox、legacy session outbox、acceptance summary 和 warnings。它不替代可见终端流程，也不自动提交、push 或发布代码。

## 约束和风险

- Agent Team 依赖真实终端 agent、tmux pane、completion hook 和 outbox。hook 缺失或 outbox 缺 pane/run 标识时，结果不会可靠回流。
- pty runtime 不支持 worker pane split；Agent Team 主流程应运行在可 split 的 tmux terminal session 上。
- 结果路由器只按结构化 outbox、pane metadata 和任务包匹配，不判断 worker 输出质量。
- active run 会保留 Agent Team tab；禁用 panel split 只能隐藏普通控制条，不能让 active run 从 UI 中消失。
- 代码提交、push 或发布动作仍应由主 Agent 或指定终端在可见流程中完成，不能绕过人工验收或熔断恢复。
