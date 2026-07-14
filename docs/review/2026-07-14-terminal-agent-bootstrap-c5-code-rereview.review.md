# Terminal Agent Bootstrap C5 独立 Re-review

## 结论

`case_25` 不通过。上轮 5 个 P1 中 4 个已解决，但 `terminal.agent-bootstrap-operation-lifecycle-boundary` 仍未关闭；本轮另确认 `terminal.agent-bootstrap-authoritative-shell-ready-barrier`。当前共有 2 条阻断 P1：其一，stale/missing-operation hook 在 active preparation 期间仍可持久污染 terminal state 与 thread metadata；其二，新建和 respawn 后都没有在发送任何 export/CLI 前建立 pane-scoped authoritative shell-ready 边界。新建路径把 `capture-pane` 文本稳定当 ready，且超时仅告警后继续；respawn 路径则在 `respawn-pane` 返回后立即发送命令。

本轮只评审，不改源码、不提交、不执行 `behavior_verify`。唯一写入是本报告和 reviewer 自己的 pane outbox。

## 固定边界

- base / HEAD：`90c3b1102a45d0e47702461c194d58c597a2846a`
- 当前完整 C5 source/verifier target tree：`2fc138162990d9abc146eaac593b7e4798aa08af`
- patch SHA-256：`c91b8001bf66e668616e77eb2936893b0b08b4f7262724bc4cea62881136f4a9`
- 边界：28 files，2078 additions / 922 deletions
- 计划 SHA-256：`7d0ef294770bdbe3e3081ea32ccd2edcdee0bc46dc846051a9aad2319cbb8d42`
- 测试案例 SHA-256：`c92e190387c6a929239e61f960018b429d634053934ee61d045841df2d2210de`
- `git diff --check HEAD`：通过

28 个路径包含所有相对 C4 的 tracked source/verifier diff，以及 3 个本需求新增文件：`backend/src/terminal/application/agent-preparation.ts`、`packages/shared/src/terminal/agent-preparation.ts`、`scripts/verify-agent-team-review-checkpoints/bootstrap-lifecycle.mjs`。既有和本轮 review 文档不进入 target tree。

## P1 阻断

### stale operation hook 仍可修改当前 preparation 的 metadata

manager 的 `(terminalSessionId, panelId)` CAS 本身成立：`beginPanelAgentPreparation` 保存 operation/provider，重复 begin 返回 false，`endPanelAgentPreparation` 只释放同 operation。observer 也严格要求 `context.operationId === current operationId`，所以旧 hook 不会直接完成新 prepare。

缺口在 hook processor。`currentThreadIdentityMatched` 把“manager 中 operation 精确匹配”和既有 thread identity 匹配合并为一个布尔值，但 operation 不匹配时没有 fail closed；只要同 panel/provider 的现有 agent/command 归属检查通过，函数仍继续调用 `handleAgentHook`、`updatePanelTerminalState` 和 `syncAgentThreadMetadata`。manager update 方法先持久写入 panel，再把传入的 stale operationId 作为 mutation context 通知 observer；observer 忽略通知并不能撤销已发生的 metadata 写入。

独立受控反例：

1. 对 `session + panel-1` 注册 `current-operation / codex` CAS，并把 panel 置为 `agent_starting/codex`。
2. 调用生产 `processTerminalAgentHook`，同 panel/provider/thread，但传入 `operationId=stale-operation` 与 `UserPromptSubmit`。
3. manager 明确返回 `staleMatches=false`、`currentMatches=true`；hook 结果却是 `recorded`。
4. panel 被改成 `agent_running/codex`，且 `threadId=lastThreadId=ancient-thread`、`lastThreadStatus=running`。

这会让延迟旧 hook 在新 prepare 期间覆盖 current/last thread 与 terminal state；若本次真实 lifecycle 未到达，请求虽会 timeout，但污染后的 metadata 会保留并影响 UI、后续归属和恢复判断。

定位：`backend/src/terminal/agent-hook-processor.ts:118-129,131-239`；持久写入及随后通知位于 `backend/src/terminal/manager-panel-operations.ts:92-127,156-202,205-228`；CAS 位于 `backend/src/terminal/manager-base.ts:148-191`。

修复方向：manager 需要能区分“panel 当前没有 preparation”和“存在 preparation 但 operation/provider 不匹配”。存在 active preparation 时，panel lifecycle hook 只有精确匹配 operation/provider 才能修改 terminal state/thread metadata；stale 或缺 operation 的 hook 必须 ignored/fail closed。无 active preparation 时继续保留正常 hook 路径。受控 verifier 必须断言 stale hook 为 ignored 且 mutation 前后 metadata 完全相同，不能只断言 prepare 最终 timeout。

稳定 invariant：`terminal.agent-bootstrap-operation-lifecycle-boundary`。

verificationMode：`runtime`（生产 hook processor + LowDb manager 受控调用）。

### 新建与 respawn 都缺少 authoritative shell-ready barrier

一步 primitive 的前置条件应是“目标 pane 的当前 shell generation 已权威确认可以接收命令”，而不是“tmux 已创建/respawn pane”或“屏幕文本暂时不再变化”。当前两条路径均不满足：

- 新建路径在 `splitPane` 和 provisional panel/workspace 注册后调用 `waitForPaneReady`，随后才返回给 `prepareTerminalAgent` 发送 export 与 CLI；但该方法实际反复执行 `capture-pane -p -J -S -80`，要求非空捕获文本连续相同 200ms 且总等待至少 1s。任意启动横幅、旧 scrollback 或尚未接受输入的稳定文本都可满足条件，这不是 shell-ready 的权威状态或握手。
- `waitForPaneReady` 以 100ms 固定延时轮询，2.5s 到期后只记录 warning 并正常返回。调用方因而会在“从未证明 ready”的 timeout 路径继续发送 export/CLI，不是 fail closed。
- 复用路径先调用 `respawnPane`；该方法只等待 `tmux respawn-pane -k` 命令完成。紧接着的下一条操作就是 `sendPreparationEnvironment`，随后是 launch input，中间完全没有 ready barrier。tmux 接受 respawn 不等价于新 shell generation 已完成初始化并开始读取输入。

独立静态反例的生产调用序列：

1. created panel：`splitPane → setPanePanelId/upsert → waitForPaneReady(capture text stability; timeout returns) → prepare returns → export → CLI`。
2. reused panel：`set pending option → respawnPane → export → CLI`。
3. 两条序列在 export 前都没有 pane/generation-scoped ready state 或 nonce handshake；created timeout 也不会阻止后两条 send。

这会让 export 或 CLI 在 shell 初始化、rc 文件执行或 line editor 尚未接管输入时被丢失、回显或拼接；失败最终可能伪装成 lifecycle timeout，但命令已经越过了 primitive 的安全边界。旧 scrollback/上一代 pane 输出还可能使新建路径误判 ready。

定位：`backend/src/terminal/application/panel-split.ts:127-165`；`backend/src/terminal/tmux-pane-service.ts:146-171,409-443,517-551`；`backend/src/terminal/tmux-internals.ts:16-18`；`backend/src/terminal/application/agent-preparation.ts:208-266,342-356,502-524`。

修复方向：为 pane 当前 generation 建立 authoritative shell-ready 状态或显式 nonce handshake，并在 created 与 respawn 两条路径复用同一个 fail-closed barrier。barrier 必须绑定准确 session/panel/pane/generation，拒绝上一代或错误 pane 的信号；在 ready 前不得发送 export、unset、CLI 或其他 preparation input；timeout/error 必须在零 preparation send 的状态下终止并走既有锁释放/created-panel rollback 或 partial-identity 收敛。禁止以 capture/TUI 文案、固定 sleep、`activeCommand`、`ps` 或 `lsof` 替代。受控 verifier 至少要断言两条路径均为 ready 后才 send、ready timeout 时 send count=0、stale/wrong-pane/wrong-generation ready 不可解锁。

现有 verifier 反而把复用路径的期望顺序固定为 `respawn → export → CLI`，没有 ready 事件；created-panel 用例只注入 registration failure。它未覆盖 ready 前零命令、timeout fail-closed 或 generation 隔离。

稳定 invariant：`terminal.agent-bootstrap-authoritative-shell-ready-barrier`。

verificationMode：`runtime`（需要受控 pane/generation handshake、ordering 与 timeout 反例；当前结论由生产调用链静态复核确定为 open）。

## 其余 4 个 invariantKey

### `terminal.agent-bootstrap-created-panel-atomicity`：通过

- `splitPane` 后的 set-option、注册、workspace、ready/metadata/focus/event 阶段统一进入 rollback。
- rollback 优先 kill 新 pane、停止 watcher、收敛 panel/workspace；无法完整清理时通过 `partialPanel` 返回 panel/pane identity，API 不再否认仍存在的资源。
- 主 verifier 真实创建 tmux pane，并注入 `setPanePanelId` 失败；前后 live pane 数和 workspace panel 数一致。

定位：`backend/src/terminal/application/panel-split.ts:121-233`、`backend/src/terminal/application/agent-preparation.ts:65-128,606-622`。

### `cli.terminal-agent-preparation-compatibility`：通过

- 保留 `not_requested/already_ready/cleared_existing/started/restarted` 与 `clear/exit_existing/start`。
- 同 provider overwrite 执行 clear；跨 provider overwrite 执行 exit、等待 shell，再走共享 prepare；custom agent/command 继续发送。
- CLI 与 Backend schema 都接受 timeout `0`；Codex/TraeX 标准 provider 使用共享一步 API。
- 受控 verifier 覆盖 clear overwrite、custom exit+start、custom agent command 和 timeout `0` 下传。

定位：`packages/runweave-cli/src/commands/terminal-agent-preparation.ts:32-317`、`backend/src/routes/terminal-panel-routes.ts:80-140`。

### `terminal.agent-bootstrap-respawn-shell-contract`：通过

- 只有仓库既有 `isInteractiveShellLaunch` 接受的持久 shell 才进入同 pane respawn。
- Node、direct agent 和带 `-c/-lc` 的非持久命令在 respawn 前 fail closed。
- verifier 使用真实 tmux pane + Node session command，确认 `cli_launch` 且 respawn 次数为 0。

定位：`backend/src/terminal/application/agent-preparation.ts:208-229`、`backend/src/terminal/tmux-output-watcher-helpers.ts:29-38`。

### `terminal.agent-bootstrap-panel-single-flight`：通过

- 显式 panel 在 resolve/reconciliation 前抢占 CAS；第二请求稳定 409。
- 成功、launch 失败、exit、timeout 等所有已取得锁的路径最终都以同 operation 释放；错误释放不会删除别人的锁。
- verifier 证明第二请求 409 且只有一条 bootstrap prompt；`dvs-075f45` 汇总记录真实 API 并发为 200 + 409。

定位：`backend/src/terminal/application/agent-preparation.ts:39-68,101-154,155-338`、`backend/src/terminal/manager-base.ts:148-191`。

## export/unset 与 readiness 审计

- operation ID 只通过 shell-local `export RUNWEAVE_TERMINAL_AGENT_OPERATION_ID=...` 传给 agent/hook；session/panel 持久 record 未新增该字段。
- launch wrapper 在 agent 进程退出后执行 `unset RUNWEAVE_TERMINAL_AGENT_OPERATION_ID`，再写 pane-local exit code option。respawn 会先重建 shell环境，避免继承上一代 shell-local operation。
- agent lifecycle 完成判定只来自 pane-scoped hook lifecycle；`agent-readiness.ts` 与 `agent-preparation.ts` 本身没有用 `activeCommand`、`ps` 或 `lsof` 推断 agent ready。
- 但发送命令前的 shell-ready 前置门禁不成立：新建路径间接依赖 `createTerminalPanelSplit → waitForPaneReady → capturePane` 的 scrollback/TUI 文本稳定和固定时间轮询，且 timeout 后继续；respawn 路径没有门禁。因此不能确认“没有 readiness fallback”，而应按本报告新增 P1 阻断。
- `processTerminalAgentHook` 保留的 active-command 逻辑是普通 hook 归属兼容路径，不是 prepare 完成判定；本报告的 P1 正是它在 active preparation 存在时没有让 operation ownership 优先 fail closed。

## 受控 verifier 与静态门禁

- `pnpm agent-team:verify-review-checkpoints`：通过，65 个 check 全部通过；其中 19 个 bootstrap/CLI check 覆盖短 turn、listener cleanup、旧/错 provider/错 panel、exit/timeout、single-flight、非 shell 与 split rollback。
- verifier 盲区一：`bootstrap-different-old-thread-operation-is-rejected` 只断言 prepare 以 timeout 结束；它没有断言 stale hook 的返回状态及 metadata 不变，因此与本轮受控反例不矛盾。
- verifier 盲区二：`bootstrap-reused-panel-respawns-agent` 只断言 `respawn → export → CLI`，没有 shell-ready event；`bootstrap-created-panel-registration-failure-is-atomic` 只在 ready 前注入 registration failure。没有 created/respawn ready ordering、timeout send-count=0 或 generation 隔离检查。
- `pnpm typecheck`：通过，9 个 workspace project。
- `pnpm lint`：通过，9 个 workspace project。
- `git diff --check HEAD`：通过。

明确未运行 `behavior_verify`。上述 verifier 是受控生产模块调用，不替代后续 behavior worker。

## `dvs-075f45` Before/After 证据审计

`results.json` 的内部字段自洽：baseline 是 C4；Before 为 504 / lifecycle_timeout；After 记录 Codex 首次 200、同 panel 并发 200+409 且 threadId 更新、TraeX 新 panel 201/createdPanel=true，最终两端均 `agent_idle/lastThreadStatus=idle`。`desktop-final.png` 可见同一 Beta build 中 Codex 与 TraeX 两个 pane 均可交互，并显示 C4 revision。

但该目录只有派生 `results.json` 与最终截图，没有原始 HTTP 请求/响应、Dev Session status/open/stop manifest、hook timeline 或采集命令。因此它能作为真实 happy-path 辅助证据，不能独立证明 200+409 的采集链，也不能反驳本轮 stale-operation 受控反例。此证据可审计性缺口记为 P2，不单独阻断 `case_25`；本轮阻断来自生产代码和可复现调用。

稳定 P2：`terminal.agent-bootstrap-dvs-evidence-provenance`，verificationMode=`artifact`。

## 计划与测试案例追溯

计划和测试案例 SHA 与上轮一致。原始 `AGT-WH-001` 至 `AGT-WH-024` 文档主要覆盖 Work History；本次 bootstrap C5 是 `case_25` 的 review-repair 扩展，5 个 invariant 的直接契约来自上轮报告、code worker outbox 和本轮受控 verifier。未把原 Work History behavior 结果或静态截图冒充本轮 bootstrap code-review 结论。

## 最终 findings

- P1 open：`terminal.agent-bootstrap-operation-lifecycle-boundary`，verificationMode=`runtime`。
- P1 open：`terminal.agent-bootstrap-authoritative-shell-ready-barrier`，verificationMode=`runtime`。
- P2 informational：`terminal.agent-bootstrap-dvs-evidence-provenance`，verificationMode=`artifact`。
- 其余 4 个上轮 P1：resolved。
- `case_25=fail`；未执行 `behavior_verify`。
