# Terminal Agent Bootstrap Existing-Panel Always-Respawn 独立 Re-review

## 结论

通过。当前完整 dirty C5 patch 在 existing-panel always-respawn 增量上未发现 P0/P1；`case_25=pass`，`remainingFindings=[]`。

Backend 一步 API 在请求显式携带 `panelId` 时，先取得 panel-scoped single-flight，再解析目标 panel；仅允许 running 且非 `agent_running` / `agent_starting` 的 panel，随后无条件验证 session command 是 persistent interactive shell、对原 pane 执行 respawn。respawn 成功后才固定等待 10000ms，9999ms 前不发送，在等待结束重新断言 session/panel/pane/operation/provider identity 后，只调用一次 input dispatch；该单条命令同时包含 operation env、Codex/TraeX invocation、initial prompt、operation env cleanup 与退出结果记录。

本轮只读评审。除本报告和 reviewer 自己的 pane outbox 外，未修改生产代码、verifier 或 code worker outbox；未提交 checkpoint，未执行 `behavior_verify`，未更新 Stable。

## 固定评审边界

- base / HEAD：`90c3b1102a45d0e47702461c194d58c597a2846a`
- 当前完整 source/verifier tree：`d73be7effa39f0e35457fdc1c947ed09d38b09ea`
- patch SHA-256：`6629e312dead137f318a0c53adc376b6272c8f3e59f13341f42bfa86d476f72b`
- source/verifier：28 paths，2698 additions / 922 deletions
- 计划 SHA-256：`7d0ef294770bdbe3e3081ea32ccd2edcdee0bc46dc846051a9aad2319cbb8d42`
- 测试案例 SHA-256：`c92e190387c6a929239e61f960018b429d634053934ee61d045841df2d2210de`
- code worker outbox：`.runweave/outbox/f4741241.panel-da5ecb4c-3636-4de7-bcc6-d027b6ebd62f.json`，`finishedAt=2026-07-14T09:06:42Z`

tree 通过临时 Git index 固定，包含 25 个 tracked diff 路径及 3 个本需求新增的 untracked source/verifier 文件；未把 review 文档或 outbox 纳入 target。

## 定向审查

### 1. Existing panel 一律 respawn，固定延迟位置正确

`request.panelId` 在 target resolution 前先通过 `beginPanelAgentPreparation` 获取 `(sessionId,panelId)` 的 operation ownership；获取失败稳定返回 409。目标解析后仍拒绝非 running、`agent_running` 和 `agent_starting`。对于其余 existing panel，`reusingPanel` 只由显式 `panelId` 决定，不再依据 `terminalState.agent`、provider 或 `activeCommand` 猜测能否复用。

进入发送阶段后，代码先用 `isInteractiveShellLaunch(session.command, session.args)` 验证持久交互 shell，失败时在 respawn/timer/send 前 fail closed；成功则对原 pane 执行 `respawnPane`。固定 10000ms delay 位于 respawn `await` 之后，因此 respawn 失败不会启动 timer。delay 之后的 `assertPreparationTargetCurrent` 再验证 session/panel 仍 running、pane identity 未变、operation/provider ownership 未丢失；取消或 panel/session 退出均在 send 前失败。最终仅一处 `sendInputToSession`，命令由 `buildAgentLaunchCommand` 一次构造，包含 `RUNWEAVE_TERMINAL_AGENT_OPERATION_ID` export、agent invocation、quoted initial prompt、unset 和 exit pane option。

定位：`backend/src/terminal/application/agent-preparation.ts:26,44-65,70-77,133-178,192-251,500-513`。

### 2. Running/starting 拒绝与 single-flight 未回归

状态门禁继续拒绝 `agent_running` / `agent_starting`；panel CAS 在解析 existing panel 前建立，重复并发不会越过 respawn/send。受控并发用例断言第二个请求为 409，首请求正常完成且 prompt send 总数为 1。失败路径在 catch/finally 释放 lifecycle 与 panel preparation ownership；既有 verifier 还覆盖 create/respawn failure 不启动 timer、delay 期间取消或 panel 退出零发送。

定位：`backend/src/terminal/application/agent-preparation.ts:44-65,103-130,135-178,252-264`；`scripts/verify-agent-team-review-checkpoints/bootstrap-lifecycle.mjs:650-695,781-843`。

### 3. Provider mismatch 与 CLI compatibility 没有被错误放宽

这里需区分两层合约：Backend 显式 existing-panel primitive 的本次目标就是不信任可能漂移的 provider/activeCommand metadata，并对所有通过 running/starting 门禁的 existing panel 做结构化 respawn；因此它不再以旧 provider metadata 拒绝请求是预期行为，不是 provider ownership 放宽。operation lifecycle hook 仍要求 operation 与 requested provider 一致，stale/missing/wrong-provider hook 不能完成当前 preparation。

用户可见 CLI 合约保持不变：同 provider idle 且无 overwrite 返回 `already_ready`；显式 overwrite 只发 clear 并返回 `cleared_existing`；跨 provider 且无 overwrite 仍拒绝，显式 overwrite 才先发 exit、等待 `shell_idle`，再调用 shared preparation primitive。custom agent 仍走自定义 start line；timeout `0` 继续透传。受控 verifier 对 clear、exit/start/timeout 与 custom agent 分支逐项断言。

定位：`packages/runweave-cli/src/commands/terminal-agent-preparation.ts:73-168`；`scripts/verify-agent-team-review-checkpoints/bootstrap-lifecycle.mjs:318-349,845-898`。

### 4. `shell_idle` regression fixture 与 Beta 现场一致

真实 Beta 证据 `.runweave/evidence/dvs-535346/terminal-agent-bootstrap/codex-reuse-panels-final.json` 中目标 panel 为 running、`activeCommand="export"`、`terminalState={state:"shell_idle",agent:null}`，同时保留旧 Codex thread metadata；这正是旧实现错误跳过 respawn/10000ms barrier 的决策输入。

新增 fixture 先建立真实可复用 panel，再显式写入 `activeCommand="export"` 与 `terminalState=shell_idle`，随后清空操作记录，从 API 发起 existing-panel preparation。它断言：delay 前已有且仅有一次同 pane respawn；9999ms 时 send 为 0；10000ms 后仅发送一次包含 operation env 与 prompt 的完整命令，并由 fresh thread 完成；`captureReadCount=0`。fixture 的底层 pane 初始程序与 Beta 当时 TUI 不同，但生产修复不读取底层程序/TUI/scrollback 决策，而是无条件以持久 shell respawn，因此该 fixture 忠实覆盖真实回归的 authoritative decision boundary。

定位：`scripts/verify-agent-team-review-checkpoints/bootstrap-lifecycle.mjs:86-154`。

### 5. 禁用 readiness fallback

本次启动门禁没有使用 TUI 文案、scrollback/capture、固定文案稳定、`activeCommand`、`ps` 或 `lsof` 判断 shell ready。固定 10000ms 是用户明确覆盖并要求的方案；created-panel 与 existing-panel respawn 都在对应创建/respawn 成功后进入同一 delay，失败时不启动 timer，等待期间 identity/lifecycle 失效时零发送。

## 独立验证

- `pnpm agent-team:verify-review-checkpoints`：通过，77/77。新增三项为 `bootstrap-shell-idle-existing-panel-respawns-before-delay`、`bootstrap-shell-idle-existing-panel-does-not-send-before-10000ms`、`bootstrap-shell-idle-existing-panel-sends-once-with-fresh-thread`。
- `pnpm typecheck`：通过，exit 0。
- `pnpm lint`：通过，exit 0。
- `git diff --check HEAD`：通过，exit 0。
- `behavior_verify`：按用户边界未执行。

## Findings

无 P0/P1。`remainingFindings=[]`。

## 后续建议

独立 code review 已通过。建议主 Agent 下一步按项目 Dev Session 规范执行真实运行时验收，至少覆盖：

1. Codex existing-panel：确认原 pane 无条件 respawn，10000ms 前零发送，之后单次完整发送并产生 fresh thread。
2. TraeX create：确认新 panel 创建成功后同样固定等待 10000ms、单次完整发送并完成 lifecycle。

该建议不是本轮已执行证据；本轮没有启动 Dev Session 或替代 `behavior_verify`。
