# Terminal Readiness 状态模型方案评审

## 结论

建议的主方向是正确的：Agent Team 不应通过 panel 宽度、Codex/TraeX 状态行、MCP 启动文案、idle 文案或其它 scrollback/TUI 表象判断“命令是否已提交”；正式 worker prompt 应直接作为 CLI initial query；同步请求只确认命令提交，后续 lifecycle 由 hook/App Server 异步更新。

但需要修正两个前提：

1. 固定等待 `10000ms` 只是临时的 shell settle buffer，不是 authoritative readiness，也不应进入状态语义。
2. `shell created`、`command submitted`、`agent process observed`、`first hook observed`、`worker outbox completed` 不是一个互斥、线性的 `ready` 枚举。前四项属于 terminal agent launch/runtime，最后一项属于 Agent Team dispatch/result；应通过两个相关但独立的状态模型表达。

当前代码属于“部分完成迁移”：`backend/src/agent-team/agent-readiness.ts` 已不读取屏幕，只调用 `prepareTerminalAgent()`；serial dispatch 与 repair bounce 已把正式 prompt 作为 initial query。但首次 worker 启动、主 Agent 生成测试用例、部分 recheck 仍先提交默认 bootstrap prompt，再立即按键注入正式 prompt；全局 `TerminalStateService` 也仍会根据 scrollback 把 `agent_starting` 改成 `agent_idle`。

因此，本次方案评审结论为：方向通过，但当前实现仍有 3 条 P1，不能把现状描述为“readiness 已完全状态化”。

## 当前真实链路

### 已经做对的部分

- `AgentTeamAgentReadinessService.ensureAgentReady()` 只解析 provider/panel 并调用 `prepareTerminalAgent()`，不再识别 TUI 文案。定位：`backend/src/agent-team/agent-readiness.ts:29-84`。
- `prepareTerminalAgent()` 在命令行中一次性携带 operation id、CLI 和 initial prompt；`sendInputToSession()` 返回后接口响应 `status: "starting"`，不等待 thread/hook。定位：`backend/src/terminal/application/agent-preparation.ts:226-269,333-345`。
- serial dispatch 会先持久化 dispatch boundary，再把正式 worker prompt 作为唯一 initial query。定位：`backend/src/agent-team/service-serial-dispatch.ts:231-243`；对应 verifier：`scripts/verify-agent-team-review-checkpoints/bootstrap-lifecycle.mjs:50-128`。
- worker completion 已有独立的 `dispatchId`、outbox freshness 和 pane-scoped outbox 合约，具备继续承载业务完成状态的基础。定位：`packages/shared/src/agent-team.ts:200-220,342-371`。

### 当前仍然混合的部分

- panel 的持久状态在 respawn 和固定等待之前就写成 `agent_starting`；API 的同名 `status: "starting"` 则在命令提交之后才返回。定位：`backend/src/terminal/application/agent-preparation.ts:188-240,254-269`。
- `TerminalStateService.getCurrent()` 仍能通过 `hasAgentReadyPrompt(scrollback)` 将 `agent_starting` 变成 `agent_idle`，而且 getter 本身会执行 `setAndPublish()`。定位：`backend/src/terminal/terminal-state-service.ts:147-183,298-304`。
- shared `TerminalState` 只有 `shell_idle / agent_starting / agent_idle / agent_running`，无法表达 shell 已创建、命令已提交、进程已观察、首个 hook 已观察之间的差异。定位：`packages/shared/src/terminal/state.ts:3-12`。

## Findings

### P1：首次启动、主 Agent 生成与部分 recheck 仍存在“bootstrap 后立即二次注入”竞态

首次执行会逐个 worker 调用未传正式 prompt 的 `ensureAgentReady()`，因此 CLI initial query 是默认 bootstrap prompt；随后 active worker 的正式 prompt 通过 `sendPromptToPane()` 直接发送按键。主 Agent 测试用例生成和 `sendRecheckToWorker()` 也采用相同结构。定位：

- `backend/src/agent-team/service-execution.ts:141-180`
- `backend/src/agent-team/service-lifecycle.ts:161-178`
- `backend/src/agent-team/service-completion.ts:485-515`
- `backend/src/agent-team/prompt-sender.ts:39-94`

`ensureAgentReady()` 只保证 tmux 已接受 agent launch line，不保证 CLI 已开始读取交互输入；第二次 bracketed-paste + `C-m` 因而可能落到尚未启动完成的 shell/CLI 输入缓冲中。现有 verifier 只覆盖 serial dispatch 和 repair bounce 的“正式 prompt 是唯一 initial query”，没有覆盖上述三个调用点。

此外，首次启动按 worker 串行 `await` 固定延迟。3 个 worker 会先支付约 `3 × 10s = 30s`，然后才给 active worker 二次注入真实任务；inactive/frozen worker 也被无必要地启动。

修复方向：panel split 只创建 shell；只在 worker 成为 active 时创建并持久化 `activeWorkerDispatch`，然后把带 `dispatchId` 的正式 prompt 传给一次 `prepareTerminalAgent()`。首次启动、serial dispatch、recheck、bounce、主 Agent 用例生成统一走同一条“persist boundary → one launch → one initial query”路径。非 active worker 保持 `shell_idle`，不要预启动 agent。

### P1：`starting` 同时表示“等待发送”和“已经提交”，TUI 仍能改写权威状态

当前 panel 在固定等待前就被写为 `agent_starting`，而 preparation response 只有在 `sendInputToSession()` 返回后才给出同名 `starting`。因此消费者看到持久 `agent_starting` 时，无法判断命令是否已经发出；`startedAt` 也记录在等待前，不能作为 `commandSubmittedAt`。

同时，Agent Team adapter 虽已不解析屏幕，全局 `TerminalStateService.getCurrent()` 仍会依据 scrollback ready pattern 执行持久状态迁移。这样 TUI 文案仍可能影响 UI、输入策略和其它读取 terminal state 的消费者。

修复方向：

- preparation response 使用精确语义，例如 `phase: "command_submitted"` 和 `commandSubmittedAt`；不要继续让 `starting` 表示同步成功条件。
- `agent_starting` 如果保留，只表示命令已提交但尚无可信 lifecycle，不得在提交前写入。
- TUI parser 可以保留为 `uiObservation` / diagnostic hint，但不得执行 `setAndPublish()`、不得参与 dispatch gate、不得改变 authoritative terminal state。
- `ensureAgentReady` 应改名为 `submitAgentLaunch`、`launchWorkerAgent` 或同等精确名称，避免调用方误以为返回时 agent 已 idle/ready。

### P1：agent process/exit 没有闭环，operation generation 也没有可靠退休点

启动命令会先写 pane option `pending:<operationId>`，agent 退出后再写 `exit:<operationId>:<code>`；但仓库内生产代码没有读取 `@runweave_agent_prepare_exit`，只有 verifier 拦截 `pending:`。因此 `cli_exit` 虽存在于 shared failure phase，当前链路并不能据此形成 process-exited 事实。

成功提交后 `releasePanelAgentPreparation()` 只删除 single-flight preparation，不删除 retained operation generation。`processTerminalAgentHook()` 在 generation 存在、事件没有匹配 operationId 且没有可信 current-thread context 时会直接 ignored；而 `handleAgentCompletionEvent()` 调用它时不传 operationId。定位：

- `backend/src/terminal/manager-base.ts:159-212`
- `backend/src/terminal/agent-hook-processor.ts:120-160`
- `backend/src/app-server/handlers/agent-completion.ts:96-118`
- `backend/src/terminal/application/agent-preparation.ts:226-240,333-345`

这意味着系统目前无法可靠区分“命令已提交但进程未起来”“agent 进程存活”“agent 已退出但 shell 仍在”，并可能因旧 generation 长期存在而拒绝缺 operationId 的 completion fallback 或后续手动启动事件。

修复方向：为 launch operation 增加明确的 process observed/exited 事件和 generation retirement。可以复用现有 pane option 通道，由 tmux metadata/output poller 读取匹配 operationId 的 `exit:`，或使用等价的 backend control-channel acknowledgement；不要再从屏幕文案反推进程状态。退出只退休匹配 generation，不能在任意 turn `Stop` 时退休，因为同一个 agent 进程可以继续下一轮对话。

### P2：五个事实应拆成 launch/runtime 与 worker dispatch 两个模型

`first hook observed` 是一次性 milestone，`agent process running` 是可变化的当前状态，`worker outbox completed` 则是另一条业务 dispatch 的完成结果。把它们放进一个枚举会产生非法倒退和归属混乱，例如 outbox 已完成时 agent 进程可能仍存活但处于 idle。

推荐模型：

| 层级 | 权威事实 | 推荐来源 | 用途 |
| --- | --- | --- | --- |
| Terminal/panel | `shellCreatedAt` / shell exited | tmux create/respawn/exit 返回 | 证明 pane/shell 生命周期 |
| Agent launch operation | `commandSubmittedAt` | backend input accepted/enqueued | 同步 API 的成功条件 |
| Agent process observation | `processObservedAt` / `processExitedAt` / exit code | launcher ack、pane process metadata 或结构化 pane option | 诊断进程是否真正存在 |
| Agent lifecycle | `firstHookObservedAt`，当前 `idle/running` | 匹配 operation/panel/thread 的 trusted hook/App Server event | 表达 agent/turn 生命周期 |
| Worker dispatch | `requestedAt` / `outboxAcceptedAt` / result | `dispatchId` + freshness + pane-scoped outbox | 表达业务任务完成/失败 |

推荐使用 milestone timestamps + current state，而不是把所有事实塞进一个 `ready` 字段。事件可能乱序到达，timestamp/identity 比单一枚举更容易做幂等和恢复。

### P2：固定 10 秒可以暂留，但必须降级为实现细节

固定等待避免了继续维护 TUI detector，作为当前兼容 shell/profile 加载的过渡方案是可接受的；现有 verifier 也覆盖了 9999ms 前零发送、10000ms 后单次发送、失败/取消零发送。

但它不能证明 shell 已能接收输入：快机器固定浪费 10 秒，慢机器仍可能失败。长期方案应由一个 backend-owned launch wrapper 在 login-shell 环境加载后发出结构化 acknowledgement，再启动带正式 initial query 的 agent；backend 等待的是 control-plane ack，不是 prompt 文案。若暂时不做 wrapper，至少只对 active worker 等待一次，并将指标命名为 `shellSettlingDelay`，不得上报成 `ready`。

## 推荐落地顺序

### 第一阶段：先消除当前竞态，保持改动最小

1. 把所有 Agent Team 启动点统一成“正式 prompt 作为唯一 initial query”；删除启动后紧邻的 `sendPromptToPane()`。
2. 首次 split 只创建 worker shell，只启动 active worker；将固定等待从最多 3 次降到 1 次。
3. 把 response 改为精确的 `command_submitted`，补 `commandSubmittedAt`；`startedAt` 仅保留为 operation 创建时间或改名。
4. `TerminalStateService.getCurrent()` 停止通过 TUI 执行状态写入；需要兼容 UI 时只返回独立 observation。

### 第二阶段：补齐状态化 API

1. 增加以 `operationId + panelId + provider generation` 为身份的 launch operation record。
2. 记录 `shellCreatedAt`、`commandSubmittedAt`、可选 `processObservedAt`、`firstHookObservedAt`、`processExitedAt/exitCode` 和 failure phase。
3. hook 只更新匹配 operation/panel/thread 的 lifecycle；out-of-order/stale event 幂等忽略且零副作用。
4. 消费现有 exit marker 或等价结构化信号，在 process exit 时退休匹配 generation。
5. `activeWorkerDispatch` 只引用 `launchOperationId`，outbox completion 继续由 `dispatchId` 管理，不复制到 terminal state。

### 更简单的备选

如果暂时不引入持久 launch operation，可先保留内存 generation 和固定 10 秒，只做三件事：统一一次 initial query、响应改为 `command_submitted`、TUI inference 不再写状态。这个版本成本低，能立即消除最主要的 prompt race 和语义误导；代价是 backend 重启后无法恢复 launch milestone，也仍不能可靠观测 agent process exit。

## 建议验收标准

1. initial worker、main test-case generation、serial dispatch、recheck、bounce 五条路径都只有一次 launch send，且其中包含该 dispatch 的正式 prompt/dispatchId；不存在紧随其后的第二次 prompt send。
2. `command_submitted` 只在 input accepted/enqueued 后出现，提交前不会写同义状态，并有独立 `commandSubmittedAt`。
3. 任意 Codex/TraeX ready 文案变化都不能改变 authoritative terminal state 或 dispatch 结果。
4. 3 个 worker 首次 split 只启动 active worker，固定等待总量最多约 10 秒而不是约 30 秒。
5. matching first hook 能记录 `firstHookObservedAt`；stale/missing operation hook 对 store、session、panel、thread 和事件均零副作用。
6. agent process exit 能形成结构化事件、记录 exit code 并只退休匹配 generation；completion fallback 和后续手动启动不会被旧 generation 永久拒绝。
7. outbox 仅在 `dispatchId`、pane identity 和 freshness 全部匹配时进入 completed/failed；terminal lifecycle 不直接宣称 worker 完成。

## 验证记录

- 代码与调用链只读检查：完成。
- `pnpm agent-team:verify-review-checkpoints`：通过，当前列出的全部 checks 均为 success。
- verifier 覆盖边界：已覆盖 serial dispatch、repair bounce、固定等待、单次 launch command、stale hook 零副作用；未覆盖首次 worker、main test-case generation、`sendRecheckToWorker()` 的唯一 initial query，也未覆盖生产 exit marker 消费与 generation retirement。
- 未执行浏览器/Playwright：本轮是状态模型与代码链路评审，不是 UI 行为验收。
