# Runweave 终端状态接入 OSC 7501

## 目标与范围

用户切到其他终端后，可以看出哪个 Codex 或 Claude 终端在运行、等待输入、本轮结束或失败。
**展示以当前进程的 OSC 7501 为主，既有 Hook 兜底。** Full Access 首先验收运行、结束和失败。
正常手动启动也纳入范围。Web、Electron 和 iOS 读取同一 Backend 展示状态。

当前 `TerminalState` 同时参与展示、输入和停止等判断。本次通过可选 `programStatus` 增加展示状态，
继续由既有链路处理输入、停止、任务监督、飞书通知和完成修订。终端上的 `done` 表示程序报告本轮结束，
外部 CI 或后台进程可以继续运行。见 [终端状态](../architecture/terminal-state.md) 和
[完成事件](../architecture/terminal-completion-hooks.md)。

## 来源与状态

| 场景                                                     | 展示规则                                                                                                                                                                     |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 当前 CLI 尚未发出有效 OSC，或该运行时未支持 OSC          | 使用同一会话当前轮次的 Hook 状态。没有 Hook 证据时沿用现有启动或 shell 显示。                                                                                                |
| 当前 CLI 发出第一份有效状态                              | OSC 接管展示。能力查询和应答只协商协议。                                                                                                                                     |
| OSC 报告工作或等待，收到普通 Stop 候选                   | 继续显示 OSC 状态。                                                                                                                                                          |
| OSC 停在工作或等待，原生证据明确确认同一轮已经结束或取消 | 使用可信原生空闲状态。Codex 复用同一轮开始与 `task_complete` / `turn_aborted` 的核对。Claude 复用同会话、同进程的 Stop 候选加 `idle_prompt` 确认。回退不生成成功或失败结论。 |
| CLI 发出根 `done` 或 `error`，且本轮没有仍活动的子项     | 分别显示本轮结束或失败。子项结束时继续根据根状态和其他活动记录展示。                                                                                                         |
| 程序清除状态、CLI 退出或用户在同一 shell 启动另一 CLI    | 重新按当前进程和可用来源计算状态。原进程的记录不继承给新进程。                                                                                                               |

OSC 没有心跳。终端静默本身不会触发回退。已有 Hook 的会话可用可信新轮开始归属随后的实时报告，
未绑定本轮的终态不覆盖新轮。手动启动且没有原生轮次身份的会话，以当前前台 CLI 的实时报告为准。
会话摘要按等待、运行、根终态的顺序选择状态。打开详情后显示所选 Panel 的状态。

## 实施顺序

### 1. 先跑通本地 tmux 的 Full Access Codex

- Codex 0.163.0 开始主动报告状态，0.164.0 支持 `done`、`error`。第一步复用现有
  [Pane 管道](../../backend/src/terminal/tmux/pane-service.ts) 和 [输出 watcher](../../backend/src/terminal/tmux/output-watcher.ts)
  被动读取实时报告。首期这一路径不发送 OSC 应答，先证明真实 Codex 不依赖握手。
  受管 Codex 在启动前准备采集，手动启动的 Codex 从已附着的 shell 观察。
  见 [Codex 上报实现](https://github.com/openai/codex/pull/52725) 和
  [0.164.0 发布说明](https://github.com/openai/codex/releases/tag/rust-v0.164.0)。
- 流式解析支持常见分片及 ST、BEL 两种结尾，按规范限制帧长度并忽略无效报告。只消费实时通道的有效帧，
  后续普通终端输出照常进入渲染和历史。首版只投影状态、阻塞类型和来源。
- tmux 已有的原始传输文件只能作为本机受限的短期缓冲，沿用 0600 权限和现有清理。
  Backend 在 [scrollback 与 recorder 入口](../../backend/src/terminal/tmux/output-poller.ts) 前消费并移除 OSC 7501 帧。
  直连或 Host 接入时同样在输出回放和历史分发前消费。`msg`、`title` 及其编码值均不进入历史 API、导出、
  状态事件或诊断日志。见 [现有原始 writer](../../backend/native/tmux-output-writer.c)。
- 在 `backend/src/terminal/state/` 做展示投影，先按真实 Pane 与前台 CLI 绑定，
  复用 [Hook processor](../../backend/src/terminal/application/agent-hook-processor.ts) 的可信当前轮次候选。
  在 [Panel DTO](../../packages/shared/src/terminal/panel.ts) 和 [会话摘要](../../packages/shared/src/terminal/runtime/session.ts)
  添加可选 `programStatus`，包含 `state`、`source`、`observedAt` 和可选 `kind`。
  复用现有快照和更新事件，相同状态不重复广播。Web 与 Electron 首先复用
  [终端标签页](../../frontend/src/components/terminal/session/session-tab.tsx) 呈现。

### 2. 真实 Claude 验证握手后接入

- Claude Code 2.1.295 已支持 OSC。隔离实验中，tmux 3.6a 对设备属性查询的应答在 0.2–0.3 ms 到达，
  本地 OSC 应答在 13.6–512.3 ms 到达。以 1 ms 轮询也未改变先后顺序。真实 Claude 2.1.319 的隔离启动
  确认它在 OSC 探针后紧接发送设备属性查询，尚未验证登录后完整轮次。
- 先在真实 tmux 链路确认 Claude 能否收到能力应答并继续报告状态。程序发起查询，可靠应答必须由同一终端
  的响应所有者发回。有需要时在负责处理设备属性的终端层验证统一应答。单独缩短文件轮询没有改变应答先后关系。
  在真实 Claude 的三轮请求中确认有有效报告后，再启用这条 OSC 路径。其余组合使用 Hook。
  见 [Claude Code 发布说明](https://github.com/anthropics/claude-code/releases/tag/v2.1.295) 和
  [OSC 7501 能力探测](https://www.superlogical.com/rex/docs/build/program-status#feature-detection)。

### 3. 分别扩展直连 PTY、Windows 和原生 iOS

- 直连 PTY 在 [PTY runtime](../../backend/src/terminal/runtime/pty-service.ts) 的实时输出接入。
  非 tmux 的 [默认 Panel](../../backend/src/terminal/application/panel-workspace.ts) 由 API 临时构造，
  因此状态以真实终端会话及 runtime 实例归属，默认 Panel 和会话摘要读取同一份投影。
- Windows 使用 [独立 PTY Host](../../packages/pty-host/src/sessions.ts) 和真实 ConPTY。
  Host 的 shell PID 或代次只能标识宿主会话。另核对实际前台 CLI 的进程与创建时间，在同一个 shell
  退出并重新启动 CLI 时建立新绑定。识别不到当前 CLI 时继续用 Hook。仅在真实 ConPTY 和真实 Codex
  都取证通过后开启该路径。
- iOS 按同一可选 DTO 更新 [状态徽标](../../packages/app-ios/Sources/RunweaveIOS/Features/Terminal/TerminalStatusBadge.swift)，
  复用 [现有事件刷新](../../packages/app-ios/Sources/RunweaveIOS/State/TerminalOverviewEvents.swift)。
  响应缺少新字段时继续读取 `TerminalState`。

## 验收与交付

- [运行时验证](../testing/terminal/runtime/osc-7501-transport.testplan.yaml) 覆盖正常分片、被动接收、历史输出、
  Claude 探测、直连 PTY 和 Windows。[状态与界面验证](../testing/terminal/runtime/osc-7501-status.testplan.yaml)
  覆盖 Full Access 成功与失败、手动启动、Hook 兜底、同轮结束、多 Panel、桌面与手机。
- 第一阶段执行 OSCT-001 至 OSCT-003、OSCS-001 至 OSCS-007。Claude 执行 OSCT-004、OSCS-008。
  直连和 Windows 分别执行 OSCT-005、OSCT-006。iOS 执行 OSCS-009。
  每条发布路径记录实际 CLI、运行时和客户端版本，必须用该路径的真实结果验收。
- 健康本地链路连续三轮记录时间线，目标为状态帧到 Backend 快照 1 秒内、到可见界面 2 秒内。
  错误场景使用真实 Codex 配本地受控服务，和真实模型请求分别标记。
  实现阶段运行相关包的类型检查、`pnpm architecture:check`、`pnpm docs:check` 和 YAML 校验。
  修改 Host 时另按包规则运行 typecheck、lint 与现有真实进程验证。
