# Terminal Agent Command Attribution 代码评审

## 评审对象

- 当前工作区 diff：`app-server/src/state-projector.ts`、`backend/src/app-server/handlers/*`、`backend/src/routes/terminal-panel-*`、`electron/resources/hooks/runweave-hook-bridge.cjs`、`plugins/toolkit/hooks/runweave-hook-bridge.cjs`、`scripts/verify-app-server-state-sync.mjs`，以及新增 `backend/src/app-server/handlers/terminal-agent-context.ts`。
- 评审角色：代码评审。

## 结论

未发现 P0/P1/P2 问题。当前改动方向成立：App Server projector 通过 `commandName` 修正 `source=claude` 的实际 agent 归属，backend App Server consumer 在 `source` 不是终端 agent 时会结合 `commandName`、panel 和 session 上下文解析真实终端 agent，hook bridge 也会在未显式传 `--command-name` 时从 tmux pane metadata 兜底读取命令。

## 发现

- **P0 阻断**：未发现。
- **P1 严重**：未发现。
- **P2 一般**：未发现。
- **P3 提示：真实 tmux 自动探测路径需要行为验收。** 状态：已在后续目标模式中关闭。验证覆盖不传 `--command-name`、`@runweave_command=codex`、`pane_current_command=node` 的真实终端场景，并核对 App Server ThreadRef agent、backend terminalState 与浏览器 tab 展示均归因到 Codex。

## 关键核对

- `app-server/src/state-projector.ts:171`：`commandName` 优先于 `source/agent` 解析，直接事件投递下 `source=claude + commandName=codex` 会投影为 Codex。
- `backend/src/app-server/handlers/terminal-agent-context.ts:28`：backend consumer 先用 `commandName` 推断 terminal agent；只有 `reportedSource=claude` 且命令不可判定时才回看 panel/session 上下文。
- `backend/src/index.ts:326`：backend 只消费归属本 backend 的 `agent.hook` / `agent.completion` App Server 事件，避免本进程自发事件回环。
- `backend/src/routes/terminal-panel-metadata.ts:201` 与 `backend/src/routes/terminal-panel-workspace.ts:100`：panel workspace 同步时保留 node-wrapped agent/npm/pnpm/yarn 命令，和 WebSocket 已有 activeCommand 保护语义一致。

## 已执行验证

- `git diff --check`：通过。
- `pnpm typecheck`：通过。
- `pnpm lint`：通过。
- `pnpm app-server:verify-state-sync`：通过，包含新增 `source=claude + commandName=codex` 投影断言。
- `pnpm toolkit:verify-hooks`：通过。
- 真实浏览器 + 真实终端目标模式验收：通过。浏览器创建终端 `020d6210`，hook bridge 在 `source=claude` 且 tmux `@runweave_command=codex`、`pane_current_command=node` 时推断 `commandName=codex`；App Server thread 为 `unknown-thread:codex:020d6210...`，backend terminalState 为 `agent_running/codex`，浏览器 tab 显示 Codex agent 归因。

## 未执行

- 未执行真实桌面端 App 验收；本次 diff 的目标风险已由 Web 浏览器页面和真实 tmux 终端覆盖。
