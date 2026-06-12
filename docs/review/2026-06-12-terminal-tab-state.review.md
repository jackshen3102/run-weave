# Terminal Tab 状态指示变更评审

## 检查范围

- 评审模式：`review-only`，强力模式。原因是变更跨共享协议、后端路由、WebSocket/tmux 生命周期、前端 UI 与测试。
- 当前 diff：11 个已跟踪文件变更，另有计划、测试用例文档、草图、新 `ShimmerText` 组件未跟踪。
- 已执行验证：
  - `pnpm --filter ./backend test -- src/routes/terminal.test.ts src/terminal/tmux-output-watcher.test.ts src/ws/terminal-server.test.ts`：通过。实际运行了 backend 全量 Vitest：60 files / 384 tests。
  - `pnpm typecheck`：通过。
- 未执行浏览器验收；涉及浏览器操作时必须使用 `$playwright-cli`。

## 架构 / 策略发现

### P1 - watcher 与 WebSocket 恢复路径竞争同一个 tmux 退出生命周期

当前决策：

- `TmuxOutputWatcher` 在 poll 中发现非交互 tmux pane metadata 消失后，直接清空 metadata、`markExited()` 并 `unwatchSession()`。
- WebSocket attach runtime 的 `onExit` 对 tmux-backed session 不是标记退出，而是调用 `ensureTerminalRuntime()`，在非交互命令结束后把 session 重建成 shell 并向当前 client 发送 `running`。

为什么这是风险：

- 这两个路径对同一事件给出相反语义：watcher 认为 session 结束，WebSocket 恢复路径认为 session 应回到 shell 继续可用。
- 如果 watcher 先或同时执行，`TerminalSessionManager.markExited()` 会把 session 状态置为 `exited`；随后 WebSocket 路径仍可能创建新的 tmux shell 并发送 `running`，但 `updateSessionLaunch()` / `updateSessionMetadata()` 不会把 status 从 `exited` 改回 `running`。
- 结果可能是：后端 session list 显示 exited，当前 WebSocket 又提示 running；用户看到的 tab/session 生命周期不一致，后续 `/api/terminal/session`、App home、global event 消费都会被误导。

证据：

- [backend/src/terminal/tmux-output-watcher.ts](/Users/bytedance/Code/browser-hub/browser-viewer/backend/src/terminal/tmux-output-watcher.ts:228)：`reconcileNonInteractiveSessionExit()` 直接更新 metadata、`markExited()`、`unwatchSession()`。
- [backend/src/ws/terminal-server.ts](/Users/bytedance/Code/browser-hub/browser-viewer/backend/src/ws/terminal-server.ts:405)：tmux runtime `onExit` 进入恢复分支，调用 `ensureTerminalRuntime()` 后发送 `running`。
- [backend/src/terminal/runtime-launcher.ts](/Users/bytedance/Code/browser-hub/browser-viewer/backend/src/terminal/runtime-launcher.ts:81)：非交互 tmux session missing 时重建为默认 shell。
- [backend/src/terminal/manager.ts](/Users/bytedance/Code/browser-hub/browser-viewer/backend/src/terminal/manager.ts:311)：`markExited()` 设置 status exited；[backend/src/terminal/manager.ts](/Users/bytedance/Code/browser-hub/browser-viewer/backend/src/terminal/manager.ts:370) 的 `updateSessionLaunch()` 不恢复 status。

更好的候选方案：

- 候选 A：把 tmux session missing 的决策集中到一个 lifecycle owner。由 `ensureTerminalRuntime()` 或一个 terminal lifecycle service 原子决定“重建成 shell”还是“最终退出”，watcher 只记录输出和上报观测，不直接 `markExited()`。
- 候选 B：如果保留 watcher reconcile，则必须先判断是否存在活跃 runtime/client 或是否处于可恢复 tmux session；有活跃 attach 时交给 WebSocket 恢复路径，无 client 时才允许最终标记 exited。

迁移/过渡风险：

- 需要补一个并发/顺序回归测试：非交互 tmux 命令结束且 WebSocket client 仍连接时，watcher poll 与 `onExit` 任意顺序都不能留下 `status=exited` + client `running` 的矛盾状态。
- 如果改变退出语义，要明确 CLI 启动一次性命令到底是“结束后回到 shell”还是“结束即退出”，避免不同入口行为分裂。

### P1 - UI 实现偏离计划的核心交付物

当前决策：

- 后端把 `terminalState` 接入 session list，前端把它种入 `terminalStateBySessionId`。
- tab 渲染层只在 `agent_running` 时给标题套 `ShimmerText`，没有实现左侧执行状态点，也没有 hover/focus 详情卡。

为什么它在系统层面可能是错的：

- 计划定义的用户目标是“不打开 terminal detail，只看 tab 左侧状态点区分 `shell_idle`、`agent_idle`、`agent_running`”，且要求 hover/focus 提供详情。
- 当前 UI 只能表达 running 的动效，不能区分 shell idle 和 agent idle；也没有详情卡解释 agent、命令、等待状态。
- 右侧 completion/bell 小点仍然存在，但没有新增左侧执行状态点，会继续让“通知”和“运行状态”的视觉语义混在同一个 tab 区域里。

证据：

- [docs/plans/2026-06-12-terminal-tab-state-indicators.md](/Users/bytedance/Code/browser-hub/browser-viewer/docs/plans/2026-06-12-terminal-tab-state-indicators.md:13)：计划要求“紧凑状态点 + hover/focus 详情卡”。
- [docs/plans/2026-06-12-terminal-tab-state-indicators.md](/Users/bytedance/Code/browser-hub/browser-viewer/docs/plans/2026-06-12-terminal-tab-state-indicators.md:119)：计划要求 `TerminalTabStateDot` 与 `TerminalTabStateCard`。
- [docs/plans/2026-06-12-terminal-tab-state-indicators.md](/Users/bytedance/Code/browser-hub/browser-viewer/docs/plans/2026-06-12-terminal-tab-state-indicators.md:214)：完成标准包含状态点和 hover/focus 详情卡。
- [frontend/src/components/terminal/terminal-workspace-shell.tsx](/Users/bytedance/Code/browser-hub/browser-viewer/frontend/src/components/terminal/terminal-workspace-shell.tsx:73)：实现只判断 `agent_running`。
- [frontend/src/components/terminal/terminal-workspace-shell.tsx](/Users/bytedance/Code/browser-hub/browser-viewer/frontend/src/components/terminal/terminal-workspace-shell.tsx:98)：running 时渲染 `ShimmerText`，未渲染三态状态点。
- [frontend/src/components/terminal/terminal-workspace-shell.tsx](/Users/bytedance/Code/browser-hub/browser-viewer/frontend/src/components/terminal/terminal-workspace-shell.tsx:111)：现有小点仍只用于 bell/completion。

更好的候选方案：

- 候选 A：按计划补齐 `TerminalTabStateDot` 和 portal/popover 详情卡，tab 内固定左侧状态点、标题、右侧通知点，详情只在 hover/focus 展示。
- 候选 B：如果要缩小本次交付，先只做左侧三态状态点和可访问 label，暂缓详情卡；但需要同步更新计划和验收标准，不能把 shimmer 当成计划完成。

迁移/过渡风险：

- 详情卡放在横向滚动 tab 容器内会被 `overflow-x-auto` 裁剪，应优先用现有 Popover/portal。
- 需要用 `$playwright-cli` 做浏览器验收，覆盖多 tab、刷新后初始状态、hover/focus 和 reduced motion。

### P2 - metadata resync 绑在每个 WebSocket client 上，运维成本和语义边界不清

当前决策：

- 当 tmux metadata 显示 `activeCommand !== null`，每个 terminal WebSocket connection 都会每 1 秒调一次 `readPaneMetadata()`，直到 activeCommand 变 null。

为什么它在系统层面可能是错的：

- 这是按 client 扩散的 tmux polling：同一个 session 多个客户端会重复读 tmux metadata。
- 它让“session 真实 metadata 状态”依赖是否有 WebSocket client 正在连接；而当前需求是 session/tab/global state 的一致性，不应由某个 UI 连接私有地承担同步。
- 测试只覆盖单 client stale metadata，没有覆盖多 client、长时间 active command、client 断开后的状态收敛。

证据：

- [backend/src/ws/terminal-server.ts](/Users/bytedance/Code/browser-hub/browser-viewer/backend/src/ws/terminal-server.ts:42)：新增 1 秒 resync 常量。
- [backend/src/ws/terminal-server.ts](/Users/bytedance/Code/browser-hub/browser-viewer/backend/src/ws/terminal-server.ts:282)：`syncTmuxPaneMetadata()` 在单 connection 闭包内维护 timer。
- [backend/src/ws/terminal-server.ts](/Users/bytedance/Code/browser-hub/browser-viewer/backend/src/ws/terminal-server.ts:302)：activeCommand 非空时继续调度下一次 sync。
- [backend/src/ws/terminal-server.test.ts](/Users/bytedance/Code/browser-hub/browser-viewer/backend/src/ws/terminal-server.test.ts:1394)：新增测试覆盖 stale client，但仅覆盖单连接场景。

更好的候选方案：

- 候选 A：把 tmux metadata resync 下沉为每 session 一个 shared poller，按 terminalSessionId 去重，并统一向 `TerminalSessionManager` / `TerminalStateService` 发布变化。
- 候选 B：保留 WebSocket 内 resync，但加 per-session debounce/lock，并补多 client 测试，证明不会 N 个 client 产生 N 倍 tmux 命令。

迁移/过渡风险：

- 下沉到 shared poller 会触及 runtime lifecycle 和 watcher 边界，改动更大；如果本轮只做轻量补丁，至少先加去重和测试，避免后续难以排查的 tmux 命令风暴。

## 代码 / 实现发现

### P2 - watcher 清理退出时没有同步 TerminalStateService / terminal events

为什么这是风险：

- WebSocket metadata/exit 路径会在更新 session metadata 后调用 `terminalStateService.setShellActiveCommand()`，从而清理 stored state 并记录 `terminal_state_changed`。
- watcher 新增路径只调用 `TerminalSessionManager.updateSessionMetadata()` 和 `markExited()`，没有调用 `TerminalStateService`，也没有发布 global terminal event。
- 如果没有前端重新拉取 session list，已有 Web/App `/ws/terminal-events` 消费者可能保留旧的 `agent_running` 或 `agent_idle`，直到别的事件触发。

证据：

- [backend/src/terminal/tmux-output-watcher.ts](/Users/bytedance/Code/browser-hub/browser-viewer/backend/src/terminal/tmux-output-watcher.ts:258)：watcher 只更新 manager metadata。
- [backend/src/terminal/tmux-output-watcher.ts](/Users/bytedance/Code/browser-hub/browser-viewer/backend/src/terminal/tmux-output-watcher.ts:262)：watcher 直接 `markExited()`。
- [backend/src/ws/terminal-server.ts](/Users/bytedance/Code/browser-hub/browser-viewer/backend/src/ws/terminal-server.ts:250)：WebSocket metadata 路径更新 manager 后调用 `setShellActiveCommand()`。
- [backend/src/ws/terminal-server.ts](/Users/bytedance/Code/browser-hub/browser-viewer/backend/src/ws/terminal-server.ts:447)：WebSocket exit 路径 mark exited 后清理 terminal state。
- [backend/src/terminal/terminal-state-service.ts](/Users/bytedance/Code/browser-hub/browser-viewer/backend/src/terminal/terminal-state-service.ts:101)：`setAndPublish()` 是 terminal state change event 的发布点。

修复方向：

- 不要让 watcher 独立改生命周期状态；或者给 watcher 注入明确的 lifecycle/state service，并保证 exit/metadata 清理和事件发布与 WebSocket 路径一致。
- 补测试：已有 `agent_running` store，watcher reconcile non-interactive exit 后应发布 `terminal_state_changed` 到 `shell_idle`，或证明该路径不会负责状态变更。

### P2 - tab 丢失完整 command/args 的悬浮标题

为什么这是风险：

- 原实现用 `title={buildSessionLabel(session)}` 提供完整 command + args，长标题被 truncate 时用户仍能通过浏览器 tooltip 查看原始启动命令。
- 新实现删除了 `buildSessionLabel()` 和 `title`，`aria-label` 只剩 `displayName`，通常是 cwd(activeCommand)，不是完整 command/args。
- 计划中的 hover 详情卡尚未实现，所以这个可检查性能力目前直接丢失。

证据：

- [frontend/src/components/terminal/terminal-workspace-shell.tsx](/Users/bytedance/Code/browser-hub/browser-viewer/frontend/src/components/terminal/terminal-workspace-shell.tsx:86)：tab button 现在只有 `aria-label={displayName}`。
- [frontend/src/components/terminal/terminal-workspace-shell.tsx](/Users/bytedance/Code/browser-hub/browser-viewer/frontend/src/components/terminal/terminal-workspace-shell.tsx:98)：标题区域只渲染 `displayName` / shimmer。
- diff 中原 `title={buildSessionLabel(session)}` 已被删除。

修复方向：

- 若实现 hover 详情卡，则在详情卡中包含 command/args，并保留基础 `title` 作为无 JS/无 hover fallback。
- 若暂不实现详情卡，恢复 `title`，并确保 aria label 不丢失 command/args 上下文。

### P3 - 大段第三方 shimmer CSS 进入全局样式，合规和维护边界不清

为什么这是风险：

- 新增的 shimmer CSS 是全局 class，并注明从 assistant-ui MIT 代码改编。
- 如果保留较大段第三方实现，通常需要在仓库合规位置保留对应 MIT copyright/license notice；仅在 CSS 注释中写 source 可能不足以满足仓库合规要求。
- 这段 CSS 使用 `@property`、`tan()`、`oklch from currentColor`、container query units 等较新的 CSS 能力；虽然 typecheck 不会发现问题，但浏览器兼容和回退需要通过 `$playwright-cli` 验收。

证据：

- [frontend/src/index.css](/Users/bytedance/Code/browser-hub/browser-viewer/frontend/src/index.css:130)：注明从 assistant-ui tw-shimmer 改编。
- [frontend/src/index.css](/Users/bytedance/Code/browser-hub/browser-viewer/frontend/src/index.css:150)：`.shimmer` 是全局 class。
- [frontend/src/index.css](/Users/bytedance/Code/browser-hub/browser-viewer/frontend/src/index.css:246)：使用较新的 relative color syntax。

修复方向：

- 更简单的方案：删除第三方大段 shimmer，改成本项目自有的轻量 `animate-pulse` / border ring / dot pulse，满足状态表达即可。
- 如果继续使用这段实现，补齐 license notice，并用 `$playwright-cli` 验证 Chromium/WebKit 目标环境下 running tab 文字可见、reduced motion 生效。

## 剩余风险 / 测试缺口

- 当前自动测试通过，但没有覆盖 watcher 与 WebSocket 恢复路径的竞态。
- 当前没有浏览器验收记录；计划要求的状态点、hover/focus 详情卡、刷新后初始状态显示都需要通过 `$playwright-cli` 验证。
- 没有多客户端 WebSocket metadata resync 测试，无法证明新增 1 秒轮询不会按连接数放大。
