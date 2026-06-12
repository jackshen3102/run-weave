# Terminal Tab 状态指示计划

## 背景

草图：`docs/plans/assets/terminal-tab-state-sketch.png`

这次目标是让 Web 端 terminal session tab 能直接表达当前终端执行状态，用户只看 tab 就能判断：

- `shell_idle`：普通 shell 空闲，可以直接输入命令。
- `agent_idle`：Codex agent 已在会话里，但当前没有执行模型任务，可以继续提交 prompt。
- `agent_running`：Codex agent 正在执行或等待 hook stop，不应误以为终端空闲。

最终 UI 采用“紧凑状态点 + hover/focus 详情卡”：

- tab 内始终只显示左侧状态点、标题、关闭按钮。
- 不在 active tab 或 hover tab 内显示 `RUN codex`、`WAIT codex` 这类 inline chip。
- hover/focus 时显示详情卡，包含状态、agent、命令、等待说明、最近活动。
- 右侧已有 completion/bell 小点继续只表示通知，不和左侧执行状态点混用。

## 当前现状

- `TerminalState` 已存在于共享协议，取值是 `shell_idle | agent_idle | agent_running`，并带 `agent: "codex" | null`。位置：`packages/shared/src/terminal-protocol.ts`。
- Web 的 `TerminalWorkspace` 已维护 `terminalStateBySessionId`，并消费 `/ws/terminal-events` 里的 `terminal_state_changed` 事件更新它。位置：`frontend/src/components/terminal/terminal-workspace.tsx`。
- Web 的 terminal tab 由 `TerminalWorkspaceShell` 渲染，当前只用 `formatTerminalSessionName({ cwd, activeCommand })` 得到 `browser-viewer(codex)` 这类标题。位置：`frontend/src/components/terminal/terminal-workspace-shell.tsx`、`frontend/src/features/terminal/session-name.ts`。
- `/api/terminal/session` 当前只返回 `TerminalSessionListItem`，其中有 `activeCommand`，但没有 `terminalState`。位置：`backend/src/routes/terminal.ts`、`backend/src/routes/terminal-route-payloads.ts`。
- Web terminal-events 连接默认从 `baselineEventId` 之后开始接收事件。刷新页面后如果没有新的状态事件，前端不能靠事件流恢复当前 tab 初始状态。
- App home 已经把 session 与 `terminalStateService.getCurrent(...)` 聚合成 `terminalState/displayStatus/displayStatusLabel`。位置：`backend/src/routes/app-home-overview.ts`、`app/src/components/TerminalRow.tsx`。

## 需求理解

这是一个 Web terminal tab 的可用性改造，不是重新设计终端状态机。

目标是把后端已有的 `TerminalState` 接到 Web terminal tab 上：

- 用户不打开 terminal detail、不读终端输出，也能从 tab 左侧状态点判断终端是否空闲、agent 是否空闲、agent 是否正在跑。
- 用户需要更明确的信息时，把鼠标悬停或键盘 focus 到 tab 上，看到详情卡。
- tab 标题继续沿用现有 `cwd(activeCommand)` 规则，保留用户已经熟悉的识别方式。

## 差异与影响

现状和目标之间的差异：

- 数据差异：Web tab 有后续状态事件，但 session 列表没有初始 `terminalState`，刷新后状态点无法可靠显示。
- UI 差异：当前 tab 只有标题和右侧通知点，需要新增左侧执行状态点和 hover/focus 详情卡。
- 语义差异：当前右侧小点承担 completion/bell，不能复用它表达执行状态，否则用户会把“有通知”和“正在运行”混淆。

受影响模块：

- 共享协议：`packages/shared/src/terminal-protocol.ts`
- 后端 session 列表 payload：`backend/src/routes/terminal-route-payloads.ts`、`backend/src/routes/terminal.ts`
- Web session 加载与事件状态合并：`frontend/src/components/terminal/terminal-workspace.tsx`
- Web tab 渲染：`frontend/src/components/terminal/terminal-workspace-shell.tsx`
- Web 服务类型：`frontend/src/services/terminal.ts`
- 后端测试：`backend/src/routes/terminal.test.ts`，必要时补 `backend/src/routes/terminal-state.test.ts`

## 推荐方案

推荐做“后端列表提供初始状态，Web 事件流负责后续更新”。

原因：

- `TerminalStateService.getCurrent(...)` 已经是当前状态来源，App home 也在使用它；Web 不需要再造状态判断逻辑。
- `/ws/terminal-events` 适合增量变化，但不适合单独承担页面初始状态，因为它从当前 `baselineEventId` 后开始接收。
- 直接扩展 `/api/terminal/session` 比 Web 对每个 tab 额外请求 `/api/terminal/session/:id/state` 更省请求，也避免多 tab 页面初始闪烁。

## 实施计划

### 1. 扩展 session list 初始状态

修改 `packages/shared/src/terminal-protocol.ts`：

- 给 `TerminalSessionListItem` 增加 `terminalState?: TerminalState`。
- 保持字段可选是为了降低非生产测试 fixture 和旧客户端的编译影响；生产 `/api/terminal/session` 必须填充该字段。

修改 `backend/src/routes/terminal-route-payloads.ts`：

- 让 `toSessionListItem(...)` 支持传入 `terminalState?: TerminalState`。
- 不在 helper 内自行推断状态，避免重复实现状态机。

修改 `backend/src/routes/terminal.ts`：

- 在 `router.get("/session")` 中对每个 session 调用 `options.terminalStateService?.getCurrent(session.id, session)`。
- 当 `terminalStateService` 存在时，把结果写入 `terminalState`。
- 生产路径已有 `terminalStateService`，不能在 Web UI 中依赖 `activeCommand === "codex"` 这类前端猜测。

验收：

- `/api/terminal/session` 返回的每个 running session 带 `terminalState`。
- 非 Codex session 的 `terminalState.state` 是 `shell_idle`。
- Codex session 当前空闲时是 `agent_idle`，收到 `UserPromptSubmit` 后事件更新为 `agent_running`。

### 2. 在 Web loadSessions 阶段种入初始状态

修改 `frontend/src/components/terminal/terminal-workspace.tsx`：

- `loadSessions()` 拿到 `nextSessions` 后，从 `session.terminalState` 生成 `terminalStateBySessionId` 初始值。
- 保留现有 `terminal_state_changed` 事件处理逻辑，后续事件覆盖初始值。
- 如果某个 session 没有 `terminalState` 字段，不要用 `activeCommand` 在前端猜状态；该 tab 可以暂不显示状态点，直到事件或下一次刷新提供真实状态。
- 创建新 project/session 的临时本地 session 如果还没完成 `loadSessions()`，不要显示伪造的 running 状态。

验收：

- 刷新 terminal workspace 后，无需等待新事件，已有 tab 能立即显示真实状态点。
- 状态事件到达后，同一个 tab 的点能从 `agent_idle` 切到 `agent_running`，再切回 `agent_idle`。

### 3. 把状态传入 tab 渲染层

修改 `frontend/src/components/terminal/terminal-workspace-shell.tsx`：

- `TerminalWorkspaceShellProps` 增加 `terminalStateBySessionId: Record<string, TerminalState>`。
- `TerminalWorkspace` 调用 `TerminalWorkspaceShell` 时传入当前 map。
- 在 session tab 渲染里根据 `session.terminalSessionId` 取状态。

验收：

- `TerminalWorkspaceShell` 不自己请求状态，不自己推断状态，只消费父层传入的真实状态。
- tab 选择、关闭、拖拽排序、completion/bell marker 逻辑保持现有行为。

### 4. 实现状态点与 hover/focus 详情卡

修改 `frontend/src/components/terminal/terminal-workspace-shell.tsx`，可在同文件内先实现小组件，避免过早抽象：

- `TerminalTabStateDot`：只渲染左侧执行状态点。
- `TerminalTabStateCard`：hover/focus 时展示详情。

状态点视觉规则：

- `shell_idle`：灰色空心点。
- `agent_idle`：蓝色实心点，表达 agent 待命。
- `agent_running`：青色点或环，允许轻微 pulse。
- `status === "exited"`：使用退出/静默样式，不显示 running 感。
- 无 `terminalState`：不显示状态点，避免误导。

详情卡内容：

- 状态：`Shell idle` / `Agent idle` / `Agent running`
- Agent：`codex` 或 `-`
- 命令：优先 `session.activeCommand`，没有则显示 `session.command`
- 等待：
  - `agent_running` 显示 `模型响应 / hook stop`
  - `agent_idle` 显示 `等待下一次输入`
  - `shell_idle` 显示 `Shell 可输入`
- 最近活动：复用已有 `lastActivityAt`，显示相对时间

UI 约束：

- tab 内不显示 `RUN codex`、`WAIT codex`、`SH node` 这类 inline chip。
- hover/focus 才显示详情卡。
- 左侧执行状态点和右侧 notification/completion/bell 点必须分开。
- tab row 高度保持当前 `h-[26px]`，不要把 active tab 做成两行。
- tab 标题继续使用 `formatTerminalSessionName(...)`，不要改成新的命名规则。
- 长标题必须继续 truncate，不能撑高或撑宽 tab。

验收：

- 多个 tab 并排时，状态信息不挤占标题。
- active tab 和 inactive tab 都能显示状态点。
- hover/focus 任意 tab 能看到详情卡。
- 不 hover 时，UI 仍是紧凑 tab bar。

### 5. 更新测试与验证

后端自动化：

- 更新 `backend/src/routes/terminal.test.ts` 中 `/api/terminal/session` 相关断言，覆盖返回 `terminalState`。
- 必要时在 `backend/src/routes/terminal-state.test.ts` 保持状态推导行为不变。

前端验证：

- 不新增 `frontend/src` 下的 Vitest 单测，不新增 `*.test.tsx`。本项目约束要求前端正式自动化以 Playwright E2E 为主。
- 如果新增 E2E，放在 `frontend/tests/`，覆盖 tab 初始状态点和 hover 详情卡。
- 涉及浏览器操作验证时，必须使用 `$playwright-cli`，不要用其它浏览器方案。

建议验证命令：

```bash
pnpm --filter ./backend test -- src/routes/terminal.test.ts src/routes/terminal-state.test.ts
pnpm --filter ./frontend typecheck
pnpm typecheck
```

浏览器验收步骤必须通过 `$playwright-cli`：

1. 启动本地开发服务：`pnpm dev`。
2. 打开 Web terminal workspace。
3. 准备至少三个 session：普通 shell、Codex idle、Codex running。
4. 检查左侧状态点分别显示 `shell_idle`、`agent_idle`、`agent_running`。
5. hover/focus Codex running tab，确认只出现详情卡，tab 内没有 `RUN codex` 文本。
6. 触发 completion/bell，确认右侧通知点仍独立显示，不影响左侧状态点。
7. 刷新页面，确认初始状态点仍立即显示，不需要等待新的 terminal event。

## 不做什么

- 不改 terminal 状态机，不新增 `TerminalState` 枚举值。
- 不用前端 `activeCommand` 猜 `agent_idle/agent_running`。
- 不把 `RUN codex` 作为 tab 内 inline chip。
- 不改变 `formatTerminalSessionName(...)` 的标题规则。
- 不调整 App home 的状态 badge，本计划只覆盖 Web terminal session tab。
- 不新增前端 Vitest 单测。

## 风险与处理

- 风险：`terminalState` 初始字段缺失会导致 tab 没有状态点。
  - 处理：生产 `/api/terminal/session` 必须填充；前端不猜状态，避免显示错误状态。
- 风险：hover 卡片被横向滚动容器裁剪。
  - 处理：优先使用现有 Popover/portal 组件或等价 portal 渲染，不把卡片直接放在 `overflow-x-auto` 容器内。
- 风险：状态点和 completion/bell 点语义混淆。
  - 处理：左侧只放执行状态，右侧只保留通知，样式和位置都分开。
- 风险：pulse 动画干扰用户。
  - 处理：`agent_running` 使用轻量 pulse，避免大面积闪烁；如有系统 reduced-motion，应禁用动画或退化为静态青色环。

## 完成标准

- `/api/terminal/session` 的生产响应携带真实 `terminalState`。
- Web terminal tab 首屏即可显示真实执行状态点。
- 后续状态变化由 `/ws/terminal-events` 更新，无需刷新。
- hover/focus 显示详情卡；tab 内没有 `RUN codex` inline chip。
- 关闭、选择、拖拽排序、completion/bell marker 不回归。
- `pnpm typecheck` 通过。
- 涉及浏览器验收的步骤已通过 `$playwright-cli` 执行并记录结果。
