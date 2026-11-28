# 现有终端的手机结构化问答

手机在现有 Codex 终端的“回复辅助”里查看并回答原任务的问题。答案写入原执行服务的
JSON-RPC 请求，不创建新任务，不调用终端输入、排队、thread/start 或 turn/start。

## 当前支持边界

首版支持 macOS 上明确使用 `codex --remote unix:///绝对路径` 的终端。Backend 通过
原 tmux pane 的进程后代与原生 argv 确认 socket；端点不由 HTTP 客户端传入。
面板必须已有 Codex thread 归属，线程必须已经加载在该执行服务中，才能重接同一 thread。
仅共享执行服务的待答请求被展示；历史 Agent 摘要不是问题来源。

普通本地、默认 daemon、旧版本、远端 SSH、无法识别的启动包装或 socket 路径不支持时，
保留原终端的手动回复流程。不会自动启用、重启全局 daemon 或迁移任务。路径包含空白、
冒号、百分号、查询或片段字符时暂不接入。当前进程 argv 读取依赖 macOS 原生 resource-sampler。

连接只借用原服务，不取得任务或 daemon 的关闭权。断开连接和 Backend 退出只释放自己的
WebSocket；不接受或拒绝其他审批，也不改变模型、模式、工具、网络或权限配置。

## 协议与状态

[共享合同](../../packages/shared/src/terminal/questions.ts)与
[Swift DTO](../../packages/app-ios/Sources/RunweaveIOS/Contracts/TerminalQuestions.swift)对应。
登录与 tunnel 鉴权沿用现有终端路由。

- `GET /api/terminal/session/:id/questions?panelId=...` 返回能力、连接代次、原 terminal/panel/thread 及实时问题。
- `POST /api/terminal/session/:id/questions/:requestId/answer` 验证 panel、generation、thread、turn、item、operationId 及完整答案集合。
- 公共 requestId 与原始 RPC ID 仅由 Backend 映射。相同 operationId 和规范化答案只写一次，冲突或旧目标返回 409。
- 状态是 pending、submitting、resolved、expired。Codex 的 serverRequest/resolved 不带最终答案，也可能来自其他客户端或清理。
  resolved 只说明提交之后请求已解决；界面显示“问题已处理，请回原终端查看结果”，不证明手机答案获胜或任务成功。
- 电脑先处理、阻塞 turn 结束、原连接断开使问题失效。非阻塞问题不会仅因生成它的 turn 完成而失效。
- 投递结果未知时保留草稿并禁用重复提交，不自动重放。重连创建新代次与请求 ID，不能沿用旧答案。

[iOS 问题 model](../../packages/app-ios/Sources/RunweaveIOS/State/TerminalQuestionsModel.swift)
按连接代次、terminal、panel、问题连接代次和 requestId 保存内存草稿；关闭再打开同一问题可恢复。
切换 Backend 或退出登录清空问题草稿，迟到请求不会更新新页面。问题草稿不写入终端草稿、
附件或队列。收到正式的问题后按 panel/thread 保持绑定，原任务 turn 的正常推进不会使页面误失效。

## iPhone 待答与待确认通知

推送链路复用 `terminal-question`（`terminal.question`）订阅与 UUID 引用定位，同时覆盖两类终端确认形态：

1. **共享执行服务结构化问答（`codex --remote unix:///绝对路径`）**：受鉴权的 Codex `PreToolUse(request_user_input)` 上报 thread、turn 和工具调用 ID 后，Backend 在后台最多等待 5 秒确认原执行服务仍有对应待答请求，发送「Codex 等你回答」；手机点击后在回复辅助表单内直接作答。
2. **原终端直达待确认提醒（`terminalOnly: true`）**：当终端无共享执行服务或来自其他结构化门禁——包括普通/受管 Codex 的 `request_user_input` 与 `Notification(permission_prompt)`、主进程 AGY 的 `ask_question`、主进程 Claude 的 `AskUserQuestion` 与 `PermissionRequest`、Pi 的 `ui_prompt_start`、Trae 的等待通知，以及面板/会话的 OSC 7501 `blocked`（`question | permission | auth`）——Backend 经过短暂稳定窗（Hook 250ms、OSC 500ms）确认会话仍在等待后，按 `(terminalId, panelId)` 优先级合并去重（结构化问答 > 提问工具 > 权限/UI 门禁 > OSC 7501 > 通用通知），每个已确认安装最多投递一份通用安全文案通知（不携带命令全文、路径或问题正文）。扩展元数据保存在顶层可选 `terminalQuestionPrompts`，保持 `terminalQuestions` 条目与旧版 Backend 回滚兼容。

后续 `ToolCompleted`、`UserPromptSubmit`、`Stop`、Claude `Notification(idle_prompt)`、Pi 提示结束、OSC 退出 `blocked` 或终端退出/删除会将对应定位标记为 `resolved` 或 `closed`，未外发的待发记录自动取消。

iOS 通过 `questions=1` 协商 `terminal-question` 订阅。点击通知先选择来源电脑，再用当前安装的 `X-Runweave-Installation-ID` 调用 `GET /api/terminal/questions/notifications/:questionRef`。只有绑定该安装的已授权登录能读取定位，定位在 15 分钟后结束：

- 结构化 `pending` 打开回复辅助表单；表单内提交后在当前弹层展示「问题已处理」；
- 仍处于等待态的 `terminalOnly` 定位，以及点击时已在电脑端处理或已结束（`closed`）的通知，均自动聚焦目标 `panelId`、直接打开原终端并收起中转弹层（仅当原终端已被删除无法打开时保留「问题已处理」/「问题已结束」兜底页；旧版 iOS 对 `terminalOnly` 降级展示「回原终端查看」按钮，不发生解码错误）；
- 断线不可达时保留「暂时无法核对」与「重新检查」。

部署依次更新 Push Gateway、Backend 和 iOS。回滚前在 Backend 将
`services.terminalQuestionNotifications.enabled` 改为 `false` 并重载配置。待答订阅与既有订阅在磁盘上
各自存储，旧版 Backend 可以读取既有订阅并保留待答数据供升级后使用。已发通知仍通过读取接口核对，
响应不可用时 iOS 提供重新检查。模拟器用捕获网关编码的通知验收系统展示和原生跳转，实际 APNs
网络送达和真机策略需要单独验证。

如果早期候选版已经保存过待答订阅，先启动新版 Backend 完成存储迁移。曾配置
`services.pushSender.terminalQuestions` 的实例需移除早期字段，并使用独立的待答通知开关。

## 代码与验收入口

- [执行服务识别与领域校验](../../backend/src/terminal/questions/service.ts)
- [借用原连接的 gateway](../../backend/src/terminal/questions/gateway.ts)
- [待答通知定位与投递](../../backend/src/terminal/questions/notifications.ts)
- [终端 HTTP 装配](../../backend/src/routes/terminal/questions.ts)
- [现有回复辅助](../../packages/app-ios/Sources/RunweaveIOS/Features/Terminal/CodexReplyAssistant.swift)
- [问答验收合同](../testing/app/ios-terminal-questions.testplan.yaml)；历史降级对应
  [IOSFEATURE-016 至 019](../testing/app/ios-native-features.testplan.yaml)。

完整矩阵还包括双 Backend、切换 panel、电脑手机竞争、断线，以及原草稿/附件/队列共存。
协议闭环、安装和 UI 操作分别取证；构建或 HTTP 接收成功不等于这些用例全部通过。
