# Terminal Agent Bootstrap 固定延迟方案独立 Code Review

## 结论

`case_25` 不通过。用户已明确覆盖先前的 authoritative shell-ready 提案，当前固定 `10000ms` 方案按新合约审查，不再作为 blocker；created/respawn 的延迟位置、9999ms 前零发送、单次完整命令、失败前不启动 timer、等待期间取消/退出零发送和既有 rollback/CLI 合约均成立。

仍有 1 条真实 P1：`terminal.agent-bootstrap-operation-lifecycle-boundary`。active preparation 下 stale/missing-operation hook 虽在 manager metadata 写入前返回 `ignored`，但 fail-closed 返回体调用生产 `TerminalStateService.getCurrent()`；该方法会根据 session scrollback 的 TUI ready 文案执行 `setAndPublish`。受控生产反例中，stale hook 返回 `ignored`，TerminalStateStore 与 manager session 却从 `agent_starting/codex` 变为 `agent_idle/codex`，违反“所有 metadata mutation 前 fail closed、零副作用”以及本轮禁止 TUI/scrollback readiness 判断的约束。

本轮只评审，不改源码、不提交 checkpoint、不执行 `behavior_verify`。唯一写入是本报告和 reviewer 自己的 pane-scoped outbox；code worker outbox 未修改。

## 固定边界

- base / HEAD：`90c3b1102a45d0e47702461c194d58c597a2846a`
- 当前完整 dirty source/verifier target tree：`fc483b1eaea554975650523460a6708cd4383fed`
- patch SHA-256：`3cd93e1c9018fae825e73b3c48a77909fa4d8e928ddf825ae18966ac687e0d10`
- 边界：28 paths，2397 additions / 922 deletions
- 计划：`docs/plans/2026-07-13-terminal-activity-work-history.md`，SHA-256 `7d0ef294770bdbe3e3081ea32ccd2edcdee0bc46dc846051a9aad2319cbb8d42`
- 测试案例：`docs/testing/terminal/terminal-activity-work-history-test-cases.md`，SHA-256 `c92e190387c6a929239e61f960018b429d634053934ee61d045841df2d2210de`

target tree 使用临时 index 从 HEAD 重新加入 `backend/electron/frontend/packages/plugins/scripts` 的完整 tracked + untracked 当前内容；既有 review 文档和 `.runweave` runtime artifacts 不进入边界。

## P1 阻断

### stale/missing operation 的 ignored 分支仍可通过 `getCurrent` 修改 session terminal state

hook processor 已在 `handleAgentHook`、panel terminal state 和 thread/last-thread 写入之前检查 active preparation identity；stale 或缺 operation 会进入 `ignored`。问题是该 early return 为构造响应调用了 `terminalStateService.getCurrent(session.id, session)`。

生产 `getCurrent` 不是只读 getter：当 snapshot 为 `agent_starting` 且 scrollback 命中 Codex/TraeX ready pattern 时，它调用 `setAndPublish(agent_idle)`。正式 runtime 的 `onStateChange` 又异步调用 `terminalSessionManager.updateSessionTerminalState`，因此 ignored hook 仍可修改 service store 和持久 session terminal state。

独立受控反例：

1. 使用生产 LowDb manager 建立 running session/panel，二者状态均为 `agent_starting/codex`，session active command 为 Codex，scrollback 放入 `OpenAI Codex`。
2. 注册 `current-operation/codex` active preparation。
3. 使用生产 `TerminalStateService` 调用生产 `processTerminalAgentHook`，输入同 panel/provider、`stale-operation`、`UserPromptSubmit`。
4. 返回 `resultStatus=ignored`，但 store 和 manager session 均从 `agent_starting/codex` 变为 `agent_idle/codex`，并产生一次 state-change callback；panel 保持 starting。

可复现结果：

```json
{
  "resultStatus": "ignored",
  "before": {
    "store": "agent_starting",
    "session": "agent_starting",
    "panel": "agent_starting"
  },
  "after": {
    "store": "agent_idle",
    "session": "agent_idle",
    "panel": "agent_starting"
  },
  "stateChangeCount": 1
}
```

现有 72 项 verifier 未捕获该反例，因为 bootstrap harness 的 `terminalStateService.getCurrent()` 是直接返回 panel state 的纯 mock，不会读取 scrollback、更新 store 或触发 manager callback。因此 `bootstrap-stale-and-missing-operation-hooks-have-zero-side-effects` 只证明 mock 路径前后 JSON 相同，不能证明生产路径零副作用。

定位：`backend/src/terminal/agent-hook-processor.ts:118-149`；`backend/src/terminal/terminal-state-service.ts:147-183,189-213,298-304`；正式 on-change wiring 位于 `backend/src/bootstrap/runtime-services.ts:273-286`；verifier mock 位于 `scripts/verify-agent-team-review-checkpoints/bootstrap-lifecycle.mjs:817-825`。

修复方向：active preparation identity 不匹配时，early return 必须只读取无副作用的已有 snapshot，不能调用会推断/持久化状态的方法；或把 operation guard 提升到任何可能触发 mutation/publish 的调用之前。受控 verifier 应改用生产 `TerminalStateService` + ready scrollback，并同时断言 hook status、TerminalStateStore、session/panel terminal state、current/last thread metadata、state-change callback/event 均完全不变；stale 与 missing operation 都要覆盖。

稳定 invariant：`terminal.agent-bootstrap-operation-lifecycle-boundary`。

verificationMode：`runtime`。

## 用户覆盖后的固定 10000ms 方案

`terminal.agent-bootstrap-authoritative-shell-ready-barrier` 按用户最新决策视为 resolved，不再要求 shell-ready token、generation 或握手：

- 新建 agent panel 调用 split 时显式 `skipPaneReadyWait: true`，不会走 `waitForPaneReady/capturePane`；复用仅在 `agent_idle` 且 provider 匹配时 respawn。
- 只有 `createdPanel || reusingAgent` 才执行 `delay(10000)`；普通既有 shell panel 不误等。
- create 完整成功或 respawn 完整成功后才进入 delay；split registration 或 respawn 抛错时不会创建 10000ms timer。
- delay 后重新核对 session/panel running、session/panel/pane identity 与当前 operation/provider CAS；等待期间 operation 取消或 panel/session 退出会在发送前 fail closed。
- 一个 `sendInputToSession` 调用发送一个由 `buildAgentLaunchCommand` 生成的完整 shell line，同时包含 operation export、Codex/TraeX invocation、initial prompt、退出后的 unset 与 exit option；没有分离 export/CLI 的第二次 send。
- readiness 发送门禁不读取 TUI、scrollback、capture、`activeCommand`、`ps` 或 `lsof`。`panel-split` 的 capture-based 默认行为仍服务普通 split，但 agent create 明确跳过。
- lifecycle deadline 在完整命令发送后计算，因此 10000ms startup delay 不吞掉调用方配置的 lifecycle timeout；timeout `0` 兼容入口仍保留。

定位：`backend/src/terminal/application/agent-preparation.ts:26,78-101,157-256,271-286,332-360,505-517,603-605`；`backend/src/terminal/application/panel-split.ts:52-64,128-171`。

72 项 verifier 对 created/respawn 分别断言 9999ms send count 为 0、10000ms 后恰好一个完整 send、capture count 为 0；另覆盖 create/respawn failure 无 timer/无 send、operation cancellation/panel exit 无 send、single-flight 只有一个 prompt。这里没有 P0/P1 缺陷。

非阻断覆盖缺口：当前 verifier 对 panel exit 有直接 case，但 session exit 仅由生产 `assertPreparationTargetCurrent` 静态覆盖；也未断言取消后 timer 被提前清理或 promise 提前结束。当前实现的单个 timer 最迟 10000ms 自然完成，不构成永久泄漏，且最新验收只要求零发送，因此记为 P2 测试完备性建议，不进入 `remainingFindings`。

## 其他回归复核

- created-panel atomicity：split 后注册/workspace/metadata/focus/event 失败仍执行 kill/unwatch/panel/workspace rollback；清理不完整继续返回 partial panel/pane identity。registration failure verifier 前后 live pane/panel 数一致，且 timer/send 均为 0。
- respawn shell contract：Node、direct agent 与 `-c/-lc` 非持久命令在 respawn 前 fail closed；respawn failure 不进入 delay。
- panel single-flight：显式 panel 在 resolve 前取得 `(session,panel)` CAS；第二请求 409，成功/失败路径按相同 operation finally 释放。
- CLI compatibility：保留 `not_requested/already_ready/cleared_existing/started/restarted`、`clear/exit_existing/start`、custom agent/command 和 timeout `0`；标准 Codex/TraeX 走共享 prepare API。
- operation env 不写入 session/panel metadata；只存在于单次 shell line，并在 agent 退出后 unset。

## 独立门禁

- `pnpm agent-team:verify-review-checkpoints`：exit 0，72/72 checks；但 stale-hook 零副作用 case 存在上述 production-vs-mock 盲区。
- `pnpm typecheck`：exit 0，9 个 workspace project。
- `pnpm lint`：exit 0，9 个 workspace project。
- `git diff --check HEAD`：exit 0。
- `behavior_verify`：按用户要求未执行。

## 最终 findings

- P1 open：`terminal.agent-bootstrap-operation-lifecycle-boundary`，verificationMode=`runtime`。
- P2 informational：`terminal.agent-bootstrap-fixed-delay-cancellation-coverage`，verificationMode=`controlled`；不进入 `remainingFindings`。
- resolved by user override：`terminal.agent-bootstrap-authoritative-shell-ready-barrier`，固定 10000ms 方案已按新合约通过代码与受控 verifier 复核。
- `case_25=fail`。
