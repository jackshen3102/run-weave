# Terminal Agent Bootstrap Operation Boundary 独立 Re-review

## 结论

`case_25=pass`。上一轮唯一 P1 `terminal.agent-bootstrap-operation-lifecycle-boundary` 已真正关闭；未发现新的 P0/P1。用户覆盖后的固定 `10000ms` 方案未回归。

本轮只评审，不改生产代码、不改 code worker outbox、不提交 checkpoint、不执行 `behavior_verify`。唯一写入是本报告和 reviewer 自己的 pane-scoped outbox。

## 当前边界

- base / HEAD：`90c3b1102a45d0e47702461c194d58c597a2846a`
- 完整 dirty source/verifier target tree：`14ac2d6825ff906ef363e21411753384cd1c506f`
- patch SHA-256：`d46844d9809e79b5149277d4d67f8329bae0b70bc03a87ab2e581d767c342607`
- 边界：28 paths，2556 additions / 922 deletions

边界由临时 index 从 HEAD 重新加入 `backend/electron/frontend/packages/plugins/scripts` 的完整 tracked + untracked 内容得到；review 文档与 `.runweave` runtime artifacts 未进入 target tree。

## `terminal.agent-bootstrap-operation-lifecycle-boundary`：resolved

active preparation 存在且 operation/provider identity 不匹配时，hook processor 在任何 `TerminalStateService` 调用及 manager metadata mutation 前直接返回 `ignored`。返回的 terminal state 只读取：

1. `panel.terminalState`
2. `session.terminalState`
3. `{ state: "shell_idle", agent: null }`

该分支不再调用会根据 scrollback inference 执行 `setAndPublish` 的 `TerminalStateService.getCurrent()`；后续 `handleAgentHook`、panel terminal state、current thread、last-thread metadata 均不可到达。

定位：`backend/src/terminal/agent-hook-processor.ts:118-149`。

独立复跑上一轮同构生产反例：使用 LowDb manager、真实 `TerminalStateStore` / `TerminalStateService`、Codex ready scrollback、`current-operation` active preparation，依次注入 stale operation `UserPromptSubmit` 和 missing operation `Stop`。结果：

```json
{
  "staleStatus": "ignored",
  "missingStatus": "ignored",
  "unchanged": true,
  "before": {
    "store": "agent_starting/codex",
    "session": "agent_starting/codex",
    "panel": "agent_starting/codex",
    "callbacks": 0,
    "events": 0
  },
  "after": {
    "store": "agent_starting/codex",
    "session": "agent_starting/codex",
    "panel": "agent_starting/codex",
    "callbacks": 0,
    "events": 0
  }
}
```

新增主 verifier 不再依赖纯 mock 结论：它使用生产 LowDb manager、真实 state store/service 和 ready scrollback，预置 session/panel current thread 与 last-thread metadata，分别注入 stale/missing operation；快照同时包含 store、session/panel terminalState、current/last thread、callback count 和 event count，两个反例前后完全相同。

定位：`scripts/verify-agent-team-review-checkpoints/bootstrap-lifecycle.mjs:384-523,1216-1227`。

verificationMode：`runtime`。

## 固定 10000ms 用户覆盖方案：未回归

- `AGENT_SHELL_STARTUP_DELAY_MS` 仍为 `10000`。
- agent created path 仍以 `skipPaneReadyWait: true` 跳过 capture-based wait；复用只在 `agent_idle` 且 provider 匹配、respawn 成功后进入 delay。
- 只有 `createdPanel || reusingAgent` 才等待，普通既有 shell panel 不误等。
- 9999ms 前零 preparation send；10000ms 后只有一个 `sendInputToSession`，完整命令同时包含 operation export、Codex/TraeX invocation、initial prompt、退出后的 unset 与 exit option。
- create/respawn failure 不启动 timer；等待期间 operation 取消或 panel/session 退出在发送前通过当前 identity/status 复核 fail closed。
- 启动发送门禁未使用 TUI、scrollback、capture、`activeCommand`、`ps` 或 `lsof` readiness 判断。

定位：`backend/src/terminal/application/agent-preparation.ts:26,78-101,157-256,332-360,505-517,603-605`；`backend/src/terminal/application/panel-split.ts:52-64,128-171`。

主 verifier 中 created/respawn 的 9999/10000、单次完整 send、capture count=0、failure no-timer/no-send、cancellation/panel-exit no-send、rollback、single-flight 与 CLI compatibility checks 全部继续通过。

稳定 resolved invariant：`terminal.agent-bootstrap-authoritative-shell-ready-barrier`（按用户明确覆盖为固定 10000ms 方案）。

verificationMode：`runtime`。

## 独立门禁

- `pnpm agent-team:verify-review-checkpoints`：exit 0，74/74 checks。
- `pnpm typecheck`：exit 0，9 个 workspace project。
- `pnpm lint`：exit 0，9 个 workspace project。
- `git diff --check HEAD`：exit 0。
- `behavior_verify`：按用户要求未执行。

## 最终 findings

- P0/P1：无。
- `remainingFindings=[]`。
- resolved：`terminal.agent-bootstrap-operation-lifecycle-boundary`。
- resolved by user override：`terminal.agent-bootstrap-authoritative-shell-ready-barrier`。
- `case_25=pass`。
