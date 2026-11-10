# Claude Code 对齐 Runweave Codex 集成能力

日期：2026-11-10。状态：部分实施，A 出口未通过，B/C 未实施。代码基线：`fc8d76b8b656a1a093f4b985995d57156a542631`。
本文是临时实施计划，不代表能力已实现；完成后将有效合同迁入架构、CLI、部署文档，再删除过程材料。

## 目标与范围

按本次上下文，将“CodeDesk”理解为 Codex CLI。目标是让 Claude Code 成为 Runweave 的一等 Agent：
在桌面、Web、原生 iOS 与 rw 中，能够启动、识别、输入、阅读、恢复和处理交互；随后作为后台执行与内部 Agent 的可选 provider。
对齐的是用户可完成的工作及其可信回执，权限、命令、模型与会话协议沿用 Claude 原生语义。

最初规划阶段只编写计划和待执行验收合同；用户后续授权在本计划所在 worktree 实施。
当前实施保留 Codex、Trae、Pi 的行为与用户现有配置，不改变默认 provider，不自动迁移进行中的任务；
未安装插件、修改个人配置、发送通知、更新正式客户端、提交或发布。
Windows、Linux、macOS 的交付范围按真实证据分别报告；不得将 macOS 本机通过扩写为所有平台通过。

## 已复核的现状

| 事实                                                                                      | 当前证据入口                                                                                                                                                                                                                | 实施含义                                                     |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 本机 `claude --version` 为 2.1.319，`claude auth status --json` 报告已登录                | 本轮只读命令；未发模型请求                                                                                                                                                                                                  | 可做本机真实协议验证；认证有效不证明模型、网关或任务执行成功 |
| 本机用户设置已有 8 类含 Runweave 标记的 Hooks，启用插件列表未出现 Toolkit                 | 只输出设置键、事件数量、插件名称，未读取输出凭据值                                                                                                                                                                          | 必须检查旧配置归属、迁移与去重，不能简单追加                 |
| Claude Hook 安装器存在，但 `installAllHooks()` 明确未调用                                 | [安装器](../../electron/src/hooks/hook-installer.ts)                                                                                                                                                                        | 恢复调用前先完成身份、状态和来源门禁                         |
| App Server 事件 source 已接受 Claude；Terminal Agent 枚举、prepare 和完成门禁尚未完整接入 | [Terminal 状态](../../packages/shared/src/terminal/runtime/state.ts)、[准备合同](../../packages/shared/src/terminal/runtime/agent-preparation.ts)、[来源门禁](../../backend/src/terminal/completion/source-gate.ts)         | 区分接线问题与新增能力，统一 provider 身份                   |
| Claude 正文与预览明确为 unsupported                                                       | [正文 reader](../../app-server/src/agents/conversation-reader.ts)、[预览](../../app-server/src/agents/thread-previews.ts)                                                                                                   | 新增受控原生记录适配，不能用终端滚屏替代                     |
| 通用恢复参数默认使用 `resume ID`                                                          | [恢复参数](../../packages/shared/src/terminal/agent-resume.ts)                                                                                                                                                              | Claude 必须改为原生 `--resume ID`，并验证恢复身份            |
| 模型目录/终端模型设置仅覆盖 Codex、TraeX                                                  | [目录](../../backend/src/agent-model-catalog/service.ts)、[设置](../../backend/src/terminal/runtime/terminal-agent-settings.ts)                                                                                             | 增加 Claude adapter，并区分新启动默认值与当前进程设置        |
| 问答、fork、旁聊、任务控制包含 Codex 专属实现                                             | [问答](../../backend/src/terminal/questions/service.ts)、[fork](../../backend/src/terminal/application/agent-fork.ts)、[旁聊](../../backend/src/side-chat/provider.ts)、[任务](../../backend/src/terminal/tasks/service.ts) | 分项实现，不能扩枚举后宣称已对齐                             |
| 后台实际执行只有 Codex adapter                                                            | [后台能力探测](../../backend/src/scheduled-tasks/providers/capabilities.ts)                                                                                                                                                 | 新增 Claude 执行器，验证结果、取消与接管闭环                 |
| 日报与研究 MCP 已有 Claude 原生历史来源                                                   | [日报](../../packages/daily-record/src/native.ts)、[MCP 来源](../../packages/runweave-mcp/src/sources.ts)                                                                                                                   | 复用来源语义，分别验证，不能当作 App Server reader 已存在    |

## 实施拆分与依赖

| 批次            | 独立计划                                                                    | 出口                                                                        |
| --------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| A：基础接入，P0 | [协议、安装、状态与会话](./2026-11-10-claude-code-foundation.md)            | 新环境可安装；Claude 身份可信；状态、历史、精确恢复和单次提醒闭合           |
| B：日常使用，P1 | [输入、设置、手机交互与上下文操作](./2026-11-10-claude-code-interaction.md) | 电脑和手机可连续工作；问答回到原任务；队列、附件、设置和分叉可确认          |
| C：自动化，P2   | [后台任务与内部 Agent](./2026-11-10-claude-code-automation.md)              | Claude 可显式用于后台任务、Review、监控与内部服务，保留原安全及生命周期合同 |

执行顺序：A0 协议取证 → A1 身份/能力合同 → A2 安装与状态 → A3 原生记录和恢复 → B → C。
各批可以独立提交与验收；只有完成前置出口的功能才开放产品入口。某项上游协议不可用时明确记录能力缺口，
其他已通过模块可交付，但整项目不得标为“完全对齐”。本计划没有要求并行 Agent 或独立 Review Agent 执行。

## 统一合同

1. provider 使用 `claude`；原生 session ID 保留原值。所有读写同时核对 provider、Backend、terminal、panel、进程代次和 session，
   不以同名 UUID、最近会话或 `lastThreadId` 猜测当前任务。
2. 共享协议与纯 TS 类型进入 `packages/shared`；文件与进程控制留在 Backend/App Server；Swift DTO 对照合同。
3. 新增小型能力响应，复用静态 adapter 组合，不建立动态插件框架。拟新增 `GET /api/agent-capabilities`，沿用 Backend 登录鉴权。
   返回 provider、版本、可用性与逐项 capability；每项为 `available | unsupported | unavailable` 加非敏感 reason。
   区分上游不支持与探测/认证失败。全局能力不等同当前会话已就绪；敏感操作仍由目标接口重新校验。
4. 能力至少覆盖 prepare、conversation、resume、queue、attachments、liveSettings、questions、permissions、fork、sideChat、background。
   未验证项返回 unavailable，不乐观启用；旧 Backend 不返回新字段时客户端保留现有行为。
5. `Stop` 只表示一次原生响应结束；不等同业务成功。子 Agent、压缩、旁聊、重试、权限等待不结束主任务。
   状态、完成提醒、业务结果分别保存，双写或重连不能重复播放通知。
6. 不将 Codex 的 sandbox/auto-review/full-access 与 Claude 权限模式机械等同；每个自动化入口显示其实际执行策略。
   没有等价安全边界的能力保持不可用，不通过全局 bypass 补齐。
7. 用户的账号、API key、网关和原生配置继续由 Claude 管理。Runweave 只保存实例级引用及明确的产品设置，
   不复制凭据到 App、日志、验收附件或命令参数。

拟新增能力响应的最小形状如下；字段表示探测事实，不能代替操作时校验：

```ts
type CapabilityState = {
  status: "available" | "unsupported" | "unavailable";
  reason: string | null;
};
type AgentCapabilitiesResponse = {
  providers: Array<{
    provider: string; // 实现时收窄为仓库已有 provider 联合类型
    version: string | null;
    availability: CapabilityState;
    capabilities: Record<string, CapabilityState>; // key 收窄为上述能力集合
  }>;
};
```

## 验收合同与证据

新用例是未来实现的验收要求，当前未执行：

- A：[Claude 基础闭环](../testing/terminal/runtime/claude-code-foundation.testplan.yaml)。
- B：[Claude 跨端交互](../testing/terminal/claude-code-interaction.testplan.yaml)。
- C：[Claude 后台与内部 Agent](../testing/scheduled-tasks/claude-code-automation.testplan.yaml)。

复用既有计划的公共不变量：
[会话阅读](../testing/terminal/conversation-reader.testplan.yaml)、
[终端问答](../testing/app/ios-terminal-questions.testplan.yaml)、
[后台恢复](../testing/scheduled-tasks/runtime.testplan.yaml)、
[快捷指令](../testing/background-commands/core.testplan.yaml)、
[Review 生命周期](../testing/terminal/independent-code-review-lifecycle.testplan.yaml)。
执行 Claude 用例时不把这些文件中的 Codex 专属前置条件直接替换后冒充通过。

证据分层：源码与类型检查、受控协议 fixture、真实 Claude 请求、浏览器交互、iOS 模拟器、DEV 真机、安装态/平台分别记录。
运行时证据必须带代码/插件版本、目标 Backend、panel/session 与采集时间，凭据脱敏。
浏览器使用 toolkit:playwright-cli；Dev Session 使用 toolkit:runweave-dev-session；iOS 交互使用 toolkit:agent-device 和共享设备池。
通知使用本例测试 sink；不向用户联系人发测试消息。设备安装、正式客户端更新与 npm 发布分别按后续授权执行。

## 兼容、回滚与完成条件

- 协议只增加可选字段和 provider 分支；逐项核对 TS、Swift、持久化校验及旧客户端反序列化。
- Hook 配置按受管标记迁移，先备份、原子写、幂等安装；无法解析时保留原文件并报告，禁止覆盖全部用户配置。
- 不写入或改造 Claude 原生 transcript；Runweave 自有索引可重建。失败与未知执行结果不自动重放。
- 回滚先停止新建 Claude 托管任务并处理现有 owner，再关闭相关能力入口；只移除本次受管资产，保留原会话和第三方插件。
- A/B/C 必需用例均有实际 verdict、原有 provider 针对性回归通过、交付平台矩阵有证据，才可报告对应范围对齐。
  未证实的当前模型写回、隔离策略或官方配额来源列为明确缺口，不用保存成功、模拟结果或静态检查消除缺口。
- 完成实现时同步修正文档里“Claude Hooks 自动安装”等与源码不符的旧描述，不将本计划提升为当前事实。

## 实施记录（2026-11-10，尚未完成）

工作目录为 `.worktree/agent-team-2`，保留原有未跟踪计划、验收 YAML 和截图。

| 范围 | 已落地                                                                                                                                    | 尚未完成                                                                         |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| A0   | macOS 原生 CLI 2.1.319 的登录、真实只读 marker、精确 resume、fork 新身份、stream-json 和 schema 输出已采集                                | TUI 输入、压缩、子 Agent、权限/问题、Stop 被阻塞后的 settled 证据不齐            |
| A1   | Claude provider 身份、`--resume` 参数语法、实例配置引用、登录鉴权能力 API、固定 reason 与有界探测                                         | prepare/当前代次就绪尚未接通；11 项 Claude 产品能力仍 unavailable                |
| A2   | 去掉 Claude 借认 Codex 的兼容推断；新 bridge 不发 Claude 完成或 attention 通知；Backend 拒绝旧 Claude 状态/完成写入；App Server 不猜 idle | 插件 manifest、受管迁移/安装、可信进程代次绑定、完整生命周期与单次完成闭环未实现 |
| A3   | App Server 原生 reader/preview/detail、Backend 正文路由；安全源定位、分支、partial、边界和只读校验                                        | 新启动的可信会话绑定、受管恢复、真实压缩和 UI/iOS 阅读验收未完成                 |
| B/C  | 无产品实现，入口未开放                                                                                                                    | 仍按两份子计划执行，不因原生 CLI smoke 通过而提前开放                            |

真实 CLI 探测仅使用独立临时项目和测试 sink，清除继承的 Runweave/tmux 身份，保持原生认证与
用户当前模型/网关设置，不加载用户 Hook、插件或 MCP。一次未沿用用户模型选择的对照探测虽
返回 exit 0/result success，正文却是限流提示，**不计成功**。纠正模型选择后 marker 精确匹配；
resume 保持原 ID，fork 返回新 ID 并保留 marker，schema 的 `structured_output` 实际匹配。
这些是 macOS 原生 CLI 证据，不是 Runweave 受管恢复、手机或后台任务证据。

reader 真实验证只读取本例启动/resume/fork transcript 的临时副本；源哈希不变，分别读出
2 轮/4 条和 3 轮/6 条稳定 UUID 消息。2.1.319 的 attachment 中间图节点与
`last-prompt.leafUuid` 已据此修正；不保存原始 transcript、系统提示或 thinking 到仓库。
压缩、源替换和大小边界使用脱敏 fixture；不把 fixture 结果当作真实模型压缩验收。
受控 Stop-block 探测的执行因本会话安全判定服务超时被阻断，未执行、不计通过。

已执行 `agents:build`、`toolkit:verify-hooks`、`app-server:verify-state-sync`、`app-server:verify`，
以及 Backend/shared/config-node/App Server 和现有 Web/CLI/Electron 类型检查。
Hook 校验还覆盖实际 HTTP 鉴权、Claude 旧 Hook 不改状态/不产生完成，以及既有 provider 回归。
`backend:verify-lifecycle` 未通过：清除继承 worker/SQLite 覆盖后仍在
`scripts/verify/backend/hosted-terminal-loss.ts:117` 的 `/HOST_SESSION_GONE/` 预期拒绝断言失败；
未修改该子系统，不将其记录为通过。

所有 required 用例尚无完整实际 verdict，故 A/B/C 均不得标为已对齐。浏览器、iOS、安装态、
Linux、Windows 未验收；没有安装/更新任何客户端。后续从 A0 缺失协议证据与 A2 代次身份开始，
不要直接把能力接口的 unavailable 改成 available。当前有效合同已同步至
[配置与能力](../cli/configuration.md#claude-code-原生引用与能力)、
[会话 reader](../architecture/terminal-code-preview.md)、
[状态边界](../architecture/terminal-state.md#运行限制)和
[Hook 安装与门禁](../architecture/terminal-completion-hooks.md#hook-安装与上报行为)。

## 本轮文档检查

运行三份 YAML 的 `pnpm testplan:validate <path>` 与 `pnpm docs:check`。
格式检查只证明计划可解析、链接有效，不证明上述功能已实现或验收通过。

## 上游依据

- [Claude Hooks](https://code.claude.com/docs/en/hooks)：以现场安装版本复核事件、子 Agent、阻塞回传与退出语义。
- [CLI 参数](https://code.claude.com/docs/en/cli-reference)：精确恢复、fork、结构化流与输出 schema。
- [配置作用域](https://code.claude.com/docs/en/settings)：用户、项目、会话与受管设置的优先级。
- [插件布局](https://code.claude.com/docs/en/plugins-reference)：Claude manifest、资源路径和更新边界。
