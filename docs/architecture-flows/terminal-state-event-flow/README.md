# terminal-state-event-flow（终端状态与事件流）

Runweave 终端状态、事件、恢复和 UI 提示语义的可运行 HTML 架构说明。

- **性质**：代码现状图，不是产品 UI 设计稿，也不是目标架构承诺。
- **代码基线**：HEAD `2d15b8e7` + 当前终端状态工作区改动，复现日期 `2026-07-16`。
- **核心判断**：一个终端没有单一 `status`；当前实现至少包含进程、数据连接、Agent 投影、Thread 事实、注意力标记和多 Pane 聚合六条并行状态轴。
- **与既有图的关系**：`../terminal-project-session-runtime-flow/` 解释 Project / Session / xterm / Runtime 的完整数据面，本图只深入状态与事件。

## 启动

```bash
python3 -m http.server 6189 --directory docs/architecture-flows/terminal-state-event-flow
```

打开 `http://127.0.0.1:6189/`。

## 阅读顺序

1. **状态总览**：先区分六条状态轴和各自权威来源。
2. **事件场景**：切换正常执行、完成提醒、断线恢复、退出重启和多 Pane，观察每一步改变哪条轴。
3. **视觉语义**：区分左侧状态点、右侧提醒点和连接过渡纹理。
4. **事实边界**：查看当前实现中会造成误读或状态分叉的已确认边界。
5. **问题地图**：按系统架构、可靠稳定性和证据等级筛选潜在问题，查看触发、机制、结果、保护与代码来源。

## 一句话结论

终端 UI 应把“事实状态”和“提醒状态”分开表达：`running / exited` 决定进程是否存在，`connecting / connected / closed` 决定能否通信，`shell_idle / agent_starting / agent_running / agent_idle` 是本地 Agent 投影，Thread 快照用于校正 Agent 是否真的在运行，而绿点和铃铛只表示一次性注意力，不是终端运行状态。

## 已确认的当前行为

- Session 进程状态只有 `running | exited`；退出后 Agent 状态在读取时被压成 `shell_idle`，UI 仍优先显示 `exited`。
- 每个终端数据 WebSocket 独立维护 `connecting | connected | closed`；重连期间输入不会写入 socket，并会提示重新连接。
- Agent 本地投影由 shell metadata、hook 和持久化 `terminalState` 驱动；只有 `UserPromptSubmit` 进入 `agent_running`，其余参与状态的 hook 回到 `agent_idle`。
- Hook 在写状态前要通过 session / panel / tmux pane / operation generation / 当前 Agent 身份校验，旧进程和错 Pane 的事件会被忽略。
- Internal hook 的 202 响应携带 `disposition: recorded | ignored | exited`；ignored 还携带稳定的 `ignoreReason`。存在 operation generation 时，测试必须发送 matching operationId。
- App Server 使用 7 天 JSONL 事件和线程投影，并通过 provider 生命周期轮询补偿 hook 缺失；Backend 再消费这些事件更新 TerminalState。
- Terminal Workspace 的全局事件流是内存 500 条窗口；Backend 重启会更换 `streamId`，客户端遇到 stream 变化或 cursor gap 会回到 REST session 快照。
- 终端 tab 左侧圆点表达 Agent / process 状态；右侧琥珀点是 2 秒 bell，右侧绿色 completion 使用持久化 revision，页面刷新后可恢复，选中 session 时向服务端提交 acknowledged revision。
- Home 与 State API 都会从 running Pane 聚合状态；Home 仍会叠加 provider Thread 快照。旧版持续数秒的多 Pane 状态分裂已无法复现，但并发跨接口读取仍会出现百毫秒级交叉快照。
- 多 Pane 聚合优先级为 `agent_running → agent_starting → agent_idle → shell_idle`，已经保留 starting 语义。
- 多 Pane 时 session 级 `activeCommand` 会被有意压成 `null`，表示“没有单一 session command”，不表示所有 Pane 都已回到 shell；Agent 退出验收必须绑定目标 panel。
- Agent Prepare 使用临时环境变量前缀启动命令，shell integration 会跳过赋值 token；真实 Codex 稳定识别为 `activeCommand=codex`。
- tmux session 会同步 App Server discovery 环境；真实 hook 已写入与 Backend 相同的隔离 App Server，Backend 离线期间的 completion 可在重启后消费。

## 问题地图

问题地图只保留当前代码在真实现场可复现的 `3` 项；旧问题和 A9 的修复闭环见 [真实场景复现报告](./real-scenario-reproduction-report.md)。

- `R2`（高）：这是需要修复的代码 Bug。普通程序只要打印一段特殊控制信息，API 和终端标签就会短暂误认为 Codex 正在运行；后续自动纠正不能消除这段错误窗口。
- `A7`（中）：启动或完成 Codex 时，终端页、状态接口、Session 列表和 Home 可能短暂显示不同阶段；实测均在 `300ms` 内自动一致，没有复现持续 5–7 秒的旧问题。
- `A8`（中）：这是验收误报，不是终端状态残留。一个面板已回到 shell，另一个面板的 Codex 仍在运行；旧用例却把终端汇总字段 `activeCommand=null` 误解成“所有 Codex 都已退出”。

没有真实运行证据的推测不再列为问题；无法在当前代码复现的旧条目保留在报告的“无法复现”矩阵中，而不是继续显示为当前风险。

## 图中的视觉口径

- 青色脉冲：`agent_running`，事实状态。
- 琥珀脉冲：`agent_starting`，事实状态。
- 天蓝实心：`agent_idle`，事实状态。
- 灰色空心：`shell_idle`，事实状态。
- 灰色实心：`exited`，进程终态。
- 绿色右点：持久化 completion attention revision，选中后服务端确认，不代表进程仍在运行。
- 琥珀右点：live bell attention marker，仅非当前 session 出现，2 秒后清除，并在同一位置视觉覆盖绿色点。
- 斑马纹：本说明图用来表达 `connecting / resync` 过渡，不声称当前产品已经统一使用该视觉。
- 红色：需要人工处理的终止错误，例如鉴权失败或达到终止重连条件；不是新的 TerminalState 枚举。

## 代码源

### 合约与状态

- `packages/shared/src/terminal/{session,state,events,websocket,completion}.ts`
- `packages/shared/src/app-server-events.ts`
- `backend/src/terminal/{terminal-state-service,terminal-state-store,agent-hook-processor}.ts`
- `backend/src/terminal/{manager-session-runtime,runtime-recorder,shell-integration}.ts`

### 事件与恢复

- `app-server/src/{event-store,event-center,state-projector,agent-thread-status-reconciler}.ts`
- `backend/src/app-server/{event-consumer,integration}.ts`
- `backend/src/app-server/handlers/{agent-hook,agent-completion,agent-lifecycle}.ts`
- `backend/src/terminal/{terminal-event-service,completion-event-service}.ts`
- `frontend/src/features/terminal/{use-terminal-connection,use-terminal-events-connection,workspace-store}.ts`

### UI 消费

- `frontend/src/components/terminal/{terminal-workspace-events,terminal-workspace-content}.tsx`
- `frontend/src/components/terminal/{terminal-session-tab,terminal-project-tab-bar}.tsx`
- `backend/src/routes/{terminal-state,app-home-overview}.ts`

## 验证点

- 六条轴的状态、权威来源和清除方式可以同时阅读，不再把所有信号压成一个 `status`。
- 五个场景按钮均可切换，并明确标出每一步修改的状态轴。
- 正常执行场景能读出 `activeCommand → agent_starting → UserPromptSubmit → agent_running → Stop → agent_idle`。
- 完成提醒场景明确区分 `agent_idle`、completion 绿点和 bell 琥珀点。
- 断线恢复场景明确区分 terminal data WS 与 global terminal-events WS，并展示 `streamId + cursor gap + REST resync`。
- 多 Pane 场景展示当前 `running → starting → idle → shell_idle` 聚合优先级。
- 问题地图可以按全部、系统架构、可靠稳定性和真实场景复现筛选。
- 3 个当前问题项均显示影响等级、触发条件、代码机制、结果、保护、真实证据和代码来源。
- 页面在桌面宽度和 390px 移动宽度均无横向溢出；浏览器控制台无 error。

## 边界

- 原型不连接真实 Backend，不修改产品代码，也不替产品决定最终颜色系统。
- “斑马纹”是架构图中的过渡编码，用于解决“连接中”和“事实状态”混淆；若要落到产品 UI，需要单独做产品交互设计。
- “风险”卡片只陈述当前代码与真实运行共同确认的语义分叉；没有运行证据的性能或故障推测不写成事实。
