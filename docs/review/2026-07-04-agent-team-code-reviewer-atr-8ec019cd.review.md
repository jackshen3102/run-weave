# Agent Team code_reviewer 审查报告

- Run: `atr_8ec019cd_20260704065620`
- Role: `code_review`
- 审查范围：当前工作区中 code worker 针对失败用例产生的增量，重点覆盖 Agent Team 生命周期、readiness、startup prompt 注入失败传播、仓库约束。
- 审查方式：只读代码审查；未修改源码、配置、测试文档。

## 结论

不建议直接合入。当前增量通过了静态检查，但存在 2 个 P1 行为风险：worker pane readiness 会覆盖 session 级主 Agent 状态；Codex ready 正则可能把普通 shell prompt 误判为 Codex ready，从而让 readiness 假成功并把 startup prompt 注入到错误上下文。

## 关键发现

### P1：worker pane readiness 会把 session 级主 Agent 运行态覆盖成 idle

- 位置：`backend/src/agent-team/agent-readiness.ts:189`
- 位置：`backend/src/agent-team/agent-readiness.ts:193`
- 位置：`backend/src/agent-team/service.ts:482`
- 风险：`applyExecutingPhase` 为每个 worker pane 调用 `ensureAgentReady(session, terminal, { panelId })`；当目标 pane 出现 Codex ready 后，`isAgentUiReady` 会调用 session 级 `terminalStateService.setAgentIdle(session.id, agent, ...)`。`TerminalStateService` 目前是 terminal session 维度，不是 pane 维度；因此 worker pane ready 会把同一个 session 的主 pane 状态改成 `agent_idle`，即使主 Agent 正在执行或刚通过 hook 进入 `agent_running`。这会破坏 Agent Team 生命周期展示、App/Web status、stop/action gating，以及后续依赖 terminal state 的 readiness/overview 判断。
- 修复方向：pane-target readiness 不应直接发布 session 级 terminal state；至少应区分 main panel 与 worker panel。可在 `ensureAgentReady` 增加是否允许发布 session state 的参数，或只在无 pane target / main panel target 时调用 `setAgentIdle`，worker pane 只返回 readiness 结果。

### P1：Codex ready 正则过宽，可能把 shell prompt 误判为 ready

- 位置：`backend/src/agent-team/agent-readiness.ts:26`
- 位置：`backend/src/agent-team/agent-readiness.ts:179`
- 位置：`backend/src/terminal/terminal-state-service.ts:17`
- 位置：`packages/runweave-cli/src/commands/terminal-agent.ts:17`
- 风险：新增/复用的 ready/prompt 检测接受单独的 `›` 或 `[›>]` prompt。普通 zsh/starship/fish prompt 也可能显示为 `›`，如果 `codex` 启动失败、命令不存在、或 shell 直接回到 prompt，`hasStartedCodexUi` / CLI `isRequestedAgentReady` 仍可能判定 ready，随后 `startRun` 会继续注入 startup prompt。这正好违背“readiness 失败不假成功、startup prompt 注入失败不吞错”的验收重点，因为 prompt 可能被注入到 shell 而不是 Codex UI。
- 证据：用当前正则验证，`"› "` 和 `"\n› "` 都返回 `true`。
- 修复方向：ready 判定需要绑定 Codex 独有上下文，例如必须同时匹配 Codex banner/model/status 行、Codex activeCommand/terminalState 的可信来源、或比单字符 prompt 更严格的 UI 结构；不要把单独的 prompt glyph 当成充分 ready 条件。CLI 的 `AGENT_PROMPT_PATTERN` 也应同步收窄，否则 `rw terminal agent --agent codex` 仍可能假成功。

## 通过项

- `startRun` 已改为在 startup prompt 注入成功后才写入 run store；主 prompt 注入失败会抛 `AgentTeamError`，没有继续返回成功 run。
- worker split 失败由原先 warn 后继续，改为抛 `createAgentTeamPanelError`，不会在 pane 创建失败时假装进入 executing。
- proposal worker 草稿同步增加 dirty guard，能避免轮询覆盖用户编辑。
- 未引入 `useCallback`，符合本仓库 React Hooks 约束。
- 新增共享协议值 `agent_starting` 后，Web/App/CLI 的类型检查均覆盖到当前编译范围。

## 验证

- `git diff --check`：通过
- `pnpm typecheck`：通过
- `pnpm lint`：通过
- 正则行为探针：`"› "` / `"\n› "` 命中当前 Codex ready 正则

## 残余风险

- 本次是 code review worker，只做静态/命令级审查，未启动浏览器做 `$playwright-cli` 页面验收。
- 删除旧 `docs/testing/2026-06-17-multi-agent-orchestrator-test-cases.md` 与 `docs/README.md` 入口移除看起来有新 `docs/testing/agent-team-loop-engineer-test-cases.md` 承接；本轮未完整逐条比对旧 orchestrator 用例覆盖是否全部迁移。

## 建议下一步

1. 先修复 pane readiness 不发布 session 级状态的问题，并补充真实 Agent Team split 场景验证。
2. 收窄 Codex ready / prompt 检测，覆盖 “codex 启动失败后回到 `›` shell prompt” 的验收用例。
3. 修复后由 behavior_verify 使用 `$playwright-cli` 跑 Agent Team 启动与 split worker 场景。
