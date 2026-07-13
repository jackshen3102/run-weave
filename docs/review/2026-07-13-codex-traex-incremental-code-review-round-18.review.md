# Codex / TraeX capability parity 增量代码复审（Round 18）

## 结论

`case_14` **FAIL**。本轮以 index tree `3ddcd5561193f3ff3763b6c267663b587c39d91f` 为唯一审查对象，完整阅读相对 `882dfadeec1b7da9c37353f69296e76019f35ed0` 的 3 个 staged path，并独立重跑 Round 17 的真实 pane 序列及 Agent Team consumer。Round 18 已修复旧 ready 后出现明确 startup failure、新 banner 无 marker、ready 后交互提示三条时序，但上一轮 P1 仍有未闭环分支：旧 ready 画面后正常返回 shell、没有 error 文本时仍被判为 ready；Agent Team 会在建立本次启动 baseline 之前短路返回并把任务派发到 shell。

## Review checkpoint

- scope: `incremental`
- base commit / HEAD: `882dfadeec1b7da9c37353f69296e76019f35ed0`
- target tree / index: `3ddcd5561193f3ff3763b6c267663b587c39d91f`
- requestedAt: `2026-07-13T09:22:52.979Z`
- staged paths: `backend/src/agent-team/agent-readiness.ts`、`packages/shared/src/terminal-agent-readiness.ts`、`scripts/verify-agent-team-review-checkpoints.mjs`
- diff 规模: 143 insertions、10 deletions
- `git diff --cached --check`: 通过
- prompt、run package、HEAD、index tree 与 staged path 完全一致

## 已修复边界

共享 evaluator 现在从最后一次 `TRAE CLI Next` banner 切出 startup epoch，并按 epoch 内最后结束的 ready marker、interactive prompt 或 startup failure 决定状态。Agent Team 在真正发送新启动命令前保存 scrollback baseline，等待阶段只接受相对 baseline 新增的 failure。独立矩阵确认：

```json
{
  "freshReady": true,
  "staleThenFailedReady": false,
  "staleThenFailedFailure": true,
  "nextEpochReady": false,
  "nextEpochFailure": false,
  "nextFailureSince": true
}
```

因此 Round 17 的 command-not-found 覆盖、旧 epoch failure 复用、新 banner 无 marker 和更晚交互提示已按目标修复；真实 `Explain this codebase` ready 仍保持可识别。

## Remaining finding

### P1：旧 ready 后正常返回 shell仍会在本次启动前被误判为 ready

`packages/shared/src/terminal-agent-readiness.ts:109-138` 只把 ready、interactive 和 startup failure 作为决定性状态，没有识别返回 shell，也没有把 readiness 与 live pane owner 绑定。对 Round 16 真实 ready capture 仅追加普通 shell prompt，当前 target 仍返回：

```json
{
  "staleThenShellReady": true,
  "staleThenShellFailure": false
}
```

新增 baseline 无法保护这一分支，因为 `backend/src/agent-team/agent-readiness.ts:64-72` 先调用 `isAgentUiReady()`；只有该调用返回 false 后，才会在 `:90-100` 建立 baseline并发送启动命令。独立 consumer harness 以 `activeCommand=null`、shell session 和“旧 ready + 普通 shell prompt”scrollback 调用 `ensureAgentReady()`，结果只读取一次 scrollback、写入一次 `agent_idle` 后返回，启动路径完全未进入：

```text
round18 stale-shell consumer: FALSE READY (activeCommand=null, reads=1, idleTransitions=1, start path not entered)
```

编排层随后会把 worker intent 当作已 ready 的 TUI 输入，实际可能作为 shell 命令执行。这仍直接违反 AGT-TRAE-009 的 ready-before-dispatch 和 AGT-TRAE-010/011 的非 ready 不得派发边界。普通 Terminal 也复用同一 evaluator；若 pane command metadata 尚未从 `traex` 收敛为 shell，旧画面会被投影为 `agent_idle/traex`。

修复方向：初始 ready 短路必须同时证明当前 live pane owner/command 仍是目标 agent，不能只读历史 scrollback；或把可识别的 shell-return 作为比旧 ready 更新的决定性状态，并以本次 capture boundary/launch epoch约束。专项 fixture 必须增加 `TRAE ready → graceful exit → shell prompt`，并在 `activeCommand=null` 的 Agent Team consumer 层断言会进入 start path而不是直接 ready。

## 已执行检查

- Round 17 command-not-found/new-banner/interactive 序列：当前均通过。
- 独立 graceful-shell evaluator：复现 `staleThenShellReady=true`、`staleThenShellFailure=false`。
- 独立 Agent Team consumer：复现 `activeCommand=null` 时未启动 TraeX即返回 ready。
- `pnpm agent-team:verify-review-checkpoints`: 29 项通过；新增 readiness 项没有 graceful shell / consumer short-circuit 场景。
- `pnpm toolkit:verify-hooks`: 通过。
- `pnpm app-server:verify-state-sync`: 通过。
- `pnpm typecheck`: 通过。
- `pnpm lint`: 通过。
- `pnpm runweave:update:test-cases`: 18/18 通过。

静态与既有 fixture 门禁通过不能覆盖已执行复现的 consumer 时序错误。由于仍有 P1，本轮不应进入 behavior verification。

本轮只新增此 review 文档与指定 pane outbox；未修改源码、测试、Git index 或 HEAD。
