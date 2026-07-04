# Agent Team / Loop Engineer 代码审查

## 范围

- Run: `atr_35687973_20260704040023`
- Role: `code_review`
- 审查对象：当前未提交工作区与未跟踪文件。
- 重点：Agent Team / Loop Engineer 增量、session 级 `panelSplitEnabled`、CLI panel agent 投递、回归覆盖文档。

## 结论

不建议直接进入验收或合入。静态质量门通过，但有 2 个 P1 功能回归风险和 1 个 P2 契约覆盖问题，集中在 Agent Team 启动失败恢复、右键入口打开竞态、CLI `--agent` 名称契约。

## 关键发现

### P1 严重：Agent readiness 失败后会留下 active run，后续重复开启被 409 阻断

- 定位：`backend/src/agent-team/service.ts:189`、`backend/src/agent-team/service.ts:215`、`backend/src/agent-team/service.ts:216`、`backend/src/agent-team/agent-readiness.ts:121`
- 风险：`createRun` 先构造并写入 `phase="clarify"` / `status="clarifying"` 的 run，再调用 `ensureAgentReady`。如果 Codex 不可用、trust prompt 未处理成功或 15 秒超时，路由会返回错误，但已写入的 run 仍是 active。下一次同 terminal 再开启会命中 `This terminal already has an active agent-team run`，用户被卡在一个没有真正 ready 的流程里。
- 证据：测试文档 `docs/testing/agent-team-loop-engineer-test-cases.md:250` 到 `docs/testing/agent-team-loop-engineer-test-cases.md:262` 明确要求 Codex 启动超时时“UI 保持可恢复，不进入 clarify”；当前写入顺序与该期望冲突。
- 修复方向：把 readiness 放到持久化 active run 之前，或在 readiness / prompt 注入失败时把 run 标记为 `failed` / 删除临时 run，并把错误保留到 UI 可恢复状态。重复开启检查也应能忽略启动失败的残留 run。

### P1 严重：右键 Agent Team 入口存在异步竞态，可能打开后立刻退回 Preview

- 定位：`frontend/src/components/terminal/terminal-workspace-shell.tsx:784` 到 `frontend/src/components/terminal/terminal-workspace-shell.tsx:827`、`frontend/src/components/terminal/terminal-preview-panel.tsx:161` 到 `frontend/src/components/terminal/terminal-preview-panel.tsx:164`
- 风险：`requestAgentTeam` 调用 `setPanelSplitEnabled(..., true)` 后立即 `openAgentTeam()`，但 `setPanelSplitEnabled` 内部是 fire-and-forget async PATCH。PATCH 返回并更新 session 前，`showAgentTeamTool` 仍为 false；`TerminalPreviewPanel` 的 effect 会把 `activeTool="agent-team"` 立刻改回 `"preview"`。用户点击右键菜单后可能看不到 Agent Team tab，直到再次点击或手动切换，直接影响新增入口主路径。
- 证据：`showAgentTeamTool` 依赖 `panelSplitEnabled` 的服务端返回值；而 `openAgentTeam()` 不等待该状态落入 store。
- 修复方向：让开启 Agent Team 的流程 await PATCH 成功后再切 active tool，或引入本地 pending 状态让 `showAgentTeamTool` 在本次打开期间为 true；失败时不要切到 Agent Team，并显示请求错误。

### P2 一般：CLI `--agent <name>` 契约与当前识别逻辑不一致，缺少回归用例

- 定位：`docs/testing/runweave-cli-control-plane-test-cases.md:14`、`packages/runweave-cli/src/commands/terminal-agent.ts:393`、`packages/runweave-cli/src/commands/terminal-agent.ts:527` 到 `packages/runweave-cli/src/commands/terminal-agent.ts:536`
- 风险：测试契约写明 `rw terminal send --agent <name>` 不归一化 agent 名，参数校验也允许任意 `[A-Za-z0-9._-]`。但 readiness 判断现在通过 `isKnownAgentName` 白名单识别 active command；自定义 agent 名会被识别为 null，可能导致等待超时或错误地认为目标 pane 没有 agent。新增的 RW-SEND-020 只覆盖 `codex`，没有覆盖“任意 agent 名 + panel/role 定向”的既有契约。
- 修复方向：明确 CLI 是否只支持白名单 agent。如果继续支持任意 agent 名，`isRequestedAgentReady` / `resolveCurrentAgent` 应按请求名匹配 active command，而不是固定白名单；同时补充一个自定义 agent 名的控制面测试案例。若收窄为白名单，文档和参数校验需要同步收紧。

## 回归覆盖评价

- 新增 `docs/testing/agent-team-loop-engineer-test-cases.md` 覆盖了入口、session 级 panel split、run 绑定、agent readiness、刷新恢复、冲突、超时等关键用户路径，方向正确。
- 现有 Playwright E2E 文件中没有 `agent-team` / `panelSplitEnabled` / `RW-SEND-020` 的自动化覆盖；当前主要是测试文档覆盖，尚不是可执行回归。
- 未新增非 E2E 测试文件，符合本仓库“只保留 Playwright E2E”的测试约束。

## 已执行验证

- `git diff --check`：通过。
- `pnpm typecheck`：通过。
- `pnpm lint`：通过。
- 未执行 `$playwright-cli` 浏览器验收：本次是只读代码审查，发现的问题已由代码路径直接定位；合入前仍建议用 `$playwright-cli` 覆盖 Agent Team 右键入口与启动失败恢复。

## 建议下一步

1. 先修复 P1 的 run 持久化顺序/失败回滚，否则启动失败会污染同一 terminal 的后续流程。
2. 修复右键入口竞态后，用 `$playwright-cli` 跑 AGT-ENTRY-002 / AGT-START-005 的真实页面验收。
3. 明确 CLI `--agent` 支持范围，并同步代码、文档和 RW-SEND-020 附近的测试案例。
