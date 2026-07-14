# Terminal Agent Operation Generation Round 128 独立代码审查

## 结论

`case_25=fail`。本轮已修复上一轮“可信 current-thread lifecycle compensation 被 generation guard 拒绝”的直接问题：可信匹配已从外部 input 移到内部 context，guard 会在 operation mismatch 时允许已由 lifecycle handler 精确验证的当前 thread/provider，生产消费者 verifier 也覆盖了错误 thread 零副作用和正确 current thread 收敛。

但同一稳定 invariant `terminal.agent-bootstrap-operation-lifecycle-boundary` 仍有 1 条 P1：新 preparation 在任何 panel readiness 校验之前就覆盖已提交 agent 的 generation；如果新 preparation 在命令提交前失败，`endPanelAgentPreparation` 会删除新 generation，却不会恢复旧 generation。此后当前 agent 仍可能运行，但 stale/missing-operation hook 的 generation 门禁已经被静默关闭，可再次污染 terminal state 与 thread metadata。

本轮只读审查；未修改生产代码、verifier 或暂存区。唯一写入是本报告和 reviewer 指定 pane outbox，未执行 `behavior_verify`。

## 固定边界

- scope：`incremental`
- base / HEAD：`d83ce3955024d8f5628090191b42dd38e0204dee`
- target / index tree：`8b4f6b4754ea6729594d8b7f256e9766d9cd8507`
- changed paths：prompt 指定的 7 个路径，实际 `git diff base target --name-only` 完全一致
- diff：187 additions / 30 deletions；`git diff --check base target` 通过
- 计划 SHA-256：`7d0ef294770bdbe3e3081ea32ccd2edcdee0bc46dc846051a9aad2319cbb8d42`
- 测试用例 SHA-256：`c92e190387c6a929239e61f960018b429d634053934ee61d045841df2d2210de`

## P1 阻断

### 提交前失败的重试会丢失当前 agent 的 operation generation

`beginPanelAgentPreparation` 只检查 single-flight map 是否已有 active preparation；上一次命令成功提交后该 single-flight 已由 `releasePanelAgentPreparation` 释放，因此第二次 preparation 可以开始。开始时它无条件用 operation B 覆盖 `panelAgentOperationGenerations` 中仍保护当前 agent A 的 generation。

但 panel 是否仍处于 `agent_running` / `agent_starting`、tmux service 是否可用等失败条件都在 `begin` 之后检查。operation B 在完整命令提交前任一失败都会进入 finally 的 `endPanelAgentPreparation(B)`；该方法删除 B generation，却没有保存或恢复被覆盖的 A generation。

真实 manager API 的最小状态转换结果：

```json
{
  "firstBegan": true,
  "beforeRetry": true,
  "retryBegan": true,
  "afterFailedRetry": false
}
```

这不是只影响内部 bookkeeping：`processTerminalAgentHook` 只有在 `hasPanelAgentOperationGeneration=true` 时才拒绝 operation mismatch。generation 丢失后，当前 agent A 仍可继续运行，而迟到的旧 operation、缺 operationId 或错误 thread hook 会重新进入 provider/command fallback，并可能调用 `handleAgentHook` 以及写入 session/panel thread metadata。直接 API 可在 running panel 上触发这一失败重试；Agent Team 与 CLI 上层检查不能替代服务端 invariant。

定位：`backend/src/terminal/manager-base.ts:152-181`；`backend/src/terminal/application/agent-preparation.ts:42-63,160-185,285-298`；受影响门禁 `backend/src/terminal/agent-hook-processor.ts:122-160`。

修复方向：开始新 preparation 时不能不可逆覆盖旧 generation。可在 begin/end/release 状态机中保留 previous generation，并仅在新命令成功提交时提交新 generation；失败、取消或前置校验拒绝时恢复原 generation。至少补一个生产 manager 回归：A 已 submitted/released → B 在 panel-not-ready 或 tmux-unavailable 前置路径失败 → A generation 仍匹配 → stale/missing hook 继续 ignored 且 metadata 零变化。

稳定 invariant：`terminal.agent-bootstrap-operation-lifecycle-boundary`。

verificationMode：`runtime`。

## 已修复回归点

- `currentThreadIdentityMatched` 不再是外部 hook input 的可伪造字段，而是 `processTerminalAgentHook` 的内部 context。
- generation guard 同时接受 current operation identity 或 lifecycle handler 已精确验证的当前 thread/provider identity。
- 错误 thread 的 lifecycle observation 不改变 metadata；正确 current thread 的 idle observation 可 recorded，并把 panel/session last-thread 与 terminal state 收敛到 idle。
- command 提交后 single-flight 会释放而 generation 保留；当前 operation hook 可 recorded，stale/missing direct hook 在 generation 尚存时保持零副作用。
- session/panel 全量清理会删除两张 operation state map；fixed 10000ms delay、respawn、panel single-flight 与 CLI compatibility 未见本增量引入的新 P0/P1。

上一轮“可信 current-thread lifecycle compensation 被 generation guard 拒绝”的具体 finding 可标记为 resolved；但同一系统 invariant 因上述失败回滚缺口仍保持 open。

## 验证

- `git rev-parse HEAD`：精确等于 base commit。
- `git write-tree`：精确等于 target tree。
- `git diff --name-status base target`：7 个路径与 reviewTarget 完全一致。
- `git diff --check base target`：exit 0。
- `pnpm agent-team:verify-review-checkpoints`：exit 0，包含 `bootstrap-trusted-current-thread-lifecycle-compensation-recorded`；未覆盖已提交 A 后失败 B 的 generation 恢复。
- `pnpm --filter @runweave/backend typecheck`：exit 0。
- `pnpm --filter @runweave/backend lint`：exit 0。
- 真实 manager generation probe：`afterFailedRetry=false`，确认失败重试后 generation 丢失。
- 计划与测试用例 `shasum -a 256`：均精确匹配 reviewTarget。
- `behavior_verify`：未执行；本轮是独立 code review gate。

## Findings

- P1 open：`terminal.agent-bootstrap-operation-lifecycle-boundary`，`verificationMode=runtime`。
- resolved：上一轮 current-thread lifecycle compensation ordering finding。
- `case_25=fail`。
