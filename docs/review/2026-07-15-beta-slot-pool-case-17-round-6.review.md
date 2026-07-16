# Beta slot pool case_17 round 6 增量代码审查

## 结论

`case_17` 通过。对 `955413e623c3e5ce6237a81e2c22e205dc5a7bed` 到 staged tree `04f6869a9b8cd853d87f1aaf5207e0e3cbd44e5c` 的 12 个指定路径完成独立增量审查，未发现开放 P0/P1。固定 worker pane 的续接链路会优先复用 idle agent，已退出但保留可信 thread identity 时在同 pane 执行 provider `resume`；既有上下文不可复用时 fail closed，不会 respawn、替换 pane 或新开 thread。

保留 1 个非阻断 P2：公开 terminal preparation API 允许同时传 `resumeThreadId` 与 `commandLine`，而命令构造在 `commandLine` 分支会静默忽略 resume 参数。当前 Agent Team 的 `submitAgentResume` 不传 `commandLine`，因此不影响本轮固定 worker thread 主链。

审查身份：

- DispatchId：`7fbf015d-e62e-4b36-ba4e-c04eac2a3cae`
- scope：`incremental`
- baseCommit / HEAD：`955413e623c3e5ce6237a81e2c22e205dc5a7bed`
- targetTree / staged tree：`04f6869a9b8cd853d87f1aaf5207e0e3cbd44e5c`
- changedPaths：prompt 指定的 12 个 staged path，逐项匹配
- plan SHA-256：`f727eb15e6fb82448b1c2a70dc5bd3b1616fed77bbf411d4d4a9846bdeae8c5c`
- test case SHA-256：`bafcfd0741f3825a6756a20ac76f5465bd2583e5f4b5f56477deb0fee30b0fbc`

## 增量链路核对

- `submitWorkerDispatchPrompt()` 集中处理 serial dispatch、bounce、repair protocol correction 与 recheck：同 provider `agent_idle` 直接向现有 pane 投递；`shell_idle + lastThreadStatus=idle` 时通过 `submitAgentResume()` 续接；发现历史 dispatch/thread/provider 上下文但无法续接时返回 409。
- `prepareTerminalAgent()` 在 resume 分支不 respawn、不等待新的 shell 启动延时，并把 `resume <threadId>` 插入 provider CLI 参数；仍保留 operation generation、pane identity 与 single-flight 检查。
- review-checkpoint harness 覆盖 fixed pane、idle thread 复用、stopped thread resume、unavailable thread fail closed，以及 repair bounce 复用同一 worker thread。
- 超时 recheck 的投递失败会保持 pending attempt 并由既有 watchdog 在最大 attempt 后升级人工；没有通过创建 replacement pane 绕过固定 worker 上下文。

## 独立 executable harness

- `agent-resume-command-codex`：真实调用 `prepareTerminalAgent()`，输出命令包含 `codex '-c' 'check_for_update_on_startup=false' 'resume' 'thread-review-6' 'round 6 review'`，`respawnedPanes=[]`，且只向原 `%0` 发送一次。
- `agent-resume-command-traex`：真实调用 `prepareTerminalAgent()`，输出命令包含 `traex '--flag' 'resume' 'thread-traex-6' 'round 6 review'`，`respawnedPanes=[]`，且只向原 `%0` 发送一次。

## 已解决 finding 回归点

本增量没有修改上一 checkpoint 中五条已解决 Beta P1 的实现路径；`git diff --cached --name-only` 只包含本 prompt 的 12 个 Agent Team/terminal preparation 路径。重新执行 `pnpm dev:session:verify` 与 `pnpm runweave:beta:verify` 均通过，其中覆盖 stale/orphan identity-gated recovery、single-owner janitor recovery、failed-manifest released-lease lifecycle、disk-budget fail-closed 与 legacy quarantine 合同。因此以下 invariant 保持 resolved：

- `beta-slot.lease-release-requires-quiescence`
- `beta-legacy.cleanup-requires-all-components-inactive`
- `beta-slot.failed-manifest-lease-state`
- `beta-slot.janitor-single-owner-recovery`
- `beta-slot.disk-budget-additive-estimate`

## 验证记录

- `pnpm agent-team:verify-review-checkpoints`：通过，输出 `ok=true`。
- `pnpm typecheck`：通过。
- `pnpm lint`：通过。
- `pnpm dev:session:verify`：通过，输出 `ok=true`。
- `pnpm runweave:beta:verify`：通过，输出 `ok=true`。
- `git diff --cached --check`：通过，无输出。
- `git rev-parse HEAD` 与 `git write-tree`：分别精确等于本轮 baseCommit 与 targetTree。

本轮是 review-only 增量代码审查，没有修改业务代码，也未执行 Playwright/桌面验收；结论不替代 BSP-001 至 BSP-016 的真实产品行为验收。
