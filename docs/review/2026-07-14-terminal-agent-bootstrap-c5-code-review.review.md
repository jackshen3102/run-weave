# Terminal Agent Bootstrap C5 独立 Code Review

## 结论

`case_25` 不通过，当前 C4 到完整 dirty patch 仍有 5 条阻断 P1：bootstrap lifecycle 没有绑定本次 operation/generation；新 panel 在 tmux split 后、注册前失败会遗留未声明 pane；CLI 的 `--agent-overwrite`、clear/exit/custom agent 与 timeout `0` 兼容性回归；复用路径把任意 session command 当成可交互 shell；同一 panel 缺少 single-flight，两个准备调用可并发 respawn/注入并共享同一 lifecycle。

本审查只读。未修改、stage 或 commit 源码，未执行 `behavior_verify`，也未触发 behavior worker。除本报告与 reviewer pane outbox 外未写入工作区。

## 固定边界

- base / HEAD：`90c3b1102a45d0e47702461c194d58c597a2846a`
- C5 working-tree tree：`a17b5659ec3a933fad72c60c12fd71512074a501`
- patch SHA-256：`70299311b482e1289359e4af68889b9e6337fc24915e564da436d3123866ef08`
- 实现与 verifier 边界：19 files，1299 additions / 911 deletions
- `git diff --check 90c3b1102...`：通过
- 计划 SHA-256：`7d0ef294770bdbe3e3081ea32ccd2edcdee0bc46dc846051a9aad2319cbb8d42`
- 测试案例 SHA-256：`c92e190387c6a929239e61f960018b429d634053934ee61d045841df2d2210de`

固定的 19 个实现/verifier 路径为 code outbox 声明的 16 个 tracked 路径，加 `backend/src/terminal/application/agent-preparation.ts`、`packages/shared/src/terminal/agent-preparation.ts`、`scripts/verify-agent-team-review-checkpoints/bootstrap-lifecycle.mjs`。既有未跟踪 review 文档不属于本次 target tree。

## P1 阻断

### 1. lifecycle 可接受早于本次 operation 的旧 thread

`observePreparationLifecycle` 只要求 `threadId !== previousThreadId`，并检查同 panel/provider、`running → idle`、最终 active thread/provider 清空；`startedAtMs` 只用于 timeout deadline，未参与 lifecycle 新鲜度判定，也没有 operation/generation token。

受控生产调用中，panel 的 `previousThreadId=latest-thread`，在本次 prepare 开始后投递另一个 `ancient-thread` 的 delayed `running → idle`，但其 `lastThreadUpdatedAt` 比 operation 早 60 秒，当前实现仍返回成功。因此“不是上一个 thread”不等于“属于本次启动”；更早 thread 的延迟事件可以误完成新 operation。

修复建议：把本次启动的 generation/operation identity 写入 pane-scoped lifecycle，并要求首次 running 事件属于该 generation；至少把 lifecycle timestamp 与 operation boundary 比较并 fail closed，不能仅排除一个 `previousThreadId`。

定位：`backend/src/terminal/application/agent-preparation.ts:97-100,140-145,254-319`。

稳定 invariant：`terminal.agent-bootstrap-operation-lifecycle-boundary`。

### 2. createdPanel 的 panel_create 失败不是原子的

`createTerminalPanelSplit` 先执行 `split-window`，再写 pane option 和注册 panel。若 `splitPane` 已成功而 `setPanePanelId` 失败，`prepareTerminalAgent` 只能通过 manager panel diff 猜测 partial creation；此时 manager 尚无新 panel，所以响应为 `createdPanel=false`、`panelId=null`、`tmuxPaneId=null`，但 tmux 中已多出一个 live pane。

受控探针得到 `registeredPanelCount=1`、`liveTmuxPaneCount=2`、`orphanPaneCreated=true`。API 409 的 details 否认已创建资源，调用方既无法定位也无法回收该 pane。

修复建议：让 split 创建过程保留即时 pane identity 并事务化；后续步骤失败时 kill 新 pane并恢复 workspace，或返回 `createdPanel=true` 与可恢复的 pane identity。成功时 200/201 语义可以保留，但所有部分失败必须与真实资源状态一致。

定位：`backend/src/terminal/application/agent-preparation.ts:38-92`、`backend/src/terminal/application/panel-split.ts:117-162`、`backend/src/routes/terminal-panel-routes.ts:116-138`。

稳定 invariant：`terminal.agent-bootstrap-created-panel-atomicity`。

### 3. CLI 既有 agent/overwrite/custom command 合约回归

新 `prepareAgentSession` 仍接收 `agentOverwrite`、`agentClearCommand`、`agentExitCommand`，但除无 agent 时的参数检查外不再使用 overwrite/clear/exit。相同 provider + overwrite 不执行 clear；不同 provider + overwrite 直接报错；C4 接受的合法 custom agent name 被限制为 Codex/TraeX。`--agent-start-command` 虽会传给新 API，但旧 clear/exit 自定义命令不再执行。另有 CLI 仍允许 timeout `0`，HTTP schema 却要求最少 1000ms，导致本地校验通过后远端 400。

受控生产调用确认：相同 Codex + overwrite 只有 `actions=["bootstrap"]` 且没有 clear/exit 调用；TraeX → Codex overwrite 被拒绝；`custom-ai` 被拒绝；timeout `0` 原样发给 API。C4 对应实现分别返回 `already_ready`、`cleared_existing`、`restarted`，并实际执行配置的 clear/exit/start command。

修复建议：在共享原语之上保持既有 CLI flag、输出 status/actions 与 custom command/agent 合约，或显式版本化移除旧 flags；不能继续接受却静默忽略。CLI 与 API 还需统一 timeout 边界。

定位：`packages/runweave-cli/src/commands/terminal-agent-preparation.ts:23-87`、`packages/runweave-cli/src/commands/terminal.ts:255-276`、`backend/src/routes/terminal-panel-routes.ts:80-95`；对照 C4 同文件 `:60-172`。

稳定 invariant：`cli.terminal-agent-preparation-compatibility`。

### 4. 复用路径没有保证 respawn 的是可交互 shell

复用 `agent_idle` panel 时，代码直接用 `session.command/session.args` 执行 `respawn-pane -k`，随后向同 pane 发送 `codex|traex <positional prompt>`。但 terminal create API/CLI 公开允许任意 `command`/`args`；`session.command` 并不等价于 shell。若 session 原本直接以 Codex、Node 或其他长进程启动，respawn 会重启该进程，再把 CLI 文本输入它，而不是先恢复持久交互 shell。

真实 `dvs-7d6afc` 只覆盖 `/bin/zsh -f`，不能证明公开支持的 custom-command session。当前实现也没有用 `isInteractiveShellLaunch` 约束或选择持久 recovery shell。

修复建议：持久化并明确使用 session 的交互 shell/recovery shell，或在复用前验证原 command 是可交互 shell；不满足时 fail closed 或创建新 panel。必须保持同 panel/pane ownership、hook/session env 和退出/timeout 分类。

定位：`backend/src/terminal/application/agent-preparation.ts:148-171`、`backend/src/terminal/tmux-pane-service.ts:146-170`、`backend/src/routes/terminal-session-route-helpers.ts:15-24,74-114`、`packages/runweave-cli/src/commands/terminal.ts:129-152`。

稳定 invariant：`terminal.agent-bootstrap-respawn-shell-contract`。

### 5. 同 panel 缺少 single-flight，agent_starting 仍可再次进入

准备前的 guard 只拒绝同 provider 的 `agent_running`，不拒绝 `agent_starting`，也没有 panel-scoped mutex/operation token。两个同时到达的请求可都从 idle 计算 `reusingAgent=true`，依次写 `agent_starting`，并各自订阅、respawn、set option 和发送 prompt；两者还能把同一 lifecycle 当成自己的完成事件。

这会破坏“一步原语”的原子性，并可能把第二条 CLI/prompt 注入第一条正在启动或已进入 TUI 的 pane。现有 verifier 没有并发 case。

修复建议：对 `(terminalSessionId,panelId)` 做 single-flight/compare-and-set，`agent_starting` 必须携带 operation identity；重复请求应复用同一 promise 或以稳定冲突 fail closed，且 completion 只能消费同 operation lifecycle。

定位：`backend/src/terminal/application/agent-preparation.ts:97-145,147-186,254-319`。

稳定 invariant：`terminal.agent-bootstrap-panel-single-flight`。

## 已解决项

- 共享路径：shared DTO、Backend route/primitive、Web service wrapper、CLI HTTP client、Agent Team readiness 都指向同一 Backend primitive。Codex 与 TraeX 都把 prompt 作为 positional argument；Codex 自动补 `check_for_update_on_startup=false`。Web 当前只有 service wrapper、没有产品调用方，这不影响 API 复用结论，但不能作为 Web 行为已验收的证据。
- 短 turn 与 listener：listener 在发送 CLI 前注册；现有 verifier 的 80ms turn 通过，成功、exit、timeout 路径均执行 `dispose`，未发现 listener 泄漏。
- pane/provider/final state：现有 verifier 覆盖同 `previousThreadId` delayed idle、provider mismatch、panel mismatch、running→idle、最终 terminalState idle 与 active thread/provider cleared；这些检查本身正确，但未覆盖第 1 条“更早的不同 threadId”。
- 同 pane happy path：`dvs-7d6afc` 中 Codex 首次/复用均 HTTP 200、panel/pane 不变且 thread 更新；TraeX 新 panel 返回 HTTP 201 / `createdPanel=true`，最终均 idle。
- failure-state：session/pane/readiness 失败继续收敛为 `need_human`、`activeWorkerRole=null`、`activeWorkerDispatch=null`、workers frozen，repair attempts 不增加；`dvs-8854aa` 与源码一致。
- 禁用 fallback：新 readiness/primitive 不使用 TUI 文案、scrollback、`ps` 或 `lsof` 作为 authoritative readiness；TraeX 也走同一 lifecycle primitive。
- diff hygiene：`git diff --check` 通过，未发现独立于 C5 目标的格式化改动。

## 验证记录

- `pnpm agent-team:verify-review-checkpoints`：通过。
- `pnpm --filter @runweave/backend typecheck`：通过。
- `pnpm --filter @runweave/backend lint`：通过。
- `pnpm --filter @runweave/shared typecheck`：通过。
- `pnpm --filter @runweave/cli typecheck`：通过。
- `pnpm --filter @runweave/frontend typecheck`：通过。
- `git diff --check 90c3b1102a45d0e47702461c194d58c597a2846a`：通过。
- lifecycle 受控反例：`previousThreadId=latest-thread`，接受 timestamp 早于 operation 60s 的 `ancient-thread`。
- panel-create 受控反例：split 后 set option 失败，`createdPanel=false` 但 live tmux pane 数从 1 变 2。
- CLI 受控反例：overwrite 不 clear/exit、跨 provider overwrite/custom agent 被拒、timeout `0` 下传。
- `.runweave/evidence/dvs-7d6afc/bootstrap-lifecycle/results.json`：原始 JSON 已核查；仅证明真实 shell happy path，不覆盖上述反例。
- `.runweave/evidence/dvs-8854aa/readiness-p1/dispatch-failure-probe.json`：failure-state P1 仍 resolved。

明确未运行 `behavior_verify`；静态门禁与受控 probe 不能替代 behavior 验收。

## 非阻断既有项

P2 `recheck-watchdog-clock-lifecycle` 继续作为 informational；本 C5 patch 未处理，也不升级为本轮 P1。
