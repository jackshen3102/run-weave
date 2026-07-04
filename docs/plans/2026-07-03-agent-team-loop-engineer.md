# Agent Team / Loop Engineer 落地方案

> 原型：`docs/prototypes/multi-agent-workspace/`（含「灵魂拷问收敛」章节）
> 本方案是**全新的 agent-team / loop-engineer 流程**，**完全取代并废弃上一代 orchestrator**（`backend/src/orchestrator/*`、`packages/shared/src/orchestrator.ts`、前端 Orchestrator sidecar tab 及 `/api/orchestrator` 路由）。上一代的默认约定（每个 worker 开独立 session、do-a-idem 阶段机、`propose-split` 不存在）一律不沿用。仍然通用的**底层终端能力**（tmux pane、prompt 注入、outbox 概念、human-gate 思路）按需借鉴或直接迁移到新模块，但上一代 orchestrator 模块本身作为废弃代码，在本流程落地时清理，不与新流程并存。

## 目标

在真实的「项目 → 终端」架构下落地一套 loop-engineer 流程：

- **一个终端 = 一套 run**，worker 以**同一终端内的 tmux pane** 承载（复用 `tmux-service.splitPane()`）。
- 终端默认是普通 shell，人在终端里**显式开启**流程后，主 Agent 接管，驱动 `需求澄清 → 拆分提案 → 执行观测` 生命周期。
- loop 是一等公民：以 behavior_verify 的**结构化验收结论**为进展信号，per-run 计 `round`/`noProgress`，连续无进展**熔断升级人工**，人接管后带干预 note 恢复。
- 可视终端定位为**「可信任放手 + 熔断精准介入」**：平时 pane 只读旁观、右侧 sidecar 给结论；出事时深链聚焦卡住 pane 并解锁人工接管。

## 非目标

- 上一代 orchestrator（`backend/src/orchestrator/*`、`packages/shared/src/orchestrator.ts`、前端 Orchestrator sidecar tab、`/api/orchestrator` 路由）作为**废弃代码在本流程落地时清理**；能直接复用的底层终端能力按需迁移到新模块，但不保留旧 orchestrator 的对外契约、不维护其向后兼容。
- 不实现崩溃/恢复的专门机制（tmux 现场本可 reattach/rebuild，列 backlog，遇到再优化）。
- 不实现 A 方案之外的验收路径（不先把 markdown 验收翻成 Playwright spec；B 方案作为后续增强）。
- 不新增单测 / Vitest / `*.spec.*`；按仓库约束，UI 行为用 `$playwright-cli` E2E 验收，非浏览器层用 `typecheck`/`lint`/构建冒烟。
- 不改 App / mobile 终端页；首期只作用于 Web desktop 终端（与 panel-split 的现有范围一致）。
- 不实现真实 LLM 澄清对话内容质量（澄清是主 Agent 与人的自由往返，不做结构化约束）。

## 当前代码现状（落地锚点与缺口）

真实存在、可复用：

- `backend/src/terminal/tmux-service.ts`：`splitPane()`、`listPanes()`、`selectPane()`、`killPane()`、`capturePane()` 真实可用——pane-as-worker 的承载基础。
- `backend/src/routes/terminal-panel-routes.ts` + `backend/src/orchestrator/terminal/prompt-sender.ts`：`resolvePanelTarget` 可把 prompt 注入到指定 pane。
- `packages/shared/src/terminal-protocol.ts:399` `TerminalCompletionEvent`：worker「跑完一轮」的触发信号，带 `outboxPath`。
- 上一代 outbox：`packages/shared/src/orchestrator.ts:112` `OrchestratorWorkerOutbox`（`artifacts` + free-text `summary` + `completionReason`）——仅作为新 outbox schema 的**结构参考**，随旧模块一起删除。
- human-gate 思路：上一代 `POST /api/orchestrator/runs/:id/human-gate` + `autoApprovePlanGate/VerifyGate`（`service.ts`）——新流程的「拆分确认门 / 自动确认」**借鉴这套交互模式**重新实现，不保留旧阶段机与旧路由。
- panel-split 已默认关闭、右键启用（`frontend/src/features/terminal/preferences.ts`、`terminal-workspace-shell.tsx`，见 `docs/plans/2026-06-27-terminal-panel-split-toggle.md`）——loop 流程需要在开启流程时确保该 session 的 pane 能力可用。

必须新建（原型虚构、当前 shipping 代码为 0）：

1. `TerminalCompletionEvent` 无 `panelId`/`tmuxPaneId` —— pane 级完成信号缺口（`terminal-protocol.ts:399`）。
2. loop 数据模型（`round`/`noProgressCount`/`maxNoProgress`/`escalated`/错误指纹/去抖状态）全缺。
3. pane 级「冻结 agent 循环、保留现场」语义缺（tmux 只能 kill/select）。
4. 「人工干预 note」结构 + 注入回主 Agent 上下文缺。
5. worker outbox 无 per-case `acceptanceResults` 结构。
6. A 方案验收去抖逻辑缺。
7. `rw propose-split` / Agent 主导触发链路缺（`rw` 无编排命令）。

## 设计

### 阶段 0 — 协议与数据模型（前置，其余全部依赖）

**0.1 完成事件补 pane 维度**（缺口 1）

`packages/shared/src/terminal-protocol.ts` 的 `TerminalCompletionEvent` / `TerminalCompletionEventPayload` 增加可选字段：

```ts
panelId?: string | null;
tmuxPaneId?: string | null;
```

后端 hook bridge 上报完成事件时带上 pane 归属；无 pane（单终端）时为 `null`，保持向后兼容。这是 pane-as-worker 读 outbox、per-pane 归因的前提。

**0.2 run / loop 数据模型**（缺口 2）

新增 `packages/shared/src/agent-team.ts`（取代废弃的 `orchestrator.ts`；旧类型随上一代模块一并清理）：

```ts
export type AgentTeamPhase = "clarify" | "proposal" | "executing";
export type AgentTeamStatus =
  | "clarifying"
  | "running"
  | "need_human"
  | "done"
  | "failed";

export interface AgentTeamLoop {
  round: number;
  noProgressCount: number;
  maxNoProgress: number; // 默认 3
  escalated: boolean;
  lastReason: string | null;
  errorFingerprints: string[]; // 用于「同类错误重复」判定 + 恢复时重置
}

export interface AgentTeamRun {
  runId: string;
  projectId: string;
  terminalSessionId: string; // 一个终端 = 一套 run
  phase: AgentTeamPhase;
  status: AgentTeamStatus;
  options: { autoApproveSplit: boolean };
  workers: AgentTeamWorker[]; // 每个 worker 绑一个 paneId
  acceptance: AcceptanceCase[];
  loop: AgentTeamLoop;
  humanNotes: HumanInterventionNote[];
}
```

**0.3 outbox 扩验收结果**（缺口 5）

worker outbox schema 增加：

```ts
acceptanceResults?: Array<{
  caseId: string;
  status: "pass" | "fail";
  evidence: Array<{ type: "screenshot" | "dom" | "text"; ref: string }>;
}>;
```

behavior_verify worker 跑完 A 方案后写出该结构；编排层从 `outboxPath` 读到它，作为 loop 进展信号来源。

### 阶段 1 — 终端 plain → flow 显式开启

- 前端：普通终端右侧 sidecar 给「▶ 在此终端开启流程」入口（原型已表达）。点击调用后端「开启 run」接口，绑定 `terminalSessionId`，确保该 session 的 panel-split 能力开启（复用 preferences helper）。
- 后端：新建 run（`phase=clarify`, `status=clarifying`），把当前终端的 main pane 标记为主 Agent pane，启动主 Agent（复用 agent-readiness 的「把命令敲进 PTY + 处理 trust prompt」思路）。

### 阶段 2 — 澄清 → 拆分提案 + 确认门（缺口 7）

- **触发**：人主导（「澄清完成 · 让主 Agent 拆分」）或 Agent 主导（主 Agent 自判澄清充分主动产出提案）。Agent 主导对应一个真实触发通道——**走后端 HTTP（`POST /api/agent-team/runs/:id/propose-split`）而非新增 `rw` 子命令**；`rw propose-split` 暂不做。
- **确认门**：复用 human-gate 模式——提案置 `status=need_human`，前端弹可编辑提案卡（worker 增删 + 验收用例草案），人确认后进入 executing。`options.autoApproveSplit=true` 时跳过该门直达 executing（对齐上一代 `autoApprove*Gate` 语义）。
- **确认即 split**：确认后按 worker 数量 `splitPane()` 出对应 pane，每个 worker 绑 `paneId`，并注入各自的 startup prompt。

### 阶段 3 — executing：loop 信号 + 熔断（缺口 2/6）

- **信号来源**：behavior_verify worker（A 方案）跑完 → completion 事件（带 `panelId`）→ 编排层读 `outboxPath` 的 `acceptanceResults`。
- **进展判定（per-run，客观优先）**：一轮结束时，若「验收 pass 数上升」或「有实质 diff 变化」→ 有进展，`noProgressCount=0`；否则 `noProgressCount++`。
- **去抖**（缺口 6）：同一 `caseId` 需**连续 N 轮稳定 fail** 才计入无进展；单轮 pass↔fail flip 不计数，并留档证据供人判断是真 bug 还是 verify 抖动。
- **抛回 code**：编排层读到稳定 fail 后，由**编排层**决定抛回哪个 code pane、带上失败证据，走 prompt 注入（`resolvePanelTarget` + prompt-sender）。worker 之间零横向通信。
- **错误指纹**：对失败原因做归一化签名，进 `errorFingerprints`，用于「同类错误修不动」判定与恢复时重置。
- **熔断**：`noProgressCount >= maxNoProgress` → `status=need_human`, `loop.escalated=true`, 记录 `lastReason`（归因文案）。

### 阶段 4 — 熔断接管 → 恢复（缺口 3/4）

- **归因 + 深链**：熔断卡显示「卡在 `verify↔code` 子循环 / 用例 X 连续 N 轮 fail / 错误指纹相同」，并提供「聚焦到该 pane」动作（前端 `selectPane` 高亮）。
- **接管单位 per-run**：熔断时**暂停所有 worker pane 的自动推进**（缺口 3：pane 级冻结 loop——不 kill pane、不断 PTY，只停止编排层向该 pane 注入下一轮）。人可直接进任意 pane 手敲（普通 PTY 能力）。
- **恢复携带 note**（缺口 4）：恢复时人填/系统汇总一条 `HumanInterventionNote`，注入回主 Agent 上下文（prompt 注入），并**重置相关 `errorFingerprints` + `noProgressCount=0`**，避免恢复即复燃。`status` 回到 `running`。

### 可视终端定位（贯穿 UI）

- 平时：右侧 sidecar 给 loop 状态 + 验收证据 + log；pane **只读旁观**，默认只高亮 active/异常 pane，其余可折叠，避免多屏认知过载。
- 出事：熔断/人主动接管时，pane 解锁手敲。"看" 与 "改" 在时间上分开，服务于「可信任放手」，不是让人全程监工。

## 文件范围

协议 / 共享：

- `packages/shared/src/terminal-protocol.ts` — 完成事件补 `panelId`/`tmuxPaneId`（0.1）。
- `packages/shared/src/agent-team.ts` — 新建 run/loop/worker/acceptance/note 数据模型（0.2/0.3）。

后端：

- `backend/src/agent-team/*`（新目录）— run service（开启/提案/确认/loop 推进/熔断/恢复）、outbox resolver（读 `acceptanceResults`）、错误指纹 + 去抖、pane 冻结/恢复。
- `backend/src/routes/agent-team.ts`（新）— `POST /api/agent-team/runs`、`.../propose-split`、`.../split-gate`、`.../resume` 等。
- 迁移/复用底层终端能力：`backend/src/terminal/tmux-service.ts`（保留）、`backend/src/routes/terminal-panel-routes.ts`（`resolvePanelTarget`，保留）；prompt 注入逻辑（现位于废弃的 `backend/src/orchestrator/terminal/prompt-sender.ts`）迁入 `backend/src/agent-team/`，随上一代模块一并下线。
- hook bridge：完成事件上报带 pane 归属。

前端（Web desktop）：

- `frontend/src/components/terminal/` — plain 终端「开启流程」入口、flow 三段 sidecar（clarify/proposal/executing）、熔断卡 + 深链聚焦、pane 只读/接管态切换。
- 复用 `frontend/src/features/terminal/preferences.ts` 的 panel-split 开关，确保开启流程时 pane 能力可用。

废弃清理（上一代 orchestrator 下线）：

- 删除 `backend/src/orchestrator/*`、`backend/src/routes/orchestrator.ts` 及其在 `backend/src/index.ts` 的挂载/初始化；`packages/shared/src/orchestrator.ts`；前端 `terminal-orchestrator-panel.tsx` + `orchestrator/` 子目录，以及 `terminal-preview-panel*.tsx` 里的 Orchestrator sidecar tab。
- 清理其存储目录/文件（run-store/role-store/sidecar-store 的落盘）与相关事件订阅，确保完成事件只被新 agent-team resolver 消费。

## 验收标准

1. 普通终端右侧显示「开启流程」入口；开启后主 Agent 在 main pane 接管、进入澄清。
2. 澄清 → 提案：可编辑提案卡（worker 增删 + 验收草案）；确认后按 worker 数 split 出对应 pane 并各自注入 prompt。
3. `autoApproveSplit=true` 时澄清后直达 executing、跳过确认门。
4. executing：completion 事件能区分 pane（带 `panelId`）；编排层能从 outbox 读到 `acceptanceResults` 的 per-case pass/fail。
5. loop per-run 计数：pass 数上升/有 diff → 计数清零；否则累加。单轮 flip 不计数（去抖），连续 N 轮稳定 fail 才计入。
6. 失败用例由编排层抛回 code pane，带失败证据；worker 之间无直接通信。
7. 连续无进展达 `maxNoProgress` → `need_human` + 熔断卡带归因，可深链聚焦卡住 pane；此时 worker pane 停止自动推进、人可手敲。
8. 恢复携带干预 note 注入主 Agent，重置错误指纹 + 计数，`status` 回 `running`，不立即复燃。
9. 平时 pane 只读、默认高亮异常 pane；仅熔断/接管态解锁手敲。

## 验证方式

命令验证（非浏览器层）：

```bash
pnpm --filter ./packages/shared typecheck
pnpm --filter ./backend typecheck
pnpm --filter ./frontend typecheck
pnpm --filter ./frontend lint
git diff --check
```

浏览器验收（`$playwright-cli`，按 AGENTS.md 要求实际执行并留证据）：

1. 开普通终端 → 点「开启流程」→ 确认进入澄清（sidecar 切换）。
2. 澄清 → 提案 → 确认 → 截图确认左侧 split 出 main + worker pane、右侧进入 executing。
3. 构造/mock 一次稳定 fail → 确认计数累加、抛回 code pane。
4. 连续 fail 到 `maxNoProgress` → 确认熔断卡 + 归因 + 深链聚焦。
5. 恢复 → 确认 note 注入、计数重置、状态回 running。

后端 loop/去抖/熔断这类非 UI 逻辑，用脚本化冒烟（`tsx` 直跑 service）验证，不新增单测。

## 风险点

- **pane 级冻结语义是全新的**：tmux 无「暂停 agent loop」原语，需在编排层实现「停止向该 pane 注入下一轮」而非动 PTY/pane，避免误伤人正在手敲的现场。
- **A 方案非确定性**：去抖阈值 N 取太大→熔断迟钝、烧 token；取太小→假熔断骚扰人。需可配置并留证据供人复核。
- **错误指纹归一化**：签名过粗→不同错误被误判为「同类修不动」提前熔断；过细→永远凑不齐重复计数。起步用保守规则 + 留原文。
- **上一代 orchestrator 下线的爆炸半径**：删除旧模块要确认没有其它调用方（路由挂载、事件订阅、前端 tab、落盘存储）残留；尤其完成事件订阅必须从旧 resolver 干净切到新 agent-team resolver，避免删一半导致事件无人消费或报错。
- **panel-split 默认关闭**：开启流程若未确保该 session 的 pane 能力开启，split worker 会失败；需在开启流程时显式启用并处理已有多 pane 的情况。
