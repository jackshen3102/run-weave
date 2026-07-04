# Agent Team / Loop Engineer 失败修复增量审查

- 日期：2026-07-04
- Run：atr_3726db53_20260704063115
- 角色：code_reviewer
- 范围：当前 live worktree 中 code worker 的失败修复增量，重点检查 `backend/src/agent-team/agent-readiness.ts`、`backend/src/agent-team/service.ts`、`frontend/src/components/terminal/terminal-agent-team-panel.tsx`、`frontend/src/components/terminal/terminal-workspace-shell.tsx` 是否符合 AGT-AUTO-001、agent-team 生命周期和仓库约束。
- 约束：只读审查，不接管主控调度；本文件是本轮唯一新增产物。

## 结论

不建议直接进入最终验收或合入。AGT-AUTO-001 的后端自动确认主路径在静态代码上成立：`autoApproveSplit` 会绕过 proposal 人工门并直接调用 `applySplit` 进入 `executing`。但本轮失败修复增量仍留下 2 个 P1 生命周期风险，都会影响“只有真实 ready/active 的 Agent Team 才进入或保留流程”的核心契约。

## 关键发现

### P1 严重：Codex ready 正则过宽，可能把普通 shell 或旧 scrollback 误判为 Codex 已 ready

- 定位：`backend/src/agent-team/agent-readiness.ts:26` 到 `backend/src/agent-team/agent-readiness.ts:27`、`backend/src/agent-team/agent-readiness.ts:58` 到 `backend/src/agent-team/agent-readiness.ts:60`、`backend/src/agent-team/agent-readiness.ts:262` 到 `backend/src/agent-team/agent-readiness.ts:271`
- 风险：新增的 `(?:^|\n)\s*›\s` 会把任意行首 `› ` 当成 Codex ready。`ensureAgentReady` 在发送 `codex` 启动命令前先读 scrollback，只要命中该 pattern 就直接返回。若普通 shell prompt 使用 `›`，或 pane 里残留旧 Codex UI 的 prompt 行，即使当前并没有可接管的 Codex UI，也会跳过启动与 15 秒等待，随后 `startRun` 注入启动 prompt 并写入 `phase=clarify` / `status=clarifying`。这会回到 AGT-START-001/005 要避免的半启动假成功。
- 修复方向：不要用裸 `›` 作为全局 ready 信号；至少要求 Codex 特征行与输入 prompt 组合，或在发送启动命令后记录 scrollback baseline，只接受 baseline 之后出现的 Codex ready 标记。若保留历史复用，应结合 terminal state/pane 进程状态确认当前仍是 Codex UI。

### P1 严重：新建 clarify run 后父层仍不知道 active run，tab 保留契约没有闭环

- 定位：`frontend/src/components/terminal/terminal-agent-team-panel.tsx:196` 到 `frontend/src/components/terminal/terminal-agent-team-panel.tsx:207`、`frontend/src/components/terminal/terminal-agent-team-panel.tsx:211` 到 `frontend/src/components/terminal/terminal-agent-team-panel.tsx:217`、`frontend/src/components/terminal/terminal-workspace-shell.tsx:827` 到 `frontend/src/components/terminal/terminal-workspace-shell.tsx:833`、`frontend/src/components/terminal/terminal-workspace-shell.tsx:926` 到 `frontend/src/components/terminal/terminal-workspace-shell.tsx:963`
- 风险：`TerminalWorkspaceShell` 只有在项目/终端/API/token 变化时查询 active run；子面板 `startFlow` 成功进入 `clarify` 只更新自身 `run`，没有通知父层更新 `activeAgentTeamRunSessionId`。`requestSplit` 在自动确认后返回 `executing` 也没有回调父层。结果是当前页面中新创建的 active run 仍可能被父层视为不存在；一旦 `panelSplitEnabled` 被同窗口操作、metadata 或其它客户端置回 false，`showAgentTeamTool` 会变 false，`TerminalPreviewPanel` 会把 active tool 退回 Preview，违背“存在 active Agent Team run 时 tab 必须保留/恢复”的生命周期约束。
- 修复方向：给 `TerminalAgentTeamPanel` 增加 active run 变化回调，或把父层 active run 查询暴露成 refresh 方法，在 start/propose auto-approve/confirm/resume 后立即同步 `activeAgentTeamRunSessionId`。不要只依赖 session 切换或刷新时的初始查询。

## AGT-AUTO-001 对照

- 静态符合点：`backend/src/agent-team/service.ts:252` 到 `backend/src/agent-team/service.ts:260` 在 `run.options.autoApproveSplit` 为 true 时直接 `applySplit`，不会写入 `proposal` / `need_human`；日志也包含“自动确认拆分已开启，跳过人工门，直接 split”或 Agent 主导等价文案。
- 残余风险：该路径仍受上面两个 P1 影响。ready 误判会让自动确认建立在假的主 Agent 启动上；前端父层 active run 不同步会让自动确认后的 tab/面板状态依赖陈旧 session 状态。

## 验证记录

- 已执行：`git diff --check -- . ':(exclude)docs/review'`，通过。
- 已执行：`pnpm typecheck`，通过。
- 已执行：`pnpm lint`，通过。
- 未执行：`pnpm test` / `$playwright-cli`。本轮角色是代码审查，且当前结论仍要求修复；浏览器行为验收应在修复后由验收 worker 覆盖 AGT-AUTO-001、AGT-START-001、AGT-START-003、AGT-START-005。

## 残余风险

- 本轮只审查 code worker 的失败修复增量，没有重审整个 Agent Team 替换的大型历史 diff。
- 工作区已有其它未跟踪 review 报告，本轮未修改或覆盖。
