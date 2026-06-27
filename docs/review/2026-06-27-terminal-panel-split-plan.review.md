# Terminal Panel Split 计划评审

评审对象：`docs/plans/2026-06-26-terminal-panel-split.md`

评审类型：计划评审，只读审阅。除本报告外未修改源码、配置、测试或计划文档。

## 结论

计划的主方向成立：首期复用 tmux 原生 split，保留单个 `TerminalSurface` / session-level WebSocket，比自研多个 React terminal surface 和 panel-level transport 更适合当前代码结构。

但当前方案还不能直接进入实现，主要缺口集中在 active pane 反向同步、panel 级 agent 状态、以及 pane env 的稳定性。建议先补齐这些约束和验收，再拆阶段开发。

## 发现

- **P1 严重：缺少 tmux 内部焦点反向同步的实施项，旧输入路径可能路由到错误 panel**。计划把旧客户端未传 `panelId` 时解析到 `activePanelId`，并规定旧 session-level routes 走 `resolvePanelTarget`，但只在风险章节写“可通过定期/事件触发 `list-panes` 同步 active pane”，没有把用户在 xterm/tmux 内用快捷键或鼠标切 pane 的反向同步纳入实施阶段和验收。当前浏览器输入仍是 WebSocket `activeRuntime.write(...)`，tmux session target 会进入 tmux 当前 selected pane；一旦后端 `activePanelId` 未跟随 tmux selected pane，`rw terminal send <session>`、旧 API input、interrupt、history 默认目标都会和用户看到的焦点不一致。定位：`docs/plans/2026-06-26-terminal-panel-split.md:198`、`docs/plans/2026-06-26-terminal-panel-split.md:227`、`docs/plans/2026-06-26-terminal-panel-split.md:385`、`docs/plans/2026-06-26-terminal-panel-split.md:693`；代码现状：`backend/src/ws/terminal-server.ts:580`、`backend/src/routes/terminal-input-dispatcher.ts:177`、`backend/src/terminal/tmux-service.ts:433`。修复方向：把 active pane 反向同步提升为阶段 2/3/4 的明确任务，例如 `list-panes`/`display-message "#{pane_id}"` 周期或输入后同步，检测 tmux selected pane 变化后更新 `activePanelId` 并发布 `terminal_panel_focused(source: "tmux")`；验收必须覆盖在 xterm 内用 tmux 快捷键/鼠标切 pane 后，UI chip、default API input、CLI 无 `--panel` send 都指向同一 pane。

- **P1 严重：TerminalState 仍是 session 级，无法支撑多 panel Codex/Hook 并发语义**。计划要求 `completion`、`stop`、`notify`、agent timeline 都保留 panel target，并在 UI panel chip 展示完成标记，但没有处理当前 `TerminalStateStore` 和 `/state` 契约按 `terminalSessionId` 单键存储的问题。若同一 tmux session 内两个 panel 都运行 agent，一个 panel 的 `Stop` 或 `UserPromptSubmit` 会覆盖整个 session 的状态，进而影响另一个 panel 的 composer 提交键和 readiness 判断。定位：`docs/plans/2026-06-26-terminal-panel-split.md:388`、`docs/plans/2026-06-26-terminal-panel-split.md:406`、`docs/plans/2026-06-26-terminal-panel-split.md:571`；代码现状：`backend/src/terminal/terminal-state-store.ts:3`、`backend/src/terminal/terminal-state-service.ts:60`、`backend/src/routes/terminal-input-dispatcher.ts:156`、`backend/src/app-server/handlers/agent-hook.ts:25`。修复方向：二选一写进计划：要么新增 panel 级 `TerminalState`，状态 key 使用 `terminalSessionId + terminalPanelId`，并扩展 hook processor、state route、terminal events、UI chip 状态；要么明确首期只允许一个 agent-active panel，并在 API/CLI/UI 上阻止并发 agent panel，避免产品承诺超出状态模型。

- **P2 一般：pane env 里包含 alias/role 会在重命名后变成陈旧事实源**。计划要求 split/default pane 内环境包含 `RUNWEAVE_TERMINAL_PANEL_ALIAS` 和 `RUNWEAVE_TERMINAL_PANEL_ROLE`，同时又支持 Rename、Edit role/alias。进程环境在 shell 启动后不能可靠回写，后续 hook 若从 env 读 alias/role，会在重命名或改 role 后继续上报旧值；当前代码也只在 terminal session 启动时注入 session env。定位：`docs/plans/2026-06-26-terminal-panel-split.md:391`、`docs/plans/2026-06-26-terminal-panel-split.md:441`、`docs/plans/2026-06-26-terminal-panel-split.md:571`；代码现状：`backend/src/terminal/runtime-launcher.ts:200`、`backend/src/terminal/runtime-launcher.ts:264`。修复方向：把 env 中的权威字段收敛到稳定 `RUNWEAVE_TERMINAL_SESSION_ID` 和 `RUNWEAVE_TERMINAL_PANEL_ID`，alias/role 由 backend 根据 panel metadata enrichment；若仍保留 alias/role env，只能作为启动时 hint，计划中必须注明 rename 后不可信。

- **P2 一般：迁移/恢复验收没有覆盖持久化 panel 与真实 tmux panes 分叉**。计划写了启动时校验持久化 `tmuxPaneId` 是否存在、不存在时标记 exited 或移除，但阶段 1/2 验收只覆盖老 session 返回 default panel、split、关闭最后一个 panel，没有覆盖 backend 重启、tmux pane 被外部 kill、tmux session 重建后 panel workspace 如何收敛。定位：`docs/plans/2026-06-26-terminal-panel-split.md:273`、`docs/plans/2026-06-26-terminal-panel-split.md:528`、`docs/plans/2026-06-26-terminal-panel-split.md:551`。修复方向：补充恢复验收：重启 backend 后 panel 列表与 `list-panes` 一致；外部 `tmux kill-pane -t %pane` 后 panel 事件/状态收敛；tmux session 丢失重建时 default panel 与旧 panel metadata 的保留/失效规则明确。

## 更简单的替代方向

更简单的 MVP 可以先让 tmux 成为 panel 运行态的唯一事实源：每次 list/focus/snapshot 都从 `tmux list-panes` / `display-message` 读取当前 panes 和 active pane，只持久化 Runweave 自己的 alias/role 映射及少量 workspace metadata。这样可以先交付 split、focus、send、snapshot、UI chips，减少自建 panel lifecycle 与 tmux lifecycle 分叉；代价是首期事件历史、per-panel completion marker 和 Orchestrator 多 worker 绑定能力会更弱，需要在后续阶段补齐。

如果坚持当前完整 `TerminalPanel` 实体路线，也建议先把阶段顺序调整为：tmux pane target + active pane 反向同步先落地，再做 Hook/Agent panel 化，最后接 Orchestrator 多 panel 路由。

## 检查范围

- 阅读计划全文：`docs/plans/2026-06-26-terminal-panel-split.md`
- 抽查原型说明：`docs/prototypes/terminal-panel-split/README.md`
- 抽查现有 tmux/runtime/input/state/hook/CLI 代码：
  - `backend/src/terminal/tmux-service.ts`
  - `backend/src/terminal/runtime-launcher.ts`
  - `backend/src/routes/terminal-input-dispatcher.ts`
  - `backend/src/ws/terminal-server.ts`
  - `backend/src/terminal/terminal-state-service.ts`
  - `backend/src/terminal/terminal-state-store.ts`
  - `backend/src/app-server/handlers/agent-hook.ts`
  - `packages/shared/src/app-server-events.ts`
  - `packages/runweave-cli/src/commands/terminal.ts`
  - `packages/runweave-cli/src/client/terminal-http-client.ts`

## 验证摘要

- `git status --short` 显示被评审计划、assets、prototype 目前均为未跟踪文件；本次未改动这些评审对象。
- 未运行 typecheck/lint/Playwright，因为本次是计划评审，且计划尚未进入产品代码实现。

## 残余风险

- 没有启动原型做浏览器交互验收；本轮只评审计划是否可实施。
- 没有检查图片资产视觉细节；本轮重点是方案与当前代码契约是否成立。
