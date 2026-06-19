# Multi-Agent Orchestrator 系统性 Test Case

- 日期: 2026-06-17
- 范围: Multi-Agent Orchestrator（常驻主 Agent 终端 + 薄结果路由器 + worker 终端 + Do-A-IDEM 人工门禁）
- 设计依据: `docs/architecture/multi-agent-orchestrator.md`（整体形态、直发回灌、零轮询闭环、Do-A-IDEM 阶段与人工门禁）
- 已并入: 每轮确认子集（本文档作为其超集，不再维护单独的 round confirmation 测试文档）

> 执行规则：执行开始后不修改本文档。某个 case 若前提不成立或被判定无效，停止该 case 并记录原因，不要临时改写步骤来“凑通过”。

---

## 0. 测试理念与最终目标对齐

本文档面向的最终目标（来自设计稿 §1）：

> 用户配置好角色与终端、提交一个任务/计划后，系统能自主驱动多个带角色的 worker 终端协同完成
> 「写代码 → review → 修复 → 验证 → 收尾」，**默认无人值守，但人可在关键节点随时介入**，
> 核心理念是 **Human-in-the-loop, Agent-in-the-loop**。

为支撑「现在能手动逐步执行 / 后续能自动化、仅关键节点人工介入」，每个 case 都标注两个属性：

- **执行方式**：当前如何手动跑通这一步。每一步都要求执行者人工确认实际现象，再勾选通过。
- **自动化定位**：该步骤在未来自动化里的角色。三类：
  - 🟢 `AUTO` —— 可完全自动化（确定性断言：API 返回、JSON 字段、阶段推进、典型 UI 文本）。
  - 🟡 `SEMI` —— 可自动化触发，但断言依赖真实 agent / 终端运行时行为，需要快照或宽松匹配。
  - 🔴 `GATE` —— **关键人工节点**，自动化流程必须在此停下，等人给出 verdict / 验收结论后才继续（`human_plan_approval`、`human_verify`、需求澄清、真实端到端验收）。

> 设计取向：`GATE` 节点是「设计上要求人来负责」的点，不是「现在做不了自动化」的点。即使将来全自动，
> 这些点也应保留人工确认入口（详见 §2 数据契约里的 human gate 规则）。

图例（断言用）：

- 阶段链：`discuss → plan → plan_review → human_plan_approval → code → code_review → human_verify → finalize → done`
- run 状态：`running | paused | need_human | done | failed`
- goal 状态：`pending | running | done | blocked | failed`

---

## 1. 环境与前置

- 工作目录：`/Users/bytedance/Code/browser-hub/feature`。
- 启动本地 Runweave（已认证）：前端 + 后端（`pnpm dev`，按 `AGENTS.md` 最小命令）。
- 浏览器操作一律使用 `$playwright-cli`（见 `AGENTS.md` 本地 URL 复现约束）。
- 至少存在一个 Terminal Project（编排针对「当前项目」开启）。
- 准备一个可被编排操作的真实目标仓库目录（worker 会在其中产生 `git diff`，用于 `artifacts`）。
- 不新增任何 `*.test.*` / `*.spec.*` 等非 E2E 文件；非浏览器层用 `typecheck/lint/build` + 手工冒烟。
- 若旧的进行中 run 占住配置态：仅把那个旧 run 置为 `failed`（`PATCH .../status`），再开始本文档用例。

### 1.1 控制面契约速查（手动 + 自动化都按此断言）

API 前缀：`/api/orchestrator`

| 方法 + 路径                            | 用途                                                       |
| -------------------------------------- | ---------------------------------------------------------- |
| `GET /roles`                           | 列全局角色库                                               |
| `PUT /roles`                           | 覆盖保存全局角色库                                         |
| `GET /runs?projectId=<id>`             | 列项目下所有 run（按 `updatedAt` 倒序）                    |
| `GET /runs/:runId`                     | 读单个 run 任务包                                          |
| `POST /runs/preview`                   | 预览主 Agent 启动 prompt（不落盘、不拉终端）               |
| `POST /runs`                           | 创建 run + 拉起/复用主 Agent 终端 + 注入启动 prompt        |
| `POST /dispatch`                       | 主 Agent 派发 goal 给某角色 worker                         |
| `POST /runs/:runId/inject`             | 向主 Agent 注入人工提示（写 `humanInbox`）                 |
| `POST /runs/:runId/human-gate`         | 提交人工门禁结论（`human_plan_approval` / `human_verify`） |
| `POST /runs/:runId/round-confirmation` | 提交每轮确认结论                                           |
| `PATCH /runs/:runId/status`            | 设置 run 状态（`paused`/`running`/`done`/`failed` 等）     |

worker 完成回流入口（hook）：`POST /internal/terminal-completion`

- 头部：`x-runweave-hook-token: <RUNWEAVE_HOOK_TOKEN>`
- body（关键字段）：`{ terminalSessionId, source: claude|codex|trae|traecli|traex|unknown, completionReason?, commandName?, cwd?, outboxPath?, summary? }`
- 注意：source 必须与该终端正在运行的 agent 命令匹配，否则会被 `202 ignored`（见 `terminal-completion.ts` 的来源闸门）。

落盘路径（用于断言「扛重启 / 恢复」）：

- 任务包：`<projectRoot>/.runweave/runs/<runId>.json`
- 全局角色库：`~/.runweave/roles.json`
- worker outbox：`<projectRoot>/.runweave/outbox/<sessionId>.json`
- dispatch sidecar：`<projectRoot>/.runweave/dispatch/<sessionId>.json`

默认角色（首期 Do-A-IDEM）：`plan_reviewer`（计划审查）、`code_agent`（代码执行）、`code_reviewer`（代码审查）。

阶段自动推进规则（确定性，后端不做智能判断）：

- 创建 run → `currentPhase=plan`，`status=running`。
- 派发 `plan_reviewer` → `plan_review`；其 worker result → `human_plan_approval` + `need_human`。
- `human_plan_approval` 通过 → `code`；拒绝 → 回 `plan`。
- 派发 `code_agent` → `code`；其 worker result → `code_review`。
- 派发 `code_reviewer` → `code_review`；其 worker result → `human_verify` + `need_human`。
- `human_verify` 通过 → `finalize`；拒绝 → 回 `code`。
- `done` 只能从 `finalize` 进入（`PATCH status=done` 在非 finalize 时返回 409）。
- 非内置角色的 worker result 不推进阶段，只记 summary + timeline。

---

## 2. 测试矩阵总览

| 层  | 主题                                          | 对应里程碑 | 主自动化定位           |
| --- | --------------------------------------------- | ---------- | ---------------------- |
| L0  | 静态验证（typecheck/lint/build）              | 全部       | 🟢 AUTO                |
| L1  | 地基契约（任务包/outbox/角色/sidecar/路径）   | M1         | 🟢 AUTO                |
| L2  | 配置态 UI（角色库/选终端/预览 prompt）        | M2.5       | 🟡 SEMI                |
| L3  | 主 Agent 启动闭环                             | M2         | 🟡 SEMI                |
| L4  | 单 worker 直发回灌闭环                        | M2 / M3    | 🟡 SEMI                |
| L5  | Do-A-IDEM 阶段自动推进                        | M4         | 🟢 AUTO（用模拟 hook） |
| L6  | 人工门禁（计划审批 / 人工验收）               | M3 / M5    | 🔴 GATE                |
| L7  | 每轮确认（requireHumanConfirmationEachRound） | 扩展       | 🔴 GATE                |
| L8  | 人工介入（注入 / 暂停 / 继续 / 重开）         | M4.5       | 🟡 SEMI                |
| L9  | 并行扇出 / 汇聚                               | M4         | 🟡 SEMI                |
| L10 | 鲁棒性与恢复（重启 / 漏事件 / 兜底）          | 全程       | 🟢/🟡                  |
| L11 | 真实 agent 端到端自主闭环                     | M3→M6      | 🔴 GATE + 🟡 SEMI      |

---

## L0 · 静态验证

### MAO-L0-001 Typecheck / Lint / Build

- 执行方式：依次运行，逐条人工确认退出码为 0。
- 自动化定位：🟢 AUTO

步骤：

1. `pnpm --filter ./packages/shared typecheck`
2. `pnpm --filter ./backend typecheck`
3. `pnpm --filter ./frontend typecheck`
4. `pnpm --filter ./backend lint`
5. `pnpm --filter ./frontend lint`
6. `pnpm build`

预期：

- 全部命令退出码为 `0`，无类型错误、无 lint 报错。

---

## L1 · 地基契约（任务包 / outbox / 角色 / sidecar）

### MAO-L1-001 全局角色库初始化为 Do-A-IDEM 默认角色

- 执行方式：`GET /api/orchestrator/roles`，人工核对返回。
- 自动化定位：🟢 AUTO

步骤：

1. 干净环境下（`~/.runweave/roles.json` 不存在或为空集）启动后端。
2. `GET /api/orchestrator/roles`。

预期：

- 返回 `roles` 含且仅含 `plan_reviewer`、`code_agent`、`code_reviewer` 三个角色。
- 不再出现旧默认 `coder`/`reviewer`/`tester`。
- `~/.runweave/roles.json` 已生成并与返回一致。

### MAO-L1-002 旧默认角色集自动迁移

- 执行方式：构造 legacy 角色文件后启动后端。
- 自动化定位：🟢 AUTO

步骤：

1. 把 `~/.runweave/roles.json` 写成旧默认集（`coder`/`reviewer`/`tester`，与 `LEGACY_DEFAULT_ROLES` 完全一致）。
2. 重启后端触发 `initialize()`。
3. `GET /api/orchestrator/roles`。

预期：

- 返回的角色已被迁移成 Do-A-IDEM 默认三角色。
- 若文件是用户自定义角色集（非 legacy 完全匹配），则保持不变（反向校验：自定义角色不被覆盖）。

### MAO-L1-003 角色库可保存与读回

- 执行方式：`PUT /roles` 后 `GET /roles`。
- 自动化定位：🟢 AUTO

步骤：

1. `PUT /api/orchestrator/roles`，提交一份修改了 `prompt` 的三角色数组。
2. `GET /api/orchestrator/roles`。
3. 重启后端后再次 `GET`。

预期：

- 保存成功，读回内容与提交一致。
- 重启后仍能从 `~/.runweave/roles.json` 恢复（跨重启持久）。

### MAO-L1-004 任务包 JSON schema 与持久化

- 执行方式：创建一个最小 run（可复用一个空闲终端做主 Agent），读取任务包文件。
- 自动化定位：🟢 AUTO

步骤：

1. `POST /api/orchestrator/runs`，最小合法 body（`projectId` / `task` / `orchestrator` / `roles[≥1]`）。
2. 读 `GET /runs/:runId` 与磁盘文件 `<projectRoot>/.runweave/runs/<runId>.json`。

预期：

- 返回的任务包含：`runId`、`projectId`、`task`、`status=running`、`currentPhase=plan`、`orchestrator.sessionId`（非空）、`roles[]`、`goals=[]`、`humanInbox=[]`、`humanGateVerdicts=[]`、`roundConfirmations=[]`、`pendingRoundConfirmation=null`、`timeline[]`（含 `run_created` 与 `direct_send` 两条）、`createdAt`/`updatedAt`。
- 磁盘 JSON 与 API 返回一致。
- `runId` 仅含字母/数字/下划线/连字符（非法 runId 创建应被 400 拒绝，见 MAO-L1-008）。

### MAO-L1-005 dispatch 写 sidecar

- 执行方式：派发一个 goal 后读 sidecar 文件。
- 自动化定位：🟢 AUTO

步骤：

1. 基于 MAO-L1-004 的 run，`POST /dispatch`（`roleId=code_agent`、`goalId=g_smoke`、`query=...`）。
2. 读 `<projectRoot>/.runweave/dispatch/<workerSessionId>.json`。

预期：

- sidecar 含 `sessionId`、`role=code_agent`、`goalId=g_smoke`、`runId`、`dispatchedAt`。
- 任务包 `goals[]` 出现 `g_smoke`，`status=running`，`assignedRole=code_agent`，`attempts=1`，`sessionId` 指向 worker 终端。
- 再次派发同一 `goalId` 时 `attempts` 自增（反向校验 upsert 语义）。

### MAO-L1-006 outbox 解析优先级（outbox > sidecar > scrollback 兜底）

- 执行方式：构造三种来源数据，分别触发 completion，断言 outbox 解析结果。
- 自动化定位：🟢 AUTO

步骤（按子场景独立跑）：

1. **A 完整 outbox**：在 `<projectRoot>/.runweave/outbox/<sessionId>.json` 写一份含 `runId` 的完整 outbox，再发 completion hook（带或不带 `outboxPath`）。
2. **B 仅 sidecar**：outbox 缺 `runId`（或仅有部分字段），但 sidecar 存在，发 completion hook。
3. **C 兜底**：无 outbox、无 sidecar，但 worker 终端 scrollback 含主 Agent 注入的 `Run:`/`Role:`/`Goal:` 上下文，发 completion hook。

预期：

- A：直接采用 outbox（`runId/goalId/role/status/summary/artifacts` 来自文件）。
- B：合并 sidecar 的 `runId/goalId/role` 到 outbox。
- C：从 scrollback 提取 `runId/role/goalId`，`summary` 取 hook payload 的 `summary` 或 scrollback 末条；构造出可路由的 outbox。
- 三种场景最终都能定位到正确 run 并推进/记录。

### MAO-L1-007 路由表重建（扛重启）

- 执行方式：创建 run → 重启后端 → 检查路由是否恢复。
- 自动化定位：🟢 AUTO

步骤：

1. 创建一个 `status=running` 的 run。
2. 重启后端（`initialize()` 会 `rebuildRouteTable()`）。
3. 触发一个属于该 run 的 worker completion。

预期：

- 重启后路由表能从「`status` 为 `running`/`paused` 且有 `orchestrator.sessionId`」的任务包重建。
- worker result 仍能正确直发到该 run 的主 Agent 终端（或在主 Agent 终端缺失时仅落盘，不报错）。

### MAO-L1-008 输入校验与错误码

- 执行方式：逐个调用非法请求，断言 HTTP 码。
- 自动化定位：🟢 AUTO

步骤与预期：

- `POST /runs` 缺 `task` / `roles` 空数组 / 非法 `runId` / 多余字段 → `400`。
- `POST /runs` 用已存在的 `runId` → `409`（run already exists）。
- `POST /runs` 用不存在的 `projectId` → `404`（Terminal project not found）。
- `GET /runs` 缺 `projectId` → `400`。
- `GET /runs/:runId` 不存在 → `404`。
- `POST /dispatch` 指向不存在的 `roleId` → `404`（Run role not found）。
- `POST /internal/terminal-completion` 缺/错 hook token → `401`；无 token 配置 → `503`；session 不存在 → `404`。

---

## L2 · 配置态 UI（生成任务包）

### MAO-L2-001 Orchestrator 面板与配置态可见

- 执行方式：`$playwright-cli` 打开前端 → 进入终端工作区 → 打开 Orchestrator 面板。
- 自动化定位：🟡 SEMI

步骤：

1. 打开本地前端，进入有项目的终端工作区。
2. 打开 Orchestrator 面板。
3. 当前项目无进行中 run 时，确认显示配置态。

预期：

- 显示任务输入、主 Agent（新建/复用 + Codex/Traex 选择 + 可编辑启动提示语）、参与角色列表（默认勾选 `plan_reviewer`/`code_agent`/`code_reviewer`）。
- 存在 `每一轮都需要人工确认` 勾选框，默认未勾选。
- 存在 `管理全局角色定义` 入口。

### MAO-L2-002 角色绑定控件（新建 / 复用终端）

- 执行方式：在 UI 上切换某角色的绑定模式。
- 自动化定位：🟡 SEMI

步骤：

1. 对 `code_agent` 选「复用」，从下拉选择一个现有终端。
2. 对 `code_reviewer` 保持「新建」。

预期：

- 选「复用」后下拉可选当前项目下的终端；选「新建」时下拉禁用。
- 这些选择会带入 `POST /runs/preview` 与 `POST /runs` 的 `roles[].binding`。

### MAO-L2-003 启动 Prompt 预览（先预览后确认）

- 执行方式：填好配置点「开始 Run」，确认弹出 prompt 预览。
- 自动化定位：🟡 SEMI（预览文本可断言关键片段）

步骤：

1. 填任务，点「开始 Run」。
2. 观察弹出的「确认主 Agent Prompt」对话框。

预期：

- 预览来自 `POST /runs/preview`，**不落盘、不拉终端**（此时 `GET /runs` 不应新增 run）。
- 预览 prompt 含：当前任务、角色与终端映射（含 `rw terminal send ... --agent ...` 指引）、Do-A-IDEM 固定阶段说明、调度方式约束（异步、不长轮询、不手动启 codex）。
- 若开启了「每轮确认」，预览里出现对应说明行。
- 关闭对话框不创建 run；点「确认并开始 Run」才创建。

### MAO-L2-004 控制面地址注入

- 执行方式：在已配置 `RUNWEAVE_BASE_URL` / 控制面地址的环境创建 run，看启动 prompt。
- 自动化定位：🟢 AUTO（断言 prompt 文本）

步骤：

1. 设置后端控制面 base url（`setControlPlaneBaseUrl` 或 `RUNWEAVE_BASE_URL`）。
2. 预览或创建 run。

预期：

- 启动 prompt 含「Runweave 控制面连接」段，给出 `export RUNWEAVE_BASE_URL=...`，且不误导主 Agent 用默认 5001。

---

## L3 · 主 Agent 启动闭环

### MAO-L3-001 创建 run 拉起/复用主 Agent 终端并注入启动 prompt

- 执行方式：从配置态确认创建，观察主 Agent 终端。
- 自动化定位：🟡 SEMI

步骤：

1. 主 Agent 选「新建终端」，确认创建 run。
2. 观察主终端区新出现的主 Agent 终端。
3. 检查任务包 `orchestrator.sessionId` 与 timeline。

预期：

- 创建后任务包 `orchestrator.sessionId` 指向真实终端会话。
- 该终端启动了选定 agent（codex/traex），并收到启动 prompt（启动 prompt 文本进入终端输入队列）。
- timeline 含 `run_created` 与 `direct_send`（Startup prompt sent to orchestrator）。
- 监控态 Tab 显示 `currentPhase=plan`、`status=running`、阶段轨道高亮 `plan`。

### MAO-L3-002 复用现有终端作为主 Agent

- 执行方式：主 Agent 选「复用」并指定一个已运行 agent 的终端。
- 自动化定位：🟡 SEMI

步骤：

1. 先准备一个已在跑 codex 的终端。
2. 主 Agent 选「复用」该终端，创建 run。

预期：

- 不重复启动 agent（已有同 agent 时不覆盖）；启动 prompt 注入该终端。
- `agent_running` 状态下发送也能入队（不报错；提交键策略由运行时处理）。

### MAO-L3-003 进行中 run 占位时配置态隐藏

- 执行方式：在已有 `running`/`paused`/`need_human` run 时打开面板。
- 自动化定位：🟢 AUTO（UI 状态可断言）

步骤：

1. 存在一个进行中 run。
2. 打开 Orchestrator 面板。

预期：

- 直接进入监控态，不显示配置态（除非点「重新开始」进入 restart 配置态）。

---

## L4 · 单 worker 直发回灌闭环（核心）

> 本层用「模拟 worker 完成」打通直发闭环：通过 `POST /internal/terminal-completion` + 预置 outbox 模拟 worker 结束，避免依赖真实 agent 跑完业务。真实 agent 版本见 L11。

### MAO-L4-001 派发 → 完成 → 读 outbox → 直发主 Agent

- 执行方式：派发一个 goal，向 worker 终端预置 outbox，再发 completion hook。
- 自动化定位：🟢 AUTO（模拟）/ 🟡 SEMI（真实）

步骤：

1. 创建 run（关闭每轮确认）。
2. `POST /dispatch`（`roleId=code_agent`、`goalId=g1`、`query=写功能X`）。
3. 在 worker 终端的 cwd 写 outbox `<projectRoot>/.runweave/outbox/<workerSessionId>.json`：`{ runId, goalId:"g1", role:"code_agent", status:"completed", summary:"已完成X", artifacts:[{type:"file",path:"src/x.ts"}], error:null, finishedAt:... }`。
4. `POST /internal/terminal-completion`（`terminalSessionId=<workerSessionId>`、`source=codex`、`completionReason=hook_stop`）。
5. `GET /runs/:runId`。

预期：

- goal `g1` 变为 `done`，`result` 等于 outbox。
- timeline 依次新增 `worker_result` 与 `direct_send`（Worker result sent to orchestrator）。
- 主 Agent 终端收到一条结构化「Worker result received for goal g1 / role code_agent ... Decide the next step now.」的注入（排进其输入队列）。
- 全程零轮询：worker 完成事件是 push，结果立即直发。
- `currentPhase` 从 `code` 推进到 `code_review`（code_agent result 规则）。

### MAO-L4-002 主 Agent 自身 completion 不回灌给自己

- 执行方式：对主 Agent 终端发一个 completion hook。
- 自动化定位：🟢 AUTO

步骤：

1. 对 `orchestrator.sessionId` 终端发 completion hook。

预期：

- 路由器识别 `terminalSessionId === orchestrator.sessionId`，直接 return，不产生 `worker_result` 直发（避免自我回灌死循环）。
- 主 Agent 自身 completion 仅可用于 UI 忙闲展示，不参与回灌控制逻辑。

### MAO-L4-003 失败 worker result

- 执行方式：outbox `status=failed`。
- 自动化定位：🟢 AUTO

步骤：

1. 预置 outbox `status=failed`、`error="退出码1: ..."`。
2. 发 completion hook。

预期：

- goal 变为 `failed`，`result.status=failed`。
- 仍直发主 Agent（结果 prompt `Status: failed`），由主 Agent 决定下一步。
- `failed` 的 worker result **不触发阶段自动推进**（`advancePhaseForWorkerResult` 仅在 completed 时推进）。

### MAO-L4-004 暂停态下结果不直发（只落盘）

- 执行方式：把 run 置 `paused` 后触发 worker completion。
- 自动化定位：🟢 AUTO

步骤：

1. `PATCH /runs/:runId/status` → `paused`。
2. 触发该 run 的 worker completion（带 outbox）。
3. `GET /runs/:runId`。

预期：

- goal 状态与 `worker_result` timeline 仍更新（落盘），但**不**产生 `direct_send`（不直发主 Agent）。
- 阶段推进 patch 仍记录到任务包（goal/phase 落盘），但不向主 Agent 注入。
- `继续`（`status=running`）后，由主 Agent 后续回合或恢复逻辑接管。

### MAO-L4-005 source 与 activeCommand 不匹配被忽略

- 执行方式：对一个跑 codex 的终端发 `source=claude` 的 completion。
- 自动化定位：🟢 AUTO

步骤：

1. worker 终端在跑 codex。
2. 发 completion hook，`source=claude`。

预期：

- 命中来源闸门：返回 `202 ignored`，不进入事件总线，不回灌（除非命中 grace 窗口规则）。

---

## L5 · Do-A-IDEM 阶段自动推进（确定性）

> 用「派发 + 模拟 completion（按角色）」逐段推进，断言后端确定性阶段机。关闭每轮确认。

### MAO-L5-001 全链路阶段推进（不含人工门禁动作）

- 执行方式：按角色顺序派发并模拟 completion，逐段读 `currentPhase`。
- 自动化定位：🟢 AUTO

步骤与逐段预期：

1. 创建 run → `currentPhase=plan`，`status=running`。
2. 派发 `plan_reviewer` → `currentPhase=plan_review`。
3. `plan_reviewer` completion(completed) → `currentPhase=human_plan_approval`，`status=need_human`。4.（人工门禁，见 L6）`human_plan_approval` approved → `currentPhase=code`，`status=running`。
4. 派发 `code_agent` → `currentPhase=code`。
5. `code_agent` completion(completed) → `currentPhase=code_review`。
6. 派发 `code_reviewer` → `currentPhase=code_review`。
7. `code_reviewer` completion(completed) → `currentPhase=human_verify`，`status=need_human`。9.（人工门禁，见 L6）`human_verify` approved → `currentPhase=finalize`，`status=running`。
8. `PATCH status=done` → `currentPhase=done`，`status=done`。

预期：

- 每一步 `currentPhase` 与 `status` 与上面一致。
- 主 Agent 不需要调用任何「set phase」命令；阶段完全由 dispatch / worker result / human gate 驱动。

### MAO-L5-002 非内置角色不推进阶段

- 执行方式：用一个自定义角色（如 `docs_agent`）派发并完成。
- 自动化定位：🟢 AUTO

步骤：

1. 配置一个非 Do-A-IDEM 内置角色并派发、完成。

预期：

- 只记录 summary 与 timeline，`currentPhase` 不变。

### MAO-L5-003 done 只能从 finalize 进入

- 执行方式：在非 finalize 阶段尝试 `PATCH status=done`。
- 自动化定位：🟢 AUTO

步骤：

1. run 处于 `code`/`code_review` 等非 finalize 阶段。
2. `PATCH /runs/:runId/status` → `done`。

预期：

- 返回 `409`（Run can only be marked done from finalize phase）。
- `human_verify` 通过进入 `finalize` 后，再 `PATCH done` 成功，并把 `currentPhase` 设为 `done`。

---

## L6 · 人工门禁（关键人工节点）🔴

> 本层是设计上「必须由人负责」的节点。自动化流程到此应停下等人。每一步都要求人工查看 summary 后给结论。

### MAO-L6-001 进入 human_plan_approval 时 UI 展示计划审批

- 执行方式：推进到 `human_plan_approval` 后看 UI。
- 自动化定位：🔴 GATE（停等人工）/ 🟢 AUTO（断言卡点出现）

步骤：

1. 推进到 `currentPhase=human_plan_approval`、`status=need_human`（L5 步骤 3）。
2. 打开监控态。

预期：

- 顶部出现「需要人工介入」横幅。
- 出现「计划审批」卡片：`通过` 始终可点；`拒绝并要求修订` 在无原因时禁用，填原因后可点。
- 阶段轨道高亮 `human_plan_approval`。

### MAO-L6-002 计划审批通过 → code

- 执行方式：点「通过」或 `POST /human-gate`（`phase=human_plan_approval`、`verdict=approved`）。
- 自动化定位：🔴 GATE

步骤：

1. 提交通过。
2. `GET /runs/:runId`。

预期：

- `status=running`，`currentPhase=code`。
- `humanGateVerdicts[]` 新增一条 `phase=human_plan_approval, verdict=approved`。
- 主 Agent 终端收到「人工门禁已通过 ... Next phase: code」注入。

### MAO-L6-003 计划审批拒绝 → 回 plan，且必须带原因

- 执行方式：先无原因拒绝（应失败），再带原因拒绝。
- 自动化定位：🔴 GATE

步骤：

1. `POST /human-gate`（`verdict=rejected`，无 `reason`）。
2. `POST /human-gate`（`verdict=rejected`，带 `reason`）。

预期：

- 无原因：返回 `400`，run 保持 `need_human`，`currentPhase` 不变。
- 带原因：`status=running`，`currentPhase=plan`；`humanGateVerdicts[]` 记录 `rejected` + reason。

### MAO-L6-004 phase 不匹配被拒

- 执行方式：当前 phase 非 `human_plan_approval` 时提交该 phase 的 gate。
- 自动化定位：🟢 AUTO

步骤：

1. run 处于 `code`。
2. `POST /human-gate`（`phase=human_plan_approval`）。

预期：

- 返回 `409`（Human gate phase does not match current phase）。

### MAO-L6-005 human_verify 是「验收结论输入点」，非简单下一步

- 执行方式：推进到 `human_verify`，验证三类操作。
- 自动化定位：🔴 GATE（真实验收需人做端到端检查）

步骤：

1. 推进到 `currentPhase=human_verify`、`status=need_human`。
2. 观察人工验收卡片的三个动作：`通过，进入提交` / `不通过，返回修改` / `补充验证/提问`。
3. 分别验证：
   - a) 先做端到端检查（打开 Web/Electron/App，跑真实流程），再点「通过，进入提交」。
   - b) 「不通过，返回修改」需填原因。
   - c) 「补充验证/提问」走 `inject`（不写 verdict）。

预期：

- a) approved → `status=running`，`currentPhase=finalize`，`humanGateVerdicts[]` 记录 `human_verify approved`。
- b) rejected 无原因 → `400`；带原因 → `currentPhase=code`，记录 reason。
- c) 「补充验证/提问」只追加 `humanInbox` 与 `human` timeline，**不**写 `humanGateVerdicts[]`，`currentPhase` 不变。

### MAO-L6-006 finalize 只能由 human_verify 通过进入

- 执行方式：尝试不经 human_verify 直接进 finalize。
- 自动化定位：🟢 AUTO

步骤：

1. 在 `code_review` 阶段尝试任何「跳过验收」的路径（API 上不存在直达 finalize 的入口）。

预期：

- 无任何 API 能在未通过 `human_verify` 时把 `currentPhase` 置为 `finalize`（防止 review 完成后系统自动提交）。

---

## L7 · 每轮确认（requireHumanConfirmationEachRound）🔴

> 开启该选项后，非人工门禁的阶段跳变也要先停下等人确认。

### MAO-L7-001 开关默认关闭且可见

- 自动化定位：🟢 AUTO

步骤：打开配置态。

预期：`每一轮都需要人工确认` 可见、默认未勾选。

### MAO-L7-002 关闭时保留既有自动 code → code_review

- 自动化定位：🟢 AUTO

步骤：关闭开关创建 run；派发 `code_agent` 并完成。

预期：dispatch 后 `currentPhase=code`；worker result 后 `currentPhase=code_review`，`status=running`，无 `pendingRoundConfirmation`。

### MAO-L7-003 开启时生成 pendingRoundConfirmation

- 自动化定位：🟢 AUTO（生成）/ 🔴 GATE（需人确认）

步骤：开启开关创建 run；派发 `code_agent` 并完成；刷新。

预期：

- worker result 后 `status=need_human`，`currentPhase` 停在 `code`（不自动进 `code_review`）。
- `pendingRoundConfirmation` 存在：`fromPhase=code`、`nextPhase=code_review`、含 `goalId` 与 worker summary。
- UI 出现「轮次确认」卡片：`通过，进入下一阶段` 可点；`不通过，返回修改` 无原因禁用。

### MAO-L7-004 轮次确认拒绝需原因

- 自动化定位：🔴 GATE

步骤：`POST /round-confirmation`（`verdict=rejected`，无 reason）。

预期：返回 `400`；run 仍 `need_human`，同一 `pendingRoundConfirmation` 保留。

### MAO-L7-005 轮次确认通过 → 进入下一阶段

- 自动化定位：🔴 GATE

步骤：点「通过，进入下一阶段」；刷新。

预期：`status=running`，`currentPhase=code_review`，`pendingRoundConfirmation` 清空，`roundConfirmations[]` 记录 `approved`。

### MAO-L7-006 轮次确认拒绝 → 留在原阶段

- 自动化定位：🔴 GATE

步骤：带原因拒绝。

预期：`nextPhase` 回退到 `fromPhase`（如 `code`），`roundConfirmations[]` 记录 `rejected` + reason，`pendingRoundConfirmation` 清空。

### MAO-L7-007 已是人工门禁的跳变不重复生成轮次确认

- 自动化定位：🟢 AUTO

步骤：开启开关，跑到 `code_reviewer` 完成（下一阶段是 `human_verify`）。

预期：不为 `human_verify` 这种本就是 human gate 的转换额外生成 `pendingRoundConfirmation`（避免双重确认）；走既有 human gate。

### MAO-L7-008 confirmationId 不匹配被拒

- 自动化定位：🟢 AUTO

步骤：用错误/过期的 `confirmationId` 提交。

预期：返回 `409`（does not match current pending confirmation）。

---

## L8 · 人工介入（注入 / 暂停 / 继续 / 重开）

### MAO-L8-001 注入提示进主 Agent

- 执行方式：监控态填提示点「注入提示」。
- 自动化定位：🟡 SEMI

步骤：

1. 在监控态注入一段文本。
2. `GET /runs/:runId`。

预期：

- `humanInbox[]` 新增一条；timeline 新增 `human`（Human prompt injected）。
- 文本作为 human 指令注入主 Agent 终端输入队列。
- 若注入前 run 是 `paused`/`need_human`，注入后转 `running`（注入隐含恢复）。

### MAO-L8-002 暂停 / 继续

- 自动化定位：🟢 AUTO

步骤：点「暂停」→「继续」。

预期：

- `paused` 状态下 worker result 不直发（见 MAO-L4-004），`暂停` 按钮在 paused 时禁用、`继续` 在 running 时禁用。
- `继续` 恢复 `running`。

### MAO-L8-003 重新开始（restart 配置态）

- 自动化定位：🟡 SEMI

步骤：在监控态点「重新开始」。

预期：

- 进入预填了原 run 配置（task / startupPrompt / 角色绑定 / 每轮确认开关）的配置态。
- legacy 启动 prompt 被规范化为当前默认（`normalizeStartupPrompt`）。
- 不影响原 run 磁盘数据，直到确认创建新 run。

### MAO-L8-004 自动刷新

- 自动化定位：🟡 SEMI

步骤：监控态停留，外部触发一个 worker completion。

预期：监控态约每 3s 静默刷新（`refreshRuns`），无需手动刷新即可看到 goal/阶段/timeline 更新。

---

## L9 · 并行扇出 / 汇聚

### MAO-L9-001 一回合派多 worker，结果各自直发

- 执行方式：连续派发两个不同 goal，先后模拟完成。
- 自动化定位：🟡 SEMI

步骤：

1. 派发 `g_a`（code_agent，终端A）与 `g_b`（自定义并行角色，终端B）。
2. 先完成 `g_b`，再完成 `g_a`（各带 outbox）。

预期：

- 两条 worker result 各自直发主 Agent（两次 `rw send` / 两条 `direct_send` timeline），按到达顺序排进主 Agent 输入队列。
- 后端不合并、不维护忙闲；主 Agent 在自己回合边界依次消费。
- 两个 goal 状态独立更新，互不串扰。

### MAO-L9-002 多 worker 完成顺序与 goal 归属正确

- 自动化定位：🟡 SEMI

步骤：乱序触发 A/B 完成。

预期：每条结果按其 `sessionId`/sidecar 归到正确 goal，不串 goal、不丢结果。

---

## L10 · 鲁棒性与恢复

### MAO-L10-001 重启后任务包恢复

- 自动化定位：🟢 AUTO

步骤：进行中 run → 重启后端 → `GET /runs/:runId` 与监控态。

预期：`currentPhase`、`status`、`goals`、`humanGateVerdicts`、`roundConfirmations`、`pendingRoundConfirmation` 全部从磁盘恢复，UI 一致。

### MAO-L10-002 漏事件 / 断点续传

- 自动化定位：🟡 SEMI

步骤：

1. 监控态订阅 `/ws/terminal-events`（先取 `ws-ticket`，带 `after=<baselineEventId>`）。
2. 模拟断连后重连。

预期：重连用 `after` 做 catchup，不丢 worker completion 事件（事件总线为内存态，靠任务包 + outbox 文件兜底重建）。

### MAO-L10-003 outbox 缺失时的 scrollback 兜底

- 自动化定位：🟡 SEMI

步骤：worker 终端无 outbox、无 sidecar，但 scrollback 含注入上下文，触发 completion。

预期：兜底从 scrollback 提取 `runId/role/goalId` 与末条 summary，仍能路由并记录（见 MAO-L1-006 C）。

### MAO-L10-004 主 Agent 终端缺失时不崩

- 自动化定位：🟢 AUTO

步骤：删除/关闭主 Agent 终端会话后，触发 worker completion。

预期：路由器发现 `orchestratorSession` 不存在，仅落盘 goal/timeline，不抛错、不阻塞其他 run。

### MAO-L10-005 旧 run 占位的清理路径

- 自动化定位：🟢 AUTO

步骤：把旧进行中 run `PATCH status=failed`。

预期：配置态重新可用（`activeRun` 不再命中 `running/paused/need_human`）。

---

## L11 · 真实 agent 端到端自主闭环（验收级）🔴🟡

> 用真实 codex/traex worker 跑完整 Do-A-IDEM，验证「无人值守 + 关键节点人工介入」的最终目标。
> 本层断言以「行为快照 + 人工验收」为主，是自动化里保留 GATE 的典型场景。

### MAO-L11-001 串行收敛：plan → review → 人工审批 → code → code_review → 人工验收 → finalize → done

- 执行方式：真实 agent，全程观察，仅在两个 human gate 人工介入。
- 自动化定位：🔴 GATE（两处人工）+ 🟡 SEMI（其余自动）

步骤：

1. 配置主 Agent + 三默认角色（真实 codex），任务设为一个会触发一轮修复的小改动。
2. 创建 run，主 Agent 自主：形成计划 → 派 `plan_reviewer`。
3. 到 `human_plan_approval`：人工查看计划/审查 summary，给通过。
4. 主 Agent 派 `code_agent` 实现 → 自动进 `code_review` → 派 `code_reviewer`。
5. 到 `human_verify`：人工做端到端验证后给结论。
6. 通过后主 Agent 在 finalize 终端完成 commit/记录；`PATCH done`。

预期：

- 全程零轮询；worker 完成即 push 回灌，主 Agent 依次消费决策。
- 主 Agent **不**长时间轮询 worker 终端、不写 sleep 等待循环、不手动 `codex`/`traex` 启 worker（遵循启动 prompt 调度约束）。
- 两个 human gate 各停一次，人工结论结构化落 `humanGateVerdicts[]`。
- 最终 `status=done`，`currentPhase=done`，timeline 完整可追踪。

### MAO-L11-002 自主修复收敛（review 不通过 → 回 code）

- 自动化定位：🔴 GATE + 🟡 SEMI

步骤：构造一个 code_review 会指出问题的任务；在 `human_verify` 人工不通过并给原因。

预期：`currentPhase` 回 `code`，主 Agent 据反馈再派 `code_agent` 修复，再次走 review/验收，最终收敛。

### MAO-L11-003 need_human 通知与续跑

- 自动化定位：🔴 GATE

步骤：构造主 Agent 判定「卡住/高风险」的场景（或人工暂停）。

预期：

- 进入 `need_human`，复用现有飞书 + 桌面通知 + 监控态横幅提示。
- 人工经 UI 注入继续提示后，主 Agent 续跑。

### MAO-L11-004 `agent_running` 时入队语义实测（M2 前置门槛）

- 自动化定位：🟡 SEMI

步骤：主 Agent 正在一个回合中（`agent_running`）时，连续直发多条 worker result。

预期：

- 多条 `rw send` 均入队（backend 恒 `inputEnqueued`），并在主 Agent 当前回合结束后**按序**被消费、不丢不乱。
- 这是直发回灌正确性的真实 agent 级确认。

---

## 3. 自动化推进建议（从手动到半自动）

> 不在本次实现，仅记录设计意图，便于后续把上面 case 接入自动化。

- **可立即脚本化的 fixture**：用 `POST /internal/terminal-completion` + 预置 outbox 文件，把「worker 完成」变成确定性触发器（L4/L5/L7 大部分可纯 API 自动跑）。
- **关键人工节点（🔴 GATE）保留人工卡点**：自动化流程跑到 `human_plan_approval`/`human_verify`/`round-confirmation`/真实验收时，应**暂停并发出通知**，等人提交 verdict 后再继续——这正是 Human-in-the-loop 的落点，不应为了「全绿」而自动点通过。
- **断言分层**：🟢 用 JSON 字段 / HTTP 码精确断言；🟡 用快照或关键文本宽松匹配（终端/agent 输出有抖动）；🔴 记录人工结论与时间戳即可。
- **E2E 边界**：浏览器侧验证统一走 `$playwright-cli`；不新增前端单测（遵循 `AGENTS.md` 测试约束）。

---

## 4. 通过判定

- L0–L1、L5、L6（断言部分）、L7、L10 中标 🟢 的 case 全部确定性通过。
- L2–L4、L8–L9 中标 🟡 的 case 现象与预期一致（允许终端/agent 输出抖动，但状态机与落盘必须正确）。
- L6/L7/L11 中标 🔴 的关键人工节点：人工已实际查看 summary / 完成端到端验收并给出结构化结论，结论正确落盘。
- 任一 case 失败：记录实际现象、相关 `runId` 与磁盘 JSON 快照，停止后续依赖该状态的 case。
