# Beta slot pool case_17 round 6 增量重审

## 结论

`case_17` 通过。对 `955413e623c3e5ce6237a81e2c22e205dc5a7bed` 到 staged tree `9eaf8e56281477082c5c71d8259ebc88539d964b` 的 12 个指定路径完成 fresh 独立增量审查，未发现开放 P0/P1。

固定 worker pane 的续接链路会优先复用 idle agent；进程已退出但保留可信 thread identity 时，在同 pane 执行 provider `resume`；既有上下文不可复用时 fail closed，不会 respawn、替换 pane 或新开 thread。本 target 相对上一 staged tree 新增的 `activeCommand` 持久化也已通过实际 preparation harness：Codex 恢复为 `codex`，TraeX 恢复为 `traex`。

仍保留 1 个非阻断 P2：公开 terminal preparation API 同时接收 `resumeThreadId` 与 `commandLine` 时，命令构造会静默忽略 resume 参数。当前 Agent Team 的 `submitAgentResume` 不传 `commandLine`，所以不影响本轮固定 worker thread 主链。

审查身份：

- DispatchId：`a94c84ea-69bf-4614-ba9c-fa443ac0bc32`
- scope：`incremental`
- baseCommit / HEAD：`955413e623c3e5ce6237a81e2c22e205dc5a7bed`
- targetTree / staged tree：`9eaf8e56281477082c5c71d8259ebc88539d964b`
- changedPaths：prompt 指定的 12 个 staged path，逐项匹配
- plan SHA-256：`f727eb15e6fb82448b1c2a70dc5bd3b1616fed77bbf411d4d4a9846bdeae8c5c`
- test case SHA-256：`bafcfd0741f3825a6756a20ac76f5465bd2583e5f4b5f56477deb0fee30b0fbc`

## 调用链与失败分支

- `submitWorkerDispatchPrompt()` 统一承接 serial dispatch、bounce、repair protocol correction 与 recheck：同 provider `agent_idle` 直接投递，`shell_idle + lastThreadStatus=idle` 时续接，发现历史 dispatch/thread/provider 上下文但无法续接时返回 409。
- `prepareTerminalAgent()` 的 resume 分支不 respawn、不等待新 shell 启动延时，把 `resume <threadId>` 插入 provider CLI，并在命令提交后将 panel `activeCommand` 持久化为请求 command/provider。
- operation generation、pane identity 与 single-flight 检查仍保留；命令提交失败不进入 activeCommand/starting-state 持久化。
- timeout recheck 不再创建 replacement pane；投递失败由现有 attempt/watchdog 链路最终升级人工，不以新 thread 绕过上下文。

## Fresh executable harness

- `agent-resume-active-command-codex-a94c`：命令包含 `codex ... resume thread-codex-a94c`，`activeCommand=codex`、`respawnedPanes=[]`、原 `%0` 单次发送。
- `agent-resume-active-command-traex-a94c`：命令包含 `traex --flag resume thread-traex-a94c`，`activeCommand=traex`、`respawnedPanes=[]`、原 `%0` 单次发送。
- `agent-resume-commandline-override-a94c`：请求同时传 `resumeThreadId=thread-ignored-a94c` 与 `commandLine=codex --custom-flag`；实际命令为 `codex --custom-flag 'round 6 a94c'`，缺少 `resume` 与 thread id，确认 P2 仍存在。

## Resolved findings 回归

本增量未修改上一 checkpoint 中五条已解决 Beta P1 的实现路径。fresh 执行 `pnpm dev:session:verify` 与 `pnpm runweave:beta:verify` 均通过，其中覆盖 stale/orphan identity-gated recovery、single-owner janitor recovery、failed-manifest released-lease lifecycle、disk-budget fail-closed 与 legacy quarantine 合同。以下 invariant 保持 resolved：

- `beta-slot.lease-release-requires-quiescence`
- `beta-legacy.cleanup-requires-all-components-inactive`
- `beta-slot.failed-manifest-lease-state`
- `beta-slot.janitor-single-owner-recovery`
- `beta-slot.disk-budget-additive-estimate`

## 验证记录

- `pnpm agent-team:verify-review-checkpoints`：通过，`ok=true`。
- `pnpm typecheck`：通过。
- `pnpm lint`：通过。
- `pnpm dev:session:verify`：通过，`ok=true`。
- `pnpm runweave:beta:verify`：通过，`ok=true`。
- `git diff --cached --check`：通过，无输出。
- 写报告前 `git rev-parse HEAD` 与 `git write-tree` 分别精确等于本轮 baseCommit 与 targetTree。

本轮是 review-only 增量代码审查，没有修改业务代码，也未执行 Playwright/桌面验收；结论不替代 BSP-001 至 BSP-016 的真实产品行为验收。
