# App Server 驱动 Agent Team Loop（completion 收敛第一步）

> 状态：设计计划稿。目标是补齐「app-server 的 `agent.completion` 能驱动 Agent Team loop」这一缺口，为后续 hook 单写（Event Center roadmap 第三阶段）铺路。本稿只规划到「双通道功能对等 + 跨通道去重」，**不删除 backend 直连**。

## 背景与问题

当前 hook 完成事件是「双写」：worker 跑完 → `runweave-hook-bridge` 同时写两条路。

- **路径 A（app-server）**：`POST app-server /events`（`agent.completion`）→ backend 订阅 `/events/stream` → `handleAgentCompletionEvent`。
- **路径 B（backend 直连，兜底）**：`POST /internal/terminal-completion` → `TerminalCompletionEventService.record`。

已核实的代码事实（`main` @ 2026-07-09）：

- Agent Team loop 只认 completion 事件：`backend/src/agent-team/service.ts` 的 `handleTerminalEvent` 开头 `if (event.kind !== "completion") return;`。
- 路径 B 会产出 `kind:"completion"` 事件（`backend/src/terminal/completion-event-service.ts`），**能**驱动 loop。
- 路径 A 到 backend 后只走 `backend/src/app-server/handlers/agent-completion.ts` → `processTerminalAgentHook`（`backend/src/terminal/agent-hook-processor.ts`）。该函数全程只调 `terminalStateService.handleAgentHook`，产出 `terminal_state_changed`，**从不**产出 `kind:"completion"`。
- 因此：**loop 100% 依赖路径 B；路径 A 至今只更新终端状态（小绿点 / ThreadRef），对 loop 贡献为 0。**
- `TerminalEventService.record`（`backend/src/terminal/terminal-event-service.ts`）无条件 `nextId++` 追加，**这一层没有任何去重**。
- Event Center roadmap（`docs/plans/2026-06-25-app-server-event-center.md` 第三阶段）已把「hook 单写、backend 改订阅」列为终态，用词是「**评估**关闭直写」。
- `docs/plans/2026-07-05-app-server-state-sync.md` 非目标明确「**不移除既有 backend direct fallback**」。截至 07-05，直连是刻意保留的过渡态，单写未启动。

结论：单写是既定方向，但前置条件（app-server completion 能驱动 loop + 跨通道去重）**尚未落地**。本计划补这个前置，不做单写本身。

## 目标

1. 让路径 A 的 `agent.completion` 到 backend 后，除更新终端状态外，**也能驱动 Agent Team loop**（产出 loop 可消费的 completion 事件）。
2. 双通道并存期间，**同一次完成只驱动一次 loop**（跨通道去重）。
3. 保持现有行为不回归：直连、终端状态、小绿点、桌面/飞书通知全部不变。
4. 产出可核对的验证证据（typecheck / lint / app-server 验证脚本 / Playwright E2E / 真实终端行为）。

## 非目标

- 不删除 backend 直连 `/internal/terminal-completion`（那是 roadmap 第三阶段，需 owner 拍板 app-server 是否可成为 loop 单点）。
- 不把 app-server 从「可缺席增强」升级为「强依赖」。app-server 不可用时，loop 仍必须能靠直连运行。
- 不改 hook bridge 的双写行为与自动启动策略。
- 不新增单元测试文件（遵循仓库约束）。
- 不改 loop 引擎算法（`foldRound` / 熔断 / debounce 不动）。

## 核心设计

### 决策点：让 app-server completion 驱动 loop 的两种做法

**方案 A（推荐）：在 `handleAgentCompletionEvent` 里桥接到 completion feed。**
路径 A 的 handler 在现有「更新状态」之外，额外把事件映射成一条 backend completion，喂进 `TerminalCompletionEventService.record`，走与直连完全相同的下游（同一套 source/active-command 门禁 + loop 消费）。

- 优点：下游只有一条 completion 代码路径，A/B 复用同一门禁与同一 loop 入口，行为一致、维护面小。
- 代价：需要把路径 A 的 payload 补齐成 completion 所需字段（source / completionReason / panelId / tmuxPaneId / outboxPath / summary），并接入去重。

**方案 B（不推荐）：让 Agent Team 直接订阅 `terminal_state_changed`。**

- 缺点：loop 语义被污染——状态变化 ≠ 任务完成；且要在 loop 侧重做 pane 归属与门禁，重复造轮子。否决。

采用方案 A。

### 跨通道去重（关键）

双写期间，同一次完成会同时经 A 和 B 到达 backend，若两条都产 completion，则 `TerminalEventService` 追加两条 → loop 折叠两次。去重收口在 **completion feed 入口**（`TerminalCompletionEventService.record` 之前或之内），维度用 hook 已经在带的 `dedupeKey`（见 `2026-06-25-app-server-event-center.md` L350/L615：`completion:<source>:<sessionId>:<rawHookEvent>:<threadId>:<ts>`）。

- backend 侧维护一个短窗口 completion dedupe（按 `dedupeKey`，TTL 覆盖 A/B 到达间隔即可，例如 60s）。
- 直连（B）与桥接（A）都先过这个 dedupe：命中则丢弃，不再 `record`。
- 现有 Agent Team 侧的 `enqueue` 串行化 + outbox `mtime` / `expectedRound` 去重**保留**，作为第二层保险，不动。

> 注意：路径 B 的 body 当前不一定携带 `dedupeKey`（`backend/src/routes/terminal-completion.ts` 的 zod schema 未含该字段）。实施前需确认 hook bridge 直连请求是否发送 `dedupeKey`；若没有，需先让直连也带上同一 `dedupeKey`，否则跨通道去重无共同键。这是本计划的**前置校验项**（见步骤 0）。

## 实施步骤（每步带验证）

### 步骤 0 · 前置校验：确认 dedupeKey 共同键存在

- 读 `plugins/toolkit/hooks/runweave-hook-bridge.cjs` 与 `electron/resources/hooks/runweave-hook-bridge.cjs`，确认直连（B）和 app-server（A）两条 POST 是否使用**同一** `dedupeKey`。
- 若 B 未发送 `dedupeKey`：在 hook bridge 直连 body 与 `terminal-completion.ts` 的 zod schema 各加一个可选 `dedupeKey` 字段（仅透传，不改现有语义）。
- → 验证：`pnpm toolkit:verify-hooks` 通过；`pnpm --filter @runweave/backend typecheck`。

### 步骤 1 · completion feed 入口加去重

- 在 `TerminalCompletionEventService`（或其上层调用点）加一个按 `dedupeKey` 的短 TTL 去重；无 `dedupeKey` 的事件保持旧行为（不去重，向后兼容）。
- → 验证：typecheck + lint；构造同 `dedupeKey` 连续两次 record，第二次被丢弃（用 app-server 验证脚本或最小手动核对，不新增单测文件）。

### 步骤 2 · 让路径 A 桥接到 completion feed

- 在 `backend/src/app-server/handlers/agent-completion.ts`：现有 `processTerminalAgentHook`（状态更新）**保留**；在其后，当事件是 completion 语义（`isAppServerStopCompletion` 已判定）时，映射出 completion 输入并调用 `TerminalCompletionEventService.record`，复用直连同款 source/active-command 门禁。
- 映射字段来源：`event.scope`（terminalSessionId / projectId / panelId / tmuxPaneId）+ `event.payload`（source / completionReason / commandName / rawHookEvent / cwd / summary / outboxPath），`dedupeKey` 用 `event.dedupeKey`。
- handler 需要拿到 `TerminalCompletionEventService` 实例：在 `backend/src/index.ts` 的 consumer 接线（`kinds: ["agent.hook","agent.completion"]`）处注入。
- → 验证：typecheck + lint。

### 步骤 3 · 端到端真实行为核对（关键，非静态）

- 真实终端场景（Codex worker pane）：
  - 场景 1（双通道在线）：app-server + backend 都在，跑一次 Agent Team run 让某 worker 完成。核对 loop **只推进一轮**（去重生效），run 日志无重复 round。
  - 场景 2（app-server 缺席）：停掉 app-server，重复上面。核对 loop 仍靠直连正常推进（无回归）。
  - 场景 3（backend 直连 mock 关掉、仅 app-server）：验证路径 A 现在**能**独立驱动 loop（本计划的核心新增能力）。
- → 验证：按 AGENTS.md，涉及页面/终端联动用 `$computer-use` 备好环境 + `$playwright-cli` 取证；记录命令与关键证据。若未执行须写明「未执行 + 阻塞原因」，不得用静态检查冒充。

### 步骤 4 · 文档保鲜

- 更新 `docs/architecture/terminal-completion-hooks.md` 与 `docs/architecture/app-server-event-center.md`：说明路径 A 现在也驱动 loop，以及跨通道去重的收口位置。
- → 验证：文档与代码一致；不改代码。

## 验收标准

- [ ] 双通道在线时，一次完成只驱动一次 loop（无重复 round）。
- [ ] app-server 缺席时，loop 仍由直连驱动，行为无回归。
- [ ] 仅 app-server 在线时，loop 能被路径 A 驱动（新增能力成立）。
- [ ] 终端状态 / 小绿点 / 通知行为全部不变。
- [ ] `pnpm typecheck`、`pnpm lint`、`pnpm toolkit:verify-hooks` 通过；步骤 3 的 Playwright/真实行为证据齐全。

## 风险与回退

- **风险：去重窗口选太短** → A/B 到达间隔大于 TTL 时漏去重，loop 跑两遍。处理：TTL 取保守值（≥60s），并保留 Agent Team 侧 `expectedRound` 作为第二层保险。
- **风险：dedupeKey 不稳定**（含 `Date.now()`）→ A/B 若各自生成时间戳则键不同，去重失效。处理：步骤 0 必须确认两条路用的是**同一个** hook 侧生成的 key，而非各自生成。
- **风险：路径 A 门禁与直连不一致** → 复用同一门禁函数（`completion-source-gate`）避免分叉。
- **回退**：本计划纯增量。桥接与去重可通过一个开关/早返回关闭，立即回到「路径 A 只更新状态、loop 靠直连」的现状，风险可控。

## 后续（不在本计划范围）

- Event Center roadmap 第三阶段：backend 稳定订阅后，**评估**关闭 hook 直连、收敛为 app-server 单写。前提是 owner 接受「app-server 成为 loop 单点」，与当前「app-server 可缺席」原则冲突，需专门决策。
