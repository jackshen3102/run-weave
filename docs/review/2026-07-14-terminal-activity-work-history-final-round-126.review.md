# Terminal Activity Work History 最终 Code Review（Round 126）

## 结论

`case_25=fail`。最终 checkpoint 仍有 1 条 P1：`terminal.agent-bootstrap-operation-lifecycle-boundary`。

prepare 在完整启动命令提交后返回 `starting`，并在 `finally` 中立即删除 panel 的 active preparation。真实 agent hook 按当前合约会在响应后异步到达；此时 hook processor 不再校验携带的 `operationId`，旧 generation 的延迟 `Stop` 会被记为当前事件，能够把仍在运行的新 worker 改为 `agent_idle`，并把 last-thread metadata 回写为旧 Thread。Agent Team 已在启动前持久化 active dispatch，因此该伪完成会进入 completion/watchdog 链，可能提前消费旧 outbox 或推进错误轮次。

## Review checkpoint

- scope：`final`
- baseCommit：`d67a1ae9836249082368c17075bcdac25f6030cb`
- targetTree：`3b6799ce917d759aa4e4d70067a0a9f80b9053fe`
- 当前 HEAD：`d83ce3955024d8f5628090191b42dd38e0204dee`
- 当前 HEAD tree：`3b6799ce917d759aa4e4d70067a0a9f80b9053fe`
- changed paths：59 个，与 reviewTarget 完全一致
- plan SHA-256：`7d0ef294770bdbe3e3081ea32ccd2edcdee0bc46dc846051a9aad2319cbb8d42`
- test case SHA-256：`c92e190387c6a929239e61f960018b429d634053934ee61d045841df2d2210de`
- `git diff --check baseCommit targetTree`：通过

## Remaining finding

### P1 `terminal.agent-bootstrap-operation-lifecycle-boundary`

`prepareTerminalAgent` 在命令发送后直接构造 `starting` 响应，并在 `finally` 结束 active preparation（`backend/src/terminal/application/agent-preparation.ts:230-288`）。`processTerminalAgentHook` 只在 `activePreparation=true` 时拒绝 operation mismatch；active preparation 已结束后，`old-operation` 不再与任何当前 generation 对比，随后仍会调用 `handleAgentHook`、`updatePanelTerminalState` 和 `syncAgentThreadMetadata`（`backend/src/terminal/agent-hook-processor.ts:118-151,235-261`）。

受控反例直接调用生产 `processTerminalAgentHook`：初始 panel 为 `agent_running/codex`、当前 `threadId=new-thread`，输入 `operationId=old-operation`、`threadId=old-thread`、`hookEvent=Stop`。结果为 `status=recorded`，session/panel 均变为 `agent_idle/codex`，`panel.lastThreadId=old-thread`、`lastThreadStatus=idle`。

现有 verifier 的盲区也已定位：`bootstrap-hooks-update-lifecycle-after-starting-response` 只证明响应后当前 operation 的 hook 可写入；stale/missing 两组用例都显式保持 active preparation 到断言结束，因此没有覆盖“prepare 已释放 operation 后旧 hook 到达”的真实窗口（`scripts/verify-agent-team-review-checkpoints/bootstrap-lifecycle.mjs:301-405,407-545`）。

修复方向：把“single-flight 锁”与“当前 pane agent generation”分开。命令提交后可以释放 single-flight，但必须保留当前 operation/generation，直到匹配 hook 建立新 Thread 或明确退出/被下一次 prepare 替换；携带非当前 operation 的 hook 必须在任何 terminal state、thread metadata 或 completion event 写入前 fail closed。补充 post-response stale `UserPromptSubmit/Stop` 回归，断言 state、current/last thread、callback/event 和 Agent Team completion 均不变。

- severity：P1
- status：open
- invariantKey：`terminal.agent-bootstrap-operation-lifecycle-boundary`
- verificationMode：`runtime`

## 验证

- 生产 hook 最小反例：复现，旧 operation 的 Stop 返回 `recorded` 并污染新 generation。
- `pnpm agent-team:verify-review-checkpoints`：通过（69 项），但缺少上述 post-response stale-operation 窗口。
- `pnpm work-history:verify`：通过（6 项）。
- `pnpm typecheck`：通过。
- `pnpm lint`：通过。
- 未执行 Playwright/behavior rerun：本轮是最终代码审查，结论来自完整 diff、现有 fixture 与独立生产方法反例。

## Findings 汇总

- remainingFindings：1 条 open P1。
- resolvedFindings：空；本轮不把同一 invariant 的 active-preparation 局部修复误记为完整 resolved。
