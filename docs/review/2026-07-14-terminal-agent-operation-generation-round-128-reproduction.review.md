# Terminal Agent Operation Generation Round 128 复现补充审查

## 结论

`case_25=fail`。本次已按“必须实际复现后才能报告 Bug”的标准，使用真实 `TerminalSessionManager`、真实 `prepareTerminalAgent` 失败路径、真实 `processTerminalAgentHook`、`TerminalStateService` 与持久 manager metadata 完成同一场景 Before/After。问题已从内部 generation 状态变化复现到可观察的 terminal state、thread metadata 与事件污染，因此保留 P1：`terminal.agent-bootstrap-operation-lifecycle-boundary`。

本轮只读复现，未修改被审代码、verifier 或 staged checkpoint。唯一写入是本报告和指定 pane outbox。

## 复现场景

1. 建立 running Codex panel/session，当前 thread 与 lastThread 均为 `current-thread`，terminal state 均为 `agent_running/codex`。
2. 建立并 release 已提交的 `operation-a` generation。
3. 投递 `stale-operation / stale-thread / Stop`：generation A 存在时返回 `ignored`，所有状态与 metadata 不变，事件数为 0。
4. 对同一个仍在 `agent_running` 的 panel 调用真实 `prepareTerminalAgent` 发起 retry；真实返回 `409 Terminal panel is not ready to start the requested agent`。
5. retry 失败后再次投递完全相同的 stale hook。

## 实际 Before/After

```json
{
  "beforeStatus": "ignored",
  "beforeState": {
    "generationA": true,
    "panelState": { "state": "agent_running", "agent": "codex" },
    "panelLastThreadId": "current-thread",
    "sessionState": { "state": "agent_running", "agent": "codex" },
    "sessionLastThreadId": "current-thread",
    "eventCount": 0
  },
  "retryError": {
    "name": "TerminalPanelError",
    "message": "Terminal panel is not ready to start the requested agent",
    "statusCode": 409
  },
  "afterStatus": "recorded",
  "afterState": {
    "generationPresent": false,
    "panelState": { "state": "agent_idle", "agent": "codex" },
    "panelThreadId": "current-thread",
    "panelLastThreadId": "stale-thread",
    "sessionState": { "state": "agent_idle", "agent": "codex" },
    "sessionThreadId": "current-thread",
    "sessionLastThreadId": "stale-thread",
    "eventCount": 1
  }
}
```

同一个 stale hook 在失败 retry 前被正确拒绝，失败 retry 后被记录，并造成三类可观察污染：

- 当前仍是 `current-thread`，但 panel/session `lastThreadId` 被错误改成 `stale-thread`。
- panel/session 从 `agent_running` 被错误改成 `agent_idle`。
- 产生 1 条 terminal state change event。

## 根因定位

- `backend/src/terminal/manager-base.ts:152-165`：B begin 在只检查 single-flight 后直接覆盖 retained generation A。
- `backend/src/terminal/application/agent-preparation.ts:42-63,160-174,285-298`：B 在 begin 后才检查 panel readiness；409 失败进入 `end(B)`。
- `backend/src/terminal/manager-base.ts:168-181`：`end(B)` 删除 B generation，不恢复 A。
- `backend/src/terminal/agent-hook-processor.ts:122-278`：generation 不存在后，同一个 stale hook 绕过 operation mismatch guard，进入 state 与 thread metadata 写入。

## 修复方向

新 preparation 不应在成功提交前不可逆取代当前 generation。可以在 begin/end/release 状态机中保存 previous generation，并仅在完整命令成功提交时提交 B；B 的所有提交前失败路径必须恢复 A。生产回归必须复用本次完整场景，断言 B 409 后同一个 stale hook 仍为 `ignored`，terminal state、thread metadata 与事件数均不变化。

## Checkpoint 与门禁

- base / HEAD：`d83ce3955024d8f5628090191b42dd38e0204dee`
- target / index tree：`8b4f6b4754ea6729594d8b7f256e9766d9cd8507`
- 7 个 changed paths 与 reviewTarget 完全一致；`git diff --check` 通过。
- `pnpm agent-team:verify-review-checkpoints`、backend typecheck、backend lint 均通过，但未覆盖本次 A submitted → B 409 → stale hook replay 场景。
- 上一轮 current-thread lifecycle compensation finding 已修复；本次 P1 是同一 invariant 的失败回滚缺口。
