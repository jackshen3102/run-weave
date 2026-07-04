# AGT-CONC-001 code worker 增量审查

## 结论

不建议放行。`pnpm typecheck`、`pnpm lint` 和 `git diff --check` 均通过，且本次 diff 没有引入 React `useCallback` 或新增非 E2E 测试文件；但 code worker 的“no code defect / changedFiles: []”结论不成立。当前代码仍有 active run 选择和 pane/outbox 归属校验缺口，无法证明 AGT-CONC-001 的 projectId + terminalSessionId 隔离、并发开始、split pane 归因已经闭合。

## 审查范围

- Run: `atr_95409142_20260704140601`
- 被审查 worker outbox: `.runweave/outbox/95409142.panel-4a50e80c-6a49-43b7-b84a-61d9b176e810.json`
- 本 worker outbox: `.runweave/outbox/95409142.panel-488ff2f8-49e0-4b7d-867f-b6b45ace841c.json`
- 重点路径：`backend/src/agent-team/*`、`backend/src/routes/terminal-completion.ts`、`backend/src/routes/terminal-panel-routes.ts`、`backend/src/terminal/*`、`frontend/src/components/terminal/*`

## 关键发现

- **P1 严重：active run 选择仍返回“最新任意 run”，不是“当前 active run”。** `AgentTeamRunStore.getRunByTerminalSession()` 只按 `updatedAt` 排序后返回第一个同 terminal run，没有把 `done/failed` 排除，也没有显式选择 `running/need_human` 等 active 状态；`startRun()` 和 completion 处理都复用这个函数。若同一 `projectId + terminalSessionId` 下最新文件是 `done/failed`，但较旧文件仍是 `running`，并发开始会被错误放行；反过来 completion 也可能被路由到错误 run 或被忽略。定位：`backend/src/agent-team/storage/run-store.ts:54`、`backend/src/agent-team/storage/run-store.ts:59`、`backend/src/agent-team/storage/run-store.ts:61`、`backend/src/agent-team/service.ts:153`、`backend/src/agent-team/service.ts:637`。修复方向：新增语义明确的 `getActiveRunByTerminalSession(projectId, terminalSessionId)`，只返回 active 状态并在 `startRun()` / `handleTerminalEvent()` 使用；list/detail API 可以继续保留历史 run 查询。

- **P1 严重：completion 只带未知 `tmuxPaneId` 时仍被接受，不能证明 pane 属于当前 terminal session。** `resolveCompletionPane()` 对未知 `panelId` 会拒绝，但当请求只带 `tmuxPaneId` 且 `listPanels(terminalSessionId)` 找不到对应 pane 时，仍返回 `ok: true`，后续会记录 completion event 并进入 outbox 解析。这样错带 `terminalSessionId` 的 hook 或其它 pane 的 stale tmux id 仍可能推进当前 run。定位：`backend/src/routes/terminal-completion.ts:201`、`backend/src/routes/terminal-completion.ts:205`、`backend/src/routes/terminal-completion.ts:228`、`backend/src/routes/terminal-completion.ts:229`。修复方向：当 `tmuxPaneId` 存在但不属于该 session 的 panel workspace 时返回 `unknown_tmux_pane_id` 并忽略；若要兼容旧单 pane hook，应只在没有 split workspace 且没有 worker run 归因需求时走 legacy 路径。

- **P1 严重：Agent Team 仍优先读取请求携带的 `outboxPath`，且不校验 outbox 的 project/session/run 归属。** `AgentTeamOutboxResolver.outboxCandidates()` 把 `event.payload.outboxPath` 放在 pane-scoped 默认路径之前；`matchesCompletionPane()` 只比较 `panelId/tmuxPaneId`，没有拒绝 `outbox.projectId`、`outbox.sessionId`、`outbox.runId` 与 event/run 不一致的文件。只要 hook 携带错误路径且文件里写了匹配 pane 字段，就可能跨 project/session 或跨 run 读入验收结果。定位：`backend/src/agent-team/outbox-resolver.ts:52`、`backend/src/agent-team/outbox-resolver.ts:85`、`backend/src/agent-team/outbox-resolver.ts:89`、`backend/src/agent-team/outbox-resolver.ts:103`、`packages/shared/src/agent-team.ts:132`、`packages/shared/src/agent-team.ts:136`、`packages/shared/src/agent-team.ts:137`。修复方向：Agent Team 场景优先使用服务端生成的 pane-scoped 路径；若保留 `outboxPath`，必须 normalize 到当前 project root 下，并强制校验 `sessionId/projectId/runId/panelId/tmuxPaneId` 与 event/current run 一致。

- **P2 一般：code worker 的“无改动/无缺陷”结论缺少对当前 diff 的解释。** code worker outbox 声称 `no code defect found` 且 `changedFiles: []`，但当前工作区有 19 个相关文件增量，其中包括 outbox resolver、Agent Team service、terminal completion、tmux metadata 和前端 workspace shell。这个结论不能作为 AGT-CONC-001 放行依据。定位：`.runweave/outbox/95409142.panel-4a50e80c-6a49-43b7-b84a-61d9b176e810.json:9`、`.runweave/outbox/95409142.panel-4a50e80c-6a49-43b7-b84a-61d9b176e810.json:37`。修复方向：code worker 应重新基于实际 diff 给出变更清单和未覆盖风险，或明确说明这些 diff 属于前置增量且逐项验证通过。

## 通过项

- `backend/src/agent-team/service.ts` 新增 `agentTeamRunId` / run-scoped role 后，worker pane 复用不再只靠 alias + role，能避免不同 run 的同名 worker pane 被直接复用。
- worker prompt 已要求 pane-scoped outbox，例如 `.runweave/outbox/<terminalSessionId>.panel-<panelId>.json`，这比 session 级 outbox 更接近 AGT-CONC-001 目标。
- 本次 diff 未新增 `useCallback` / `React.useCallback`。
- 本次 diff 未新增 `*.test.*`、非 `frontend/tests/*.spec.ts` 的自动化测试文件。

## 验证命令

- `git status --short && git diff --stat`：当前工作区有 19 个相关文件增量。
- `git diff -U0 -- backend frontend packages docs | rg -n "^\\+.*(useCallback|React\\.useCallback|\\.test\\.|\\.spec\\.|describe\\(|it\\()|^\\+\\+\\+ b/.*(\\.test\\.|\\.spec\\.)"`：无命中。
- `git diff --check`：通过。
- `pnpm typecheck`：通过。
- `pnpm lint`：通过。
- `tmux list-panes -a -F ... | rg '95409142|%71|%72|%73'`：当前 run 的 `%71/%72/%73` 确实在 `runweave-95409142`，但这是当前现场证据，不等价于代码入口已经拒绝未知 pane。

## 建议下一步

1. 先修 `getRunByTerminalSession()` 的 active 语义，避免并发开始和 completion event 共享一个“任意历史 run”查询。
2. 再修 completion pane 校验：未知 `tmuxPaneId` 不应进入 Agent Team outbox 归因。
3. 最后修 outbox resolver：只接受服务端可推导且归属字段完全匹配的 pane-scoped outbox。
4. 修复后让 behavior_verify 用 `$playwright-cli` 重跑 AGT-CONC-001，并保留真实并发开始和错 pane/stale pane 的失败前置证据。
