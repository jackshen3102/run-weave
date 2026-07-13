# Codex 与 TraeX 能力差距审计

## 结论

TraeX 不是“完全没有适配”。当前已经具备 Hook 安装、`SessionStart` / `UserPromptSubmit` / `Stop` / `PostToolUse` 捕获、向 Backend 与 App Server 推送、基础 `agent_running` / `agent_idle` 更新、Activity 写入以及完成通知。

真正缺失的是一条完整的 **Trae thread 真值链路**：Runweave 能看到“某个终端里的 Trae 发生了事件”，但不知道“这是哪个真实 Trae thread”，也没有从 Trae 原始会话数据读取真实运行状态、补偿漏失事件、查询 thread 详情或恢复 thread 的 provider adapter。

这会形成连锁缺口：

```text
Trae hook threadId 为空
  -> Terminal 不保存 Trae current/last thread
  -> Activity 无 threadId
  -> App Server 只能创建 unknown-thread fallback
  -> 真实 Trae thread ID 查询返回 404
  -> 无法读取 preview / turns / lifecycle
  -> 无法轮询补偿漏掉的 Stop / abort
  -> 无法按 thread 恢复或 resume
```

## 审计方法与数据范围

本结论同时使用了代码和真实运行数据，不以静态猜测代替现场验证。

- 运行中的 Stable Backend：`http://127.0.0.1:5001`，source revision `798f25a22b2c28e8b9cdd7da9b528e712346b0e7`
- 运行中的 App Server：service instance `app-server:68ac1e80-b97f-457d-b0e2-9de703c72b32`
- Hook 日志：`~/.runweave/browser-profile/8a5edab2/logs/hook-bridge-debug.jsonl`
- App Server 事件日志：`~/.runweave/app-server/app-server-events.jsonl`
- Activity SQLite：`~/.runweave/activity/activity.sqlite`
- Trae 原始会话：`~/.trae/cli/sessions/**/*.jsonl`
- 真实终端样本：`e333cc7c`、`f4741241`、`ad6a2a9c`、`a07db00d`、`d5023252`
- 真实 Trae thread：`019f50b3-5527-7880-992e-621eaa62f1ec`、`019f575a-e201-75b3-ad95-b9bf268c948c`

当前 App Server 日志内的真实 Hook 统计：

| Source | Hook 数 | 带真实 threadId | 事件构成                                                                              |
| ------ | ------: | --------------: | ------------------------------------------------------------------------------------- |
| Codex  |  16,078 |          16,078 | `PostToolUse` 14,426；`SessionStart` 156；`Stop` 923；`UserPromptSubmit` 537；其余 36 |
| Trae   |     813 |               0 | `PostToolUse` 714；`SessionStart` 12；`Stop` 36；`UserPromptSubmit` 51                |

本机 80 个包含 lifecycle 事件的 Trae JSONL 中，共观察到：

| `payload.type`  | 数量 | 状态含义           |
| --------------- | ---: | ------------------ |
| `task_started`  |  368 | 当前 turn 开始执行 |
| `task_complete` |  349 | 当前 turn 正常结束 |
| `turn_aborted`  |   18 | 当前 turn 中断     |

80 个会话文件的最后 lifecycle 均已收敛：73 个最后为 `task_complete`，7 个最后为 `turn_aborted`，没有最后停在 `task_started` 的文件。因此这三个事件足以为当前本机数据建立最小状态真值映射。

## 能力差距清单

### P1：Trae 真实 thread 身份没有进入 Runweave

**Codex 已有**

- Hook bridge 从 payload 读取 `threadId` / `thread_id` / `sessionId` / `session_id`。
- `SessionStart` / `UserPromptSubmit` 后同步 Terminal 与 Panel 的 `threadId`、`lastThreadId`、`lastThreadStatus`。
- App Server 以真实 threadId 投影 `ThreadRef`，并生成 `detailRef = { provider: "codex", id }`。
- Activity 的 query / response 事实带 threadId。

**Trae 缺失**

- `electron/resources/hooks/runweave-hook-bridge.cjs:339` 明确只在 `source === "codex"` 时调用 `readThreadId(payload)`；Trae 一律写成 `null`。
- `backend/src/terminal/agent-hook-processor.ts:187-196` 明确只为 Codex 同步 thread metadata。
- Trae 事件只能被 App Server 聚合为 `unknown-thread:traex:<terminalId>:...`，`detailRef` 为 `null`。

**真实证据**

- Terminal `e333cc7c` 的 scrollback 明确显示：`traex resume 019f50b3-5527-7880-992e-621eaa62f1ec`。
- 对应 Trae JSONL 存在，`session_meta.payload.id` 与该 ID 完全一致，包含 14 次 `task_started` 和 14 次 `task_complete`。
- 但 `rw terminal show e333cc7c` 的 `threadId/lastThreadId` 均为 `null`。
- App Server 只返回 `unknown-thread:traex:e333cc7c:none:trae:e333cc7c`；用真实 ID 查询 `/threads/019f50b3-...` 返回 404。
- Codex 对照 thread `019f5580-16a9-7a72-ac7c-71a07390cfd7` 查询返回 200，并带 `detailRef.provider=codex`。

**影响**

- 无法按真实 Trae thread 查询、归档、去重或恢复。
- Activity 虽有事件，但不能与 Trae thread/turn 精确关联。
- 同一个 Terminal 先运行 Codex、后运行 Trae 时，`lastThreadId` 仍可能是旧 Codex ID；字段本身又没有 provider，消费者无法判断归属。

### P1：Trae 没有 thread 状态真值读取与漏事件补偿

**Codex 已有**

- `CodexAppServerClient` 调用 `thread/read`，必要时调用 `thread/resume`，读取 `active / idle / notLoaded / systemError`。
- `CodexThreadStatusCompensator` 启动后延迟 10 秒、每 30 秒轮询最近 3 小时的真实 Codex threads。
- 状态不一致时补写带 `compensation=true`、`compensationReason=codex_thread_status_mismatch` 的 `agent.hook`。

**Trae 缺失**

- 没有 Trae thread reader。
- 没有读取 `~/.trae/cli/sessions/**/*.jsonl` 的 lifecycle adapter。
- 没有 Trae 候选 thread、轮询、文件监听或补偿事件。
- App Server 只能依赖 Hook 是否完整到达；漏掉 `Stop` 或发生 `turn_aborted` 时会长期保留旧状态。

**真实证据：用户给出的 `019f575a-e201-75b3-ad95-b9bf268c948c`**

- 原始文件存在：`~/.trae/cli/sessions/2026/07/13/rollout-2026-07-13T01-23-21-019f575a-e201-75b3-ad95-b9bf268c948c.jsonl`。
- `17:23:43.732Z` 出现 `task_started`。
- `17:23:55.358Z` 最后出现 `turn_aborted`，`reason=interrupted`。
- 同时段、同 cwd 的 Hook 被 Terminal `ad6a2a9c` 接收：`SessionStart` 在 `17:23:43.842Z`，`UserPromptSubmit` 在 `17:23:44.066Z`，二者 `threadId=null`。由于缺少 threadId，这里只能按时间、cwd 和唯一 SessionStart 做强相关，无法由 Runweave 本身直接证明 ID 关联；这恰好就是身份缺口本身。
- App Server 中该 Terminal 的 Trae fallback thread 仍为 `running`，最后事件停在 `UserPromptSubmit`；没有 `Stop`、completion 或 compensation。
- Terminal 当前已经 `activeCommand=null`，说明 Trae 进程不再执行；App Server thread 状态却仍停在 `running`。
- App Server 事件日志共有 489 条补偿事件，全部为 Codex；Trae Hook 有 813 条，但 Trae compensation 为 0。

**影响**

- “任务正在执行中”不能可靠判断；Hook 丢失、Ctrl+C、中断或异常退出后可能永久显示 running。
- `turn_aborted` 无法表达为 interrupted，`task_complete` 也不能作为第二真值源校正状态。

### P1：Trae 的 `lastThreadId`、preview 与 thread history 链路缺失

**Codex 已有**

- 当前 thread 与 last thread 分开保存。
- Hook Stop 时清空 current thread，同时保留 `lastThreadId/lastThreadStatus`。
- SessionStart 后后台读取 Codex preview。
- App Home 在 Codex thread 活跃时读取真实状态与 preview。

**Trae 缺失**

- Trae Hook 不触发 metadata 同步，所以不能写入 current/last thread。
- 没有 Trae preview/turns 读取器。
- App Home 的 thread snapshot 路径明确限定 `agent === "codex"`。
- `lastThreadId` 没有同时保存 provider；切换 Agent 后可保留一个无法归因的旧 Codex ID。

**真实证据**

- `e333cc7c` 已有可 resume 的真实 Trae session，但 current/last thread 都为空。
- `f4741241` 当前 `activeCommand=traex`，但 `lastThreadId=019f4cb8-...`；App Server 证明该 ID 是此终端历史上的 Codex thread，而当前 Trae 只对应一个 unknown-thread fallback。
- Activity `f4741241` 已真实记录 1 条 `agent.thread.started`、4 条 `user.query.submit_requested`、1 条 `agent.response.observed`，6 条 Trae 事实的 threadId 全为空。

**影响**

- Terminal 历史无法按 Trae thread 分段。
- Activity、原始 Trae turn、Terminal scrollback 不能建立精确 join。
- UI 若直接展示 `lastThreadId`，可能把旧 Codex ID误认为当前 Trae 的历史。

### P2：tmux 丢失后的自动恢复只支持 Codex

**Codex 已有**

- 当原 tmux session 丢失、原 launch 是交互式 shell、`activeCommand` 仍为 Codex 且保存了 `threadId` 时，重建 shell 后自动注入 `codex ... resume <threadId>`。
- 代码位于 `backend/src/terminal/runtime-launcher.ts:84-102, 231-235, 323-340`。

**Trae 缺失**

- 没有 provider-neutral resume command。
- 没有 `traex resume <threadId>` 恢复分支。
- 更前置的 Trae threadId 本身也没有持久化，因此即使增加命令分支也没有可靠输入。

**验证边界**

本项由代码路径完全确认，但没有破坏现有用户 tmux session 做现场测试。实施时必须在隔离 Dev Session 中制造 tmux loss 验证，不能拿当前用户终端试验。

### P2：Agent Team readiness 对 Trae 直接放行，没有真实 ready gate

**Codex 已有**

- 最长等待 15 秒、每 250ms 轮询 UI readiness。
- 识别 ready prompt、trust prompt、update prompt 和 update 后 restart。
- 未 ready 会超时失败，不会把“已发送启动命令”等同于“Agent 已可用”。

**Trae 缺失**

- `backend/src/agent-team/agent-readiness.ts:126-128` 对非 Codex 直接结束等待。
- `isAgentUiReady()` 在 `agent !== "codex"` 时直接返回 true。
- `packages/shared/src/terminal-agent-readiness.ts` 只有 Codex readiness patterns。

**影响**

- Agent Team 启动 Trae worker 时可能在 TUI 尚未 ready、启动失败或停在交互提示时继续派发任务。

**验证边界**

本项已由执行分支确认，但本轮未启动新的 Agent Team Trae worker 制造失败现场，因此没有把它写成“已复现线上故障”。

### P2：普通 Terminal 的 ready-prompt 兜底只支持 Codex

**Codex 已有**

- 当状态仍是 `agent_starting` 但 scrollback 已出现 Codex ready UI 时，`TerminalStateService` 会纠正为 `agent_idle`。

**Trae 缺失**

- `backend/src/terminal/terminal-state-service.ts:277-284` 对非 Codex 固定返回 false。
- 没有 Trae ready UI pattern。

**现场观察**

- `0786bd15` 的终端列表一度显示 `agent_starting/traex`，而 scrollback 已出现完整 Trae ready prompt；后续通过其他状态路径收敛到 idle。
- 因为它最终自行收敛，本项只能证明 fallback 不对称，不能证明当前一定永久卡住。

## 不是差距的能力

以下能力已经支持 Trae，不应在后续方案里重复建设：

| 能力                   | 代码/运行证据                                                                                                           | 判断                                  |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| Hook 安装              | Toolkit plugin 声明 `PreToolUse/PostToolUse/SessionStart/Stop/SubagentStop/UserPromptSubmit`；真实收到 813 个 Trae Hook | 已有                                  |
| Hook 鉴权与推送        | Trae Hook 向 App Server 返回 201，向 Backend agent-hook 返回 202                                                        | 已有                                  |
| 基础状态更新           | `UserPromptSubmit -> agent_running`，`Stop -> agent_idle` 的共享 processor 支持 Trae family                             | 已有，但没有第二真值源                |
| Activity 基础写入      | `f4741241` 已写 started/query/response 事实                                                                             | 已有，但 threadId 为空                |
| App Server 事件投影    | 支持 `trae/traecli/traex`，并生成 fallback ThreadRef                                                                    | 已有，但 fallback 不能替代真实 thread |
| 完成通知               | Desktop/飞书通知调用接受 source，不限定 Codex                                                                           | 代码已有；本轮未做通知 UI 验收        |
| durable event consumer | Backend 对 App Server event/cursor/reconnect 的消费是 agent-neutral                                                     | 已有                                  |
| activeCommand 识别     | `trae/traecli/traex` 都属于 `TerminalAgentKind`                                                                         | 已有                                  |

## 基于真实数据的实施顺序

### 阶段 0：先确认 Trae Hook 原始身份字段，不做时间猜测

当前 bridge 在读取前就把非 Codex threadId 置空，因此现有日志无法回答 Trae Hook 原始 payload 是否已经带 `session_id`。第一步应只记录允许列表中的 payload key/type，或直接核对 Trae plugin hook contract。

验收必须包含两个相同 cwd、同时启动的 Trae session，确保得到的 ID 分别与两个 JSONL 的 `session_meta.payload.id` 一致。仅靠 cwd + 时间最近匹配不能作为最终实现。

### 阶段 1：建立 provider-neutral `AgentThreadRef`

把当前 Codex-only metadata 同步抽成共享流程，至少携带：

- `provider/agent`
- `threadId`
- `terminalSessionId/panelId/tmuxPaneId`
- `status/lastStatus/updatedAt`
- `detailRef`

`lastThreadId` 必须同时携带 provider，避免旧 Codex ID 在 Trae 现场失去归属。

### 阶段 2：实现 Trae JSONL lifecycle reader

以 `session_meta.payload.id` 为 thread 身份，以最后 lifecycle 事件作为最小状态真值：

- `task_started -> running`
- `task_complete -> idle/completed turn`
- `turn_aborted -> idle/interrupted`

reader 应同时提供 preview、turn 列表以及最后 lifecycle cursor；未知 `payload.type` 保留 raw，不提前臆造状态。

### 阶段 3：把 Codex compensator 泛化为 provider reconciler

- Codex provider 继续使用 `thread/read`。
- Trae provider 使用 JSONL watcher + 30 秒低频兜底扫描。
- compensation dedupe 至少包含 `provider + threadId + lastProjectedEventId + observedLifecycle`。
- 不扫描 `unknown-thread` 作为最终方案；应先通过阶段 1 收敛为真实 thread。

### 阶段 4：接通消费侧

- Terminal current/last thread
- Activity `threadId/turnId`
- App Server `/threads/:id` 与 `detailRef`
- App Home preview/status
- Terminal history 的多 thread/turn 展示
- tmux loss 后的 `traex resume <threadId>`
- Agent Team Trae readiness gate

## 必须执行的真实验收场景

1. **正常完成**：复刻 `e333cc7c`，Trae `task_complete` 后 Terminal、App Server、Activity 都指向同一真实 ID，`/threads/:id` 返回 200。
2. **中断补偿**：复刻 `019f575a...`，只有 `task_started + turn_aborted`、没有 Stop Hook 时，最多一个补偿周期内从 running 收敛为 interrupted/idle。
3. **同终端切 Agent**：复刻 `f4741241`，Codex -> Trae 后 current/last thread 均保留 provider，不把旧 Codex ID 显示成 Trae thread。
4. **同 cwd 并发**：两个 Trae session 同时启动，threadId 不串线；这是禁止“按时间猜 ID”的门禁。
5. **Hook 正常但 reader 暂时不可用**：继续生成 fallback 状态，同时明确标识 degraded；reader 恢复后合并到真实 thread，不能保留两个永久记录。
6. **tmux 丢失恢复**：只在隔离 Dev Session 中销毁 tmux，验证重建后输入 `traex resume <真实 ID>`，不操作用户现有终端。
7. **Agent Team readiness**：Trae 正常 ready、启动失败、停在交互提示三种场景；只有真实 ready 才允许派发任务。

## 最终判断

建议不要分别为 `last_thread_id`、Activity 空数据、状态卡住、thread 查询 404 各打一个补丁。它们是同一个根因的不同表现：**Runweave 目前没有 Trae thread provider**。

长期正确且改动更小的路径是先补齐 provider-neutral thread identity 与 Trae lifecycle reader，再复用现有 App Server projector、Activity、Terminal state 和 consumer。这样 Codex 现有能力不需要重写，Trae 也不会长期依赖 `unknown-thread` 与 Hook 单一信号。
