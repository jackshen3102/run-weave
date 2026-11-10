# Claude Code B：跨端输入、设置与任务交互

日期：2026-11-10。状态：待实施。前置：[A 基础接入出口](./2026-11-10-claude-code-foundation.md)通过。
权限与并发交互按 L3，其余按 L2。总体边界见[父计划](./2026-11-10-claude-code-parity.md)。

## 用户结果与边界

桌面/Web/原生 iOS 用户可以向原 Claude 任务发送图文、排队后续消息、选择受支持的模型设置、回答问题或处理权限，
并能精确分叉及打开独立旁聊。所有动作给出原任务实际采用的回执；待处理、已保存、已投递、已采用、结果未知分别表达。
不新增同目的旁路终端，不替换正在运行的任务，不默认放开权限或改变全局 Claude 设置。

## B1：输入队列、斜杠命令与附件

文件落点：`backend/src/terminal/application/input-dispatcher.ts`、`runtime/agent-adapters.ts`、`runtime/input-admission.ts`、
`backend/src/terminal/attachments/`、`frontend/src/features/terminal/input/{floating-composer,rich-paste,text-attachments}.ts`、
`packages/app-ios/Sources/RunweaveIOS/State/AppSession+Input.swift` 与 `Features/Terminal/TerminalScreen.swift`。

- [ ] 用 A0 真实 TUI 核实换行、粘贴、提交、队列、取消及 slash command 的语义；按 Claude 原生键位实现，不能套 Codex Tab 或清行策略。
      自定义键位无法安全确认时能力降级，保留草稿和原终端手动操作。
- [ ] 多行旧草稿、光标中间、中文/emoji、长文本与图文混排都必须逐字只送一次。客户端草稿只在明确接受后清除，
      未知结果保留并提示核对，不自动重发。
- [ ] Claude 忙碌时仅使用已验证队列或现有有界排队机制；不能把后续输入变为 shell 命令或提前中断主任务。
      draft、附件、问答和队列沿用同一目标与投递 lease，互不消费对方内容。
- [ ] 图片/文件交付使用执行该 Backend 可访问的真实路径或原生输入；本机、远端 Backend 分别确认文件归属。
      图片由真实模型读取唯一 marker 才算通过，上传返回 200 不等于 Agent 已采用。

## B2：模型目录、默认配置与当前会话设置

文件落点：`packages/shared/src/agent-model-catalog.ts`、`terminal/agent-settings.ts`、`configuration/{types,fields}.ts`，
`backend/src/agent-model-catalog/claude.ts`（新增）、`service.ts`、`backend/src/terminal/runtime/terminal-agent-settings.ts`，
Web `features/agent-models/`、`features/configuration/model-setting.tsx`，iOS `Contracts/` 与 `Features/Terminal/Input/TerminalAgentSettingsModel.swift`。

- [ ] 目录来自已验证的 CLI/账号/网关能力；允许原生别名和自定义模型 ID，不在产品中硬编码某一代 Opus/Sonnet/Haiku。
      各模型 effort、上下文和其他选项按实际支持返回；认证失效与不支持选项分别提示。
- [ ] 新会话默认值明确标注作用于后续启动，不修改活跃进程。当前会话即时设置只有在原生读回已验证后才返回 available。
      禁止利用 Codex app-server RPC 读取或写 Claude 状态。
- [ ] 现有 GET/PUT `/api/terminal/session/:id/agent-settings` 增加 Claude adapter；保留 panel/thread/revision 乐观校验。
      读回确认前不更新 UI 为生效；不支持实时修改时仅开放下次启动设置，并保留“实时设置未对齐”缺口。
- [ ] 并发输入、切换 panel、换 session 或 revision 过期返回 409；输入非法返回 400；执行后未确认返回 504/settings_unconfirmed，
      已执行结果不自动重试。模型探测暂不可用沿用 unavailable，缓存不能作为敏感写操作依据。

## B3：手机问题、权限与计划确认闭环

文件落点：`packages/shared/src/terminal/questions.ts`、`backend/src/terminal/questions/{service,gateway}.ts`、
新增 `backend/src/terminal/questions/claude-hook-gateway.ts`，`backend/src/routes/terminal/questions.ts`，
`packages/agent-bridge/hooks/`，iOS `Contracts/TerminalQuestions.swift`、`State/TerminalQuestionsModel.swift`、
`Features/Terminal/CodexReplyAssistant.swift`，新增 Web `frontend/src/features/terminal/questions/` 以消费同一合同。

- [ ] 将服务内 Codex transport 分离为静态 adapter，保留旧 adapter 的执行归属和断开行为；Claude 使用经 A0 验证的原生阻塞 Hook 回传。
      `Notification` 仅做提醒，不能伪造待答问题，也不能替代真实 permission request。
- [ ] 扩展现有请求为带 `kind=question | permission | plan` 的可选判别字段；旧请求无 kind 仍为 question。
      permission/plan 只在客户端声明支持相应协议时返回，旧客户端显示回原终端处理，不将允许/拒绝伪装成普通文本选项。
- [ ] 继续使用现有 GET questions 与 POST answer；新增 Claude 内部受 Hook token 鉴权的注册/等待/结果通道，
      不向 App 暴露原生 tool_use_id 作为可任意调用的执行句柄。内部实现不接受任意命令或文件路径执行。
- [ ] 每个请求生成不可复用 requestId，绑定 generation、provider、terminal/panel、session、operation 与 hook nonce。
      AskUserQuestion 返回完整原 questions 与 answers；permission 仅允许用户选择的一次性 allow/deny；
      plan 的接受按原生 schema 处理。永久规则和模式升级本批不提供，仍在原 CLI 完成。
- [ ] pending → submitting → resolved/expired；同一 operationId 同内容幂等，冲突或旧 generation 返回 409。
      手机只提交给还在等待的原 Hook；不能执行新 turn、queue 输入或 fork 来补答案。
- [ ] 用户等待上限沿用当前原生 Hook timeout 且最多 300 秒；超时、Hook 进程退出、session 切换或连接代次变化使请求失效。
      未成功交付时不自动 allow；原生仍能呈现交互时退回 CLI，否则明确取消/拒绝，按 A0 验证结果实现。
- [ ] 电脑先处理即失效，手机先提交也需等待原执行者确认。网络断开或提交结果未知时保留草稿并禁用重复投递；
      重连重新取得 fresh target，不自动重放旧答案。只读客户端不能回答权限问题。

新增传输合同按以下边界实现，路径为计划中的新增接口，不是现有 API：

| 接口                                                       | 输入与输出                                                                                                                                   | 校验/失败                                                                                                    |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| `POST /internal/terminal/claude-requests`                  | Hook 提交 terminalSessionId、panelId、sessionId、operationId、kind、原生工具输入与事件身份；返回 requestId、generation、hookNonce、expiresAt | 使用现有 Hook token，并核对当前 pane 进程/代次；不接收任意执行命令。输入错误 400，认证错误 401，过期归属 409 |
| `GET /internal/terminal/claude-requests/:requestId/result` | 原 Hook 使用 token 与私有 nonce 有界等待；pending 或一次性 decision，随后由原生 Hook 按原生 schema 返回                                      | 每次等待至多 25 秒，总期限不超过 300 秒；超时返回 expired，nonce 不匹配拒绝；nonce 不进入 App 响应和日志     |
| `DELETE /internal/terminal/claude-requests/:requestId`     | 原 Hook 主动撤销自己的等待                                                                                                                   | 幂等失效；不能撤销其他 owner 的请求，Backend 退出使本代所有请求失效                                          |
| 既有公开 GET questions / POST answer                       | 新客户端声明 `X-Runweave-Question-Protocol: 2`；请求携带 kind，保留 generation、thread/turn/item 与 operationId                              | question 沿用 answers；permission/plan 使用判别分支的 `decision: allow                                       | deny`，不接收原生权限规则；无声明客户端不返回新种类 |

公开的 resolved 仍表示原生请求已经处理；不能只因手机 POST 已接收就声称手机决定获胜。
内部 Hook 的结果已发出但采用未知时保留不确定状态，不对另一个 Hook 或新代次重发。

## B4：fork、恢复与独立旁聊

文件落点：`backend/src/terminal/application/agent-fork.ts`、`packages/shared/src/terminal/agent-fork.ts`、
`backend/src/side-chat/provider.ts` 及新增 Claude adapter，Web `features/side-chat/`、`features/terminal/use-fork-agent.ts`，
iOS `Features/Terminal/` 和旁聊对应合同。

- [ ] fork 复用现有 target/revision 与 operation 幂等合同；使用精确 session 的原生 `--fork-session`，
      确认新 ID、原 ID 不变、历史分支与原 cwd。候选 shell 启动成功不能当作 fork 已完成。
- [ ] 旁聊使用独立 Claude 执行进程和新 session；上下文只来自显式选择的既有内容，不自动续做主任务。
      清理继承的主终端 Hook 身份、凭据引用与执行关联，旁聊事件不得更新主面板状态或触发其 completion。
- [ ] 落实已有旁聊的项目只读、禁止网络和工具边界；`plan`/`allowedTools` 不自动等价 OS 隔离。
      平台无法落实边界时不启用旁聊，并记录该平台尚未对齐，不能退化为 full-access。
- [ ] 旁聊关闭/取消只回收自己拥有的进程；结果未知时提示核对。恢复、fork、旁聊均不删除原生源会话。

## B5：Skills、MCP 与可调用工具

文件落点：A 中的 Toolkit 同步、`plugins/toolkit/skills/`、`.agents/plugins/marketplace.json`、
Claude 新 manifest、仓库根的 Claude 指令入口（新增时遵循文档治理）及相关 CLI 文档。

- [ ] 同源分发技能内容，审计每个对外能力的 Codex 专属参数、工具名与模型假设；特有能力明确 provider 分支。
      不把 Codex 宿主自带的 Browser/Computer Use 自动宣称为 Claude 已有工具。
- [ ] Claude 的项目指令入口引用仓库 AGENTS.md，不复制一套易漂移的规则；验证根及就近规则真实加载。
      自动安装不得改写用户其他项目的 CLAUDE.md 或设置。
- [ ] 选取 rw 只读查询、浏览器真实只读操作、iOS 模拟器只读检查分别做真实工具调用；
      依赖 MCP/CLI 的能力显式配置并验证鉴权，技能能被发现与工具能执行分别取证。

## 验证、兼容与回滚

执行 [B 验收计划](../testing/terminal/claude-code-interaction.testplan.yaml)；复用既有
[手机问答](../testing/app/ios-terminal-questions.testplan.yaml)、[模型设置](../testing/app/ios-terminal-agent-settings.testplan.yaml)、
[正文阅读](../testing/terminal/conversation-reader.testplan.yaml)中的公共行为。
按修改范围执行 frontend/backend/shared/cli typecheck/lint 与架构检查；iOS 按包入口构建，再单独执行原生交互。

浏览器与 iOS 分别使用专属技能，不能用一个端的 HTTP 通过替代另一个端的 UI 验收。
优先验证原生模拟器；DEV 真机安装与运行按后续授权执行并单列证据。旧 Backend/客户端缺少新能力时保留原终端操作，
问答、设置、fork 入口不能乐观展示。回滚关闭新增入口并使未完成 Hook 请求按已验证失败策略退出，不修改默认权限或原会话。
