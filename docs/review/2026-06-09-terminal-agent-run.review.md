# Terminal Agent Run Review

日期：2026-06-09

范围：当前 worktree 中终端 agent-run 状态、移动端 Stop 行为、CLI handoff/interrupt、Electron hook、backend route/ws/shared protocol 相关改动。

## 架构 / 策略发现

### P2 - agent-run 身份模型会把同一终端内的运行合并错

- 当前决策：`TerminalAgentRun` 协议暴露了 `operationId`、`codexThreadId`、`codexTurnId`、`pid`，但服务端关联事件时只优先看显式 `agentRunId`，否则按“同一 terminal + 同一 source 的任意活跃 run”或“同一 source 的最近 run”合并。
- 为什么这是系统层面风险：终端是长生命周期容器，同一 terminal 内会连续甚至快速重叠出现同源 agent 事件。只按 source 合并会把后一轮开始、前一轮 completion/signal、hook stop 归到同一个 run，导致 App Stop、CLI handoff 和后续自动接管拿到错误状态。
- 证据：
  - `packages/shared/src/terminal-protocol.ts:304` 声明了可用于身份关联的 `operationId`。
  - `packages/shared/src/terminal-protocol.ts:305` 声明了 `codexThreadId`。
  - `packages/shared/src/terminal-protocol.ts:306` 声明了 `codexTurnId`。
  - `backend/src/terminal/agent-run-service.ts:99` 到 `backend/src/terminal/agent-run-service.ts:112` 实际按 terminal/source 匹配活跃或最近 run。
- 更好的候选方案：
  - 推荐：把 run identity 明确为 `operationId || codexTurnId || codexThreadId || pid || heuristic-window`，要求结构化 producer 尽量携带稳定 ID，heuristic 事件只能补充当前 run，不能覆盖强 ID run。
  - 简化方案：先不暴露多 run/strong identity，只返回 terminal 的 `activeAgentState` 快照，避免承诺可追踪历史 run。
  - 平台/工具链方案：优先接入 Codex `exec --json` 或 hook 自带 session/turn ID，把 Runweave 服务端降级为状态聚合器。
- 迁移/过渡风险：需要兼容已存在的弱 heuristic 事件；可以先保留旧路径，但只有没有结构化 ID 时才走弱匹配，并在响应中标注低置信度。

### P2 - `exec-json` 被建模成强信号，但当前没有接入运行链路

- 当前决策：协议增加 `exec-json` 模式，并将其置信度定义为 `strong`；同时新增 `parseCodexJsonLine`。
- 为什么这是系统层面风险：代码库对外形成“有强信号 agent-run 状态”的契约，但 `parseCodexJsonLine` 只被单测引用，没有接到终端输出 recorder、CLI 执行器或后端事件入口。上线后实际仍主要依赖 hook 和 active-command heuristic，复杂度增加但可靠性没有获得对应提升。
- 证据：
  - `packages/shared/src/terminal-protocol.ts:279` 到 `packages/shared/src/terminal-protocol.ts:282` 暴露 `exec-json` 模式。
  - `backend/src/terminal/codex-json-events.ts:11` 定义 parser。
  - `rg -n "parseCodexJsonLine|codex-json|exec --json"` 显示 parser 仅在 `backend/src/terminal/codex-json-events.test.ts` 中被引用，运行代码没有调用点。
- 更好的候选方案：
  - 推荐：在 terminal runtime recorder 或专门的 process wrapper 中接入 parser，解析每行 Codex JSON 后以 `operationId/thread/turn` 写入 agent-run 服务。
  - 更小方案：删除 `exec-json` 模式和 parser，只保留 `interactive-hook` / `terminal-heuristic`，等真实接入时再扩协议。
  - 平台/工具链方案：让 CLI 显式启动 `codex exec --json` 并把 stdout JSON 作为一等事件源，而不是从通用 terminal scrollback 旁路推断。
- 迁移/过渡风险：如果先删除 `exec-json`，需要同步调整已新增单测和 CLI handoff 输出预期；如果接入 parser，需要处理普通终端输出与 JSON line 混杂、隐私字段脱敏和 backpressure。

## 代码 / 实现发现

### P1 - 移动端 Stop 改成写入 ESC，普通前台命令无法被中断

- 为什么这是风险：App 原先通过 WebSocket 发送 `SIGINT`；当前 Stop 按钮改为 HTTP `/interrupt`，而后端固定向 PTY/tmux 写入 `\x1b`。ESC 对 `sleep`、构建、测试、dev server 等普通前台进程不是中断信号，用户看到 Stop 但命令不会停。
- 证据：
  - `app/src/pages/AppTerminalPage.tsx:159` 到 `app/src/pages/AppTerminalPage.tsx:164` Stop 调用 `interruptTerminalSession`。
  - `backend/src/routes/terminal.ts:78` 把 interrupt 定义为 `"\x1b"`。
  - `backend/src/routes/terminal.ts:621` 到 `backend/src/routes/terminal.ts:630` `/interrupt` 复用输入写入路径并返回 `interruptSequence: "escape"`。
  - `backend/src/routes/terminal.test.ts:2411` 到 `backend/src/routes/terminal.test.ts:2412` 单测明确断言只写 ESC，且不调用 `runtime.signal`。
- 修复方向：把“停止前台命令”和“取消 agent 当前输入/生成”拆成两个语义；Stop 默认仍应发送 `SIGINT`，tmux 下用等价的 Ctrl-C/send-keys 能力。若需要 ESC 取消 Codex UI，应暴露单独 `cancel-agent` 或 `interruptSequence` 参数，并由 UI 根据 agent state 选择。

### P2 - 已完成的 agent run 会屏蔽 App 对 activeCommand 的 Stop 回退

- 为什么这是风险：`getCurrent()` 没有 active run 时会返回最近的非 stale run，包括 `completed` / `cancelled`。App 只有在 `currentAgentRun` 为 `null` 时才根据 `metadata.activeCommand` 显示 Stop。因此一次 Codex 结束后，后续普通命令处于 activeCommand 状态时，Stop 可能不显示。
- 证据：
  - `backend/src/terminal/agent-run-service.ts:68` 到 `backend/src/terminal/agent-run-service.ts:75` 返回 active run，否则返回非 stale 历史 run。
  - `app/src/pages/AppTerminalPage.tsx:153` 到 `app/src/pages/AppTerminalPage.tsx:158` 只有 `!currentAgentRun` 才回退到 `metadata.activeCommand`。
- 修复方向：App 判断应按“是否有 active agent run”而不是“是否有任意 currentAgentRun”决定回退；或 API 拆成 `activeAgentRun` 与 `latestAgentRun`，避免一个字段同时表达当前状态和历史摘要。

### P3 - backend console 日志级别不再受 `RUNWEAVE_LOG_LEVEL` 控制

- 为什么这是风险：这次改动把 console transport 固定为 `error`，会让本地开发、Electron 子进程 stdout、CI 失败现场缺少 info/warn 级诊断。文件日志仍受 `RUNWEAVE_LOG_LEVEL` 控制，但本地复现终端/agent-run 状态问题时，工程师常先看 console。
- 证据：
  - `backend/src/logging/logger.ts:85` 到 `backend/src/logging/logger.ts:87` console transport 固定为 `error`。
  - `backend/src/logging/logger.ts:164` 到 `backend/src/logging/logger.ts:168` 初始 logger 也固定 error console。
  - `docs/quality/backend-rolling-logs.md:11` 仍描述默认日志级别由 `RUNWEAVE_LOG_LEVEL` 控制。
- 修复方向：如果目标是测试降噪，只在测试环境降低 console；如果目标是生产降噪，新增独立 `RUNWEAVE_CONSOLE_LOG_LEVEL`，不要让已有 `RUNWEAVE_LOG_LEVEL` 对 console 失效且无文档说明。

## 验证记录

- `git diff --check -- . ':(exclude)docs/review'`：通过。
- `pnpm --filter ./backend test -- terminal-agent-runs agent-run-service codex-json-events terminal-completion terminal`：通过，61 个文件、382 个测试。
- `pnpm --filter ./backend typecheck`：通过。
- `pnpm --filter @runweave/app typecheck`：通过。
- `pnpm --filter @runweave/cli typecheck`：通过。
- `pnpm --filter @browser-viewer/shared typecheck`：通过。
- `pnpm --filter @runweave/cli test -- terminal`：通过，3 个文件、10 个测试。

## 剩余风险 / 测试缺口

- 现有测试覆盖了 ESC interrupt 的实现，但没有覆盖用户语义：“Stop 应停止普通前台进程”。
- App 状态回退问题缺少 E2E 或手工回归：先完成一次 Codex run，再运行普通长命令，检查 Stop 是否显示且能中断。
- `exec-json` parser 只有单元测试，没有运行链路测试；即使 parser 正确，也不能证明线上会产生 strong agent-run 状态。
