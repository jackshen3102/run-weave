# TerminalState activeCommand 代码审查

## 审查范围

- Run: `atr_61e23e5e_20260704125552`
- Role: `code_review`
- 当前工作区 diff：
  - `backend/src/terminal/terminal-state-service.ts`
  - `backend/src/terminal/tmux-service.ts`
  - `backend/src/ws/terminal-server.ts`
  - `docs/testing/terminal-state-test-cases.md`

本次审查只覆盖当前 live diff。run 包里的原始任务是 `AGT-AUTO-001` 自动确认拆分复测，但当前代码改动实际集中在 TerminalState / tmux metadata / 测试文档；未接管主控调度，也未修改源码逻辑。

## 结论

未发现 P0/P1/P2 级别问题。

代码方向与目标契约一致：`TerminalStateService` 的 agent 判断现在只依赖当前 `activeCommand`，不会再因为 session 原始启动 `command="codex"` 复活 Codex 状态；tmux metadata 增加 `activeCommandSource` 后，WebSocket 只在来源确认为 `pane_current_command` 且前台进程退化为 `node` 时保留已有 Node-wrapped command，避免真实 shell hook 报告普通 `node` 时继续保留旧 Codex 状态。

## 关键发现

- 无 P0 阻断。
- 无 P1 严重。
- 无 P2 一般。

## 残余风险 / 待确认

- P3 提示：真实路径回归还需要由行为验收覆盖。代码审查和静态检查能确认 `getTerminalSessionAgent()` / `isCodexSession()` 的静态不变量，以及 `activeCommandSource` 没有泄露到客户端协议；但 `docs/testing/terminal-state-test-cases.md` 自身要求通过真实 terminal session、真实 shell hook、真实 tmux metadata、真实 API 流量验证 `TS-API-007/008`、`TS-WS-003`、`TS-HOME-006`、`TS-CLI-005` 等路径。当前 code_review worker 未执行 Playwright 或真实终端验收，应等待 `behavior_verify` worker 回传证据后再判定回归覆盖完成。

## 验证

- `git diff --check`：通过。
- `pnpm typecheck`：通过，9 个 workspace project typecheck 完成。
- `pnpm lint`：通过，9 个 workspace project lint 完成。

## 证据摘要

- `backend/src/terminal/terminal-state-service.ts:12` 的 `TerminalStateSessionSnapshot` 已移除 `command`，`getTerminalSessionAgent()` / `isCodexSession()` 只接受并读取 `activeCommand`。
- `backend/src/terminal/tmux-service.ts:34` 为 `TmuxPaneMetadata` 增加 `activeCommandSource`，`readPaneMetadata()` 和 `listPanes()` 都通过 `resolvePaneActiveCommand()` 标记来源。
- `backend/src/ws/terminal-server.ts:66` 的 `shouldKeepExistingActiveCommand()` 只在 `nextActiveCommandSource === "pane_current_command"` 且 `nextActiveCommand` basename 是 `node` 时保留已有 command，避免 `@runweave_command` 明确报告的普通命令被旧状态覆盖。
- `docs/testing/terminal-state-test-cases.md:5` 明确系统验收必须来自真实路径，`docs/testing/terminal-state-test-cases.md:221` 起的推荐落地顺序也把真实浏览器/API/App/CLI 验收放在静态审查之后。
