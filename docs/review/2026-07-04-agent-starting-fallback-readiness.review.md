# Agent Starting fallback readiness 代码审查

## 评审范围

- Run: `atr_42ec587c_20260704065446`
- Role: `code_review`
- 审查对象：只读复核当前 `browser-hub/feature` 中 orchestrator Agent Starting / fallback readiness 相关增量。
- 重点风险：假 ready、启动 prompt 注入失败半成功、正在运行的同类 agent 被覆盖、active run 下 Agent Team tab 保留、越界改动。
- 未修改源码、配置、测试；仅新增本审查报告。

## 结论

**Fail。** 当前实现没有真正关闭 Agent Starting fallback readiness 风险。后端仍会在 startup prompt 发送前落盘 `status=running` 的 run，失败后没有回滚或标失败；同类 agent 已经存在但 UI readiness 未满足时仍会再次发送启动命令，可能把 `codex` 当作 prompt 注入到正在运行的同类 agent。前端 active run 监控态也没有保留 Agent Team/参与角色配置视图。

## 关键发现

- **P1 严重：启动/注入失败会留下 running run，形成半成功 active run。** `createRun()` 在 `writeRun()` 和 `routeTable.set()` 后才执行 `ensureOrchestratorAgentReady()` 与 `sendPromptToAgent()`；任一环节抛错都会直接返回 HTTP 错误，但已经写入的 run 由 `buildRunPackage()` 固定为 `status: "running"`，且只有 `run_created` timeline，没有失败状态或回滚。前端 `activeRun` 会优先选中 `running/paused/need_human`，因此这个半成功 run 会挡住配置态并表现成 active run。定位：`backend/src/orchestrator/service.ts:247`、`backend/src/orchestrator/service.ts:249`、`backend/src/orchestrator/service.ts:253`、`backend/src/orchestrator/domain/run-domain.ts:65`、`frontend/src/components/terminal/terminal-orchestrator-panel.tsx:98`。修复方向：把 run 持久化移动到 agent ready + startup prompt 成功之后，或在 catch 中把 run 更新为 `failed` 并记录失败 timeline；失败不能留下 `running` active run。

- **P1 严重：同类 agent 已在运行但 UI readiness 未满足时，会再次发送启动命令覆盖/注入到该 agent。** `ensureOrchestratorAgentReady()` 只有在“requested agent ready 且 UI ready”时 return；不同 agent 会 409，但同一 agent 且 UI readiness 不满足时继续执行 `sendInputToSession(... buildAgentStartCommand(...), "line")`。如果终端已经是 `agent_running/codex` 或 `activeCommand=codex`，但 scrollback 没有匹配到 `OpenAI Codex`，这里会把 `codex` 再发进同一个 Codex TUI，实际是 prompt 注入而不是安全启动。定位：`backend/src/orchestrator/terminal/agent-readiness.ts:52`、`backend/src/orchestrator/terminal/agent-readiness.ts:54`、`backend/src/orchestrator/terminal/agent-readiness.ts:59`、`backend/src/orchestrator/terminal/agent-readiness.ts:66`、`backend/src/orchestrator/terminal/agent-readiness.ts:77`。修复方向：当 `initial.currentAgent === agent` 但 UI readiness 不满足时，不应再发送启动命令；应等待到超时后报错，或只允许在明确 shell idle/no agent 时启动。

- **P2 一般：active run 监控态没有保留 Agent Team/参与角色 tab。** active run 存在且状态非 `done/failed` 时，面板只渲染 `RunMonitor`；`RunMonitor` props 没有 `roles`/`roleDrafts`，内容包含目标进度、Summary、人工介入、时间线，但没有 `RunConfig` 中的“参与角色/Agent Team”配置区。定位：`frontend/src/components/terminal/terminal-orchestrator-panel.tsx:529`、`frontend/src/components/terminal/orchestrator/RunMonitor.tsx:29`、`frontend/src/components/terminal/orchestrator/RunMonitor.tsx:102`、`frontend/src/components/terminal/orchestrator/RunConfig.tsx:118`。修复方向：active run 监控态保留只读 Agent Team/参与角色 tab，或把角色/绑定信息显式纳入 `RunMonitor`。

- **P2 一般：测试只覆盖成功契约，没有覆盖本次 readiness 失败面。** 测试文档仍把创建 run 的预期写成返回 `status=running` 且含 `run_created`/`direct_send`，没有 startup timeout / prompt send failure / 同类 agent already-running no-restart 的断言；`frontend/tests/terminal.spec.ts` 的 fake Codex 用例是 tmux loss resume，不覆盖 orchestrator readiness。定位：`docs/testing/2026-06-17-multi-agent-orchestrator-test-cases.md:193`、`docs/testing/2026-06-17-multi-agent-orchestrator-test-cases.md:198`、`docs/testing/2026-06-17-multi-agent-orchestrator-test-cases.md:338`、`docs/testing/2026-06-17-multi-agent-orchestrator-test-cases.md:353`、`frontend/tests/terminal.spec.ts:1230`。修复方向：增加服务级用例，覆盖 `sendPromptToAgent` 抛错不留下 running run、同类 agent running 但 UI 未 ready 时不发送启动命令、ready 成功后才出现 `direct_send`。

- **P2 一般：当前工作区有大量与本意图无关的未提交 explorer quick search 改动，审查边界被污染。** `git status --short` 显示未提交改动集中在 `backend/src/terminal/preview-*`、`frontend/src/components/terminal/terminal-preview-*`、`frontend/tests/terminal-preview.spec.ts`、`docs/plans/2026-07-04-explorer-quick-search.md` 等，和 Agent Starting readiness 不同域。修复方向：本 run 的修复/提交应隔离 readiness 相关文件，避免把 explorer quick search 一并带入。

## 已确认事项

- 假 ready 风险有部分防护：对 Codex，当前实现要求 agent state/active command 与 `OpenAI Codex` UI scrollback 同时满足才 return；不同 agent 已存在时会 409。定位：`backend/src/orchestrator/terminal/agent-readiness.ts:54`、`backend/src/orchestrator/terminal/agent-readiness.ts:55`、`backend/src/orchestrator/terminal/agent-readiness.ts:59`、`backend/src/orchestrator/terminal/agent-readiness.ts:175`。
- startup prompt 会走目标 panel binding：`createRun()` 把 `input.orchestrator.binding` 传给 `sendPromptToAgent()`，tmux session 下会调用 `resolvePanelTarget()`。定位：`backend/src/orchestrator/service.ts:253`、`backend/src/orchestrator/service.ts:261`、`backend/src/orchestrator/terminal/prompt-sender.ts:52`。

## 验证

- 已执行只读检查：`git status --short --branch`、`git diff --stat`、`git diff origin/feature...HEAD` 相关文件、`rg`、`nl -ba`。
- 未执行浏览器验证；本次发现基于后端状态机/持久化顺序和前端条件渲染，未涉及浏览器交互验收。
- 未执行测试命令；本次是 worker 只读审查，结论来自代码路径与现有测试覆盖缺口。
