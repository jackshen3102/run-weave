# Agent Team / Loop Engineer 代码复审

- 日期：2026-07-04
- Run：atr_94c0d13f_20260704055220
- 角色：code_reviewer
- 范围：当前 live worktree 的未提交 diff（`backend/src/agent-team/service.ts`、`frontend/src/components/terminal/terminal-workspace-shell.tsx`、`docs/README.md`、删除旧 orchestrator 测试文档）及相关 Agent Team 启动调用链。
- 说明：本轮未接管主控调度，未修改产品代码；仅新增本审查报告。

## 结论

当前改动修复了此前“run 先写入再等待 agent ready”与“Agent Team tab 过早打开后被回退”的主要问题，但 live 代码仍有两处 Agent Team 启动主路径风险。建议先修复后再进入人工验收或合入。

## 关键发现

### P1 严重：主 Agent 启动 prompt 注入失败会被吞掉，UI 可能进入 clarify 假成功

- 定位：`backend/src/agent-team/service.ts:226`、`backend/src/agent-team/service.ts:227`、`backend/src/agent-team/service.ts:644`、`backend/src/agent-team/service.ts:657`
- 风险：`startRun` 在 `ensureAgentReady` 后先写入 active run，再调用 `trySendToMain` 注入启动 prompt；但 `trySendToMain` 捕获异常后只打 warn，不向调用方返回失败。若 tmux pane、pty、runtime 写入或 panel target 在此阶段失败，接口仍返回 `phase="clarify"` / `status="clarifying"`，右侧 UI 看起来成功，主 Agent 实际没有收到“你是主 Agent”的流程约束，后续澄清、拆分和 worker 调度都可能停在错误现场。
- 证据：测试文档 `docs/testing/agent-team-loop-engineer-test-cases.md:190` 到 `docs/testing/agent-team-loop-engineer-test-cases.md:206` 要求开启流程后 main pane 收到启动 prompt，且 tmux workspace 初始化失败时不能进入半启动假成功；当前 prompt 注入失败路径仍会半成功。
- 修复方向：把启动 prompt 注入纳入 `startRun` 的成功条件。失败时不要保留 active clarify run；可选择在写入前完成注入，或注入失败后删除/标记 failed 并把明确错误返回 UI。

### P1 严重：同类 agent 正在运行时仍允许 Agent Team 接管并注入新 prompt

- 定位：`backend/src/agent-team/service.ts:769` 到 `backend/src/agent-team/service.ts:773`、`backend/src/terminal/terminal-state-service.ts:73` 到 `backend/src/terminal/terminal-state-service.ts:78`、`backend/src/agent-team/agent-readiness.ts:156` 到 `backend/src/agent-team/agent-readiness.ts:165`
- 风险：新增的 `requireAgentTeamTerminalAvailable` 只阻止“当前 agent 与目标 agent 不同”的场景；如果当前终端已经是同一个 agent（例如 Codex）且状态是 `agent_running`，检查会放行。随后 `ensureAgentReady` 只根据 scrollback 是否已有 Codex UI 判断 ready，不区分 idle/running，`trySendToMain` 会继续向一个正在处理其它任务的 Codex 会话注入 Agent Team 启动 prompt。这会覆盖/打断用户正在运行的同类 agent 任务，且不会显示冲突。
- 证据：`TerminalStateService.handleAgentHook` 明确把 `UserPromptSubmit` 记为 `agent_running`；当前可用性检查没有拦截该状态。
- 修复方向：启动 Agent Team 前要求目标 agent 至少不是 `agent_running`；允许复用同类 agent 时应限定为 `agent_idle` 或通过更明确的可接管判定。冲突错误应说明该 agent 当前正在运行，提示用户等待或新建终端。

## 回归覆盖

- 已执行：`git diff --check -- . ':(exclude)docs/review'`，通过。
- 已执行：`pnpm typecheck`，通过。
- 已执行：`pnpm lint`，通过。
- 未执行：`pnpm test` / Playwright E2E。当前 `frontend/tests/*.spec.ts` 未覆盖 `agent-team`、`panelSplitEnabled` 或 AGT-START 主路径；本轮也未启动浏览器服务做页面级验收。需要由行为验收 worker 使用 `$playwright-cli` 跑 Agent Team 入口与启动失败/冲突场景。

## 残余风险

- 本轮主要复审当前未提交修复 diff 与启动调用链，没有完整重审 `origin/main...HEAD` 中全部 77+ 文件的大型 Agent Team 替换。
- 分支当前 `main...origin/main` 为 ahead 2、behind 1；合入前还需要基于最新 `origin/main` 重新验证，避免与 `fix(terminal): handle stop completion fallback (#255)` 产生集成偏差。
