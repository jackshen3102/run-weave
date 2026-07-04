# Agent Team / Agent Starting fallback readiness 复核报告

- Run: `atr_42ec587c_20260704065446`
- Role: `code_review`
- 仓库：`browser-viewer`
- 范围：当前 browser-viewer live diff；重点复核 Agent Team / Agent Starting fallback readiness，不审查 `browser-hub/feature` 和旧 orchestrator。
- 方式：只读代码审查；未修改源码、配置、测试。本文是本轮唯一新增产物。

## 结论

**Fail。** 当前增量已经修复了部分历史问题：`startRun()` 现在在 agent ready 和 startup prompt 注入成功后才写 run，active run 下 Agent Team tab 也通过父子回调保留。但仍有 3 个风险会影响“真实 ready 才注入 / 不覆盖同类 agent / 状态不误报”的核心契约，其中 2 个为 P1。

## 关键发现

### P1 严重：Codex ready 正则过宽，普通 shell prompt 可被判成 ready

- 定位：`backend/src/agent-team/agent-readiness.ts:26`、`backend/src/agent-team/agent-readiness.ts:179`、`backend/src/agent-team/agent-readiness.ts:293`、`backend/src/terminal/terminal-state-service.ts:17`。
- 风险：当前 ready pattern 接受单独行首 `›`，本轮探针确认 `"› "`、`"\n› "`、`"zsh prompt\n› "` 都会命中。若 `codex` 启动失败后回到 shell，或普通 shell/starship prompt 使用该字符，`ensureAgentReady()` 会认为 Codex UI ready，随后 `sendStartupPromptToMain()` 会把 Agent Team 启动 prompt 注入 shell 或错误上下文，并在 `backend/src/agent-team/service.ts:227` 后写入 clarify run。这正是 AGT-START 要避免的假 ready / 半成功。
- 修复方向：不要把裸 `›` 当作充分 ready 信号；要求 Codex 独有 banner/model/status 组合，或记录启动前 scrollback baseline，只接受启动命令之后出现的可信 Codex UI 标记。

### P1 严重：worker pane readiness 会发布 session 级 `agent_idle`，覆盖主 Agent 状态

- 定位：`backend/src/agent-team/service.ts:482`、`backend/src/agent-team/agent-readiness.ts:189`、`backend/src/agent-team/agent-readiness.ts:193`、`backend/src/terminal/terminal-state-service.ts:84`。
- 风险：`applySplit()` 为每个 worker pane 调用 `ensureAgentReady(session, terminal, { panelId })`；pane ready 后 `agent-readiness` 仍调用 session 级 `terminalStateService.setAgentIdle(session.id, ...)`。`TerminalStateService` 是 terminal session 维度，不是 pane 维度，所以 worker pane ready 会把同一 session 的主 Agent `agent_running` / `agent_starting` 改成 `agent_idle`。这会污染 Web/App 状态展示、Stop/action gating，以及后续 readiness 判断。
- 修复方向：pane-target readiness 不应发布 session 级 terminal state；至少只允许 main pane / 无 pane target 更新 session state，worker pane 只返回 readiness 结果或引入 pane 级 agent state。

### P2 一般：`agent_starting` 同类占用未被拦截，可能重复发送启动命令

- 定位：`backend/src/agent-team/service.ts:802`、`backend/src/agent-team/service.ts:806`、`backend/src/agent-team/service.ts:812`、`backend/src/agent-team/agent-readiness.ts:63`、`backend/src/agent-team/agent-readiness.ts:79`。
- 风险：`requireAgentTeamTerminalAvailable()` 只阻止 `agent_running` 和“不同 agent”；如果当前 session 已是同一个 `agent_starting/codex`，检查会放行。随后 `ensureAgentReady()` 在未识别 UI ready 时会再次发送 `codex` 启动命令。快速重复点击或上一轮启动仍在进行时，仍可能污染同类 agent 启动现场。
- 修复方向：把 `agent_starting` 也视为占用态，返回明确 409 或等待已有启动完成；只有 `shell_idle` 或经确认可接管的 `agent_idle` 才允许启动 Agent Team。

### P2 一般：测试契约未同步 `agent_starting`

- 定位：`packages/shared/src/terminal-protocol.ts:446`、`docs/testing/terminal-state-test-cases.md:138`、`docs/testing/terminal-state-test-cases.md:139`。
- 风险：协议已新增 `agent_starting`，App/Web 也新增展示，但 `terminal-state-test-cases.md` 仍要求 `activeCommand="codex"` 且无 running hook 时 App home 展示 `agent-idle`。测试契约与当前代码目标不一致，会让后续验收无法判断“Starting”是预期还是回归。
- 修复方向：补充 `agent_starting` 的 API/App/Web/CLI 用例，并明确何时从 starting 迁移到 idle。

## 已确认修复点

- startup prompt 注入失败不再被吞掉：`startRun()` 在 `backend/src/agent-team/service.ts:222` 完成 readiness，`backend/src/agent-team/service.ts:227` 注入 startup prompt，成功后才在 `backend/src/agent-team/service.ts:228` 写 run；`sendStartupPromptToMain()` 会在注入失败时抛 `AgentTeamError`。
- active run 下 Agent Team tab 保留链路已补齐：子面板通过 `frontend/src/components/terminal/terminal-agent-team-panel.tsx:128` 通知 active run，父层 `frontend/src/components/terminal/terminal-workspace-shell.tsx:841` 允许 active run 绕过 `panelSplitEnabled` 保留 tab，并在 `frontend/src/components/terminal/terminal-workspace-shell.tsx:870` 自动打开 Agent Team。
- 不同 agent 和 `agent_running` 冲突已有保护：`backend/src/agent-team/service.ts:806` 拦截 running，`backend/src/agent-team/service.ts:812` 拦截不同 agent。

## 验证记录

- `git status --short --branch`：确认当前仓库为 `browser-viewer`，live diff 命中本轮指定文件。
- `git diff --check -- <指定文件>`：通过。
- 静态阅读：逐行核对 `backend/src/agent-team/agent-readiness.ts`、`backend/src/agent-team/service.ts`、`frontend/src/components/terminal/terminal-agent-team-panel.tsx`、`frontend/src/components/terminal/terminal-preview-panel.tsx`、`frontend/src/components/terminal/terminal-workspace-shell.tsx`、`app/src/hooks/use-app-session.ts`、`app/src/main.css`、`backend/src/routes/app-home-overview.ts`、`backend/src/terminal/terminal-state-service.ts`、`packages/shared/src/terminal-protocol.ts`。
- 正则探针：当前 Codex ready pattern 对 `"› "`、`"\n› "`、`"zsh prompt\n› "` 均返回 `true`。
- 未执行浏览器验证；本轮是 code_review worker，只读复核。修复后应由验证 worker 用 `$playwright-cli` 覆盖 AGT-START-001/003/005 和 worker split 状态。

## 建议下一步

1. 先收窄 Codex ready 判定，避免 shell prompt 假 ready。
2. 把 worker pane readiness 的状态写入从 session 级剥离，避免覆盖主 Agent。
3. 将 `agent_starting` 作为同类占用态处理，并补齐测试契约。
