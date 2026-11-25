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

## iPhone 待答通知

受鉴权的 Codex `PreToolUse` 经终端 Agent Hook 上报 thread、turn 和工具调用 ID。Backend 在后台最多等待
5 秒，确认所选面板的原执行服务仍有对应待答请求。每个已确认且保持登录的安装最多投递一份
`terminal.question`。通知只显示「Codex 等你回答」和通用提示，`terminal-question` 目标只携带 UUID 引用。
Backend 按原问题和安装持久化定位与投递状态。明确可重试时沿用原事件和载荷，结果未知时保留投递记录。
已确认的原生结束事件会写入定位记录，Codex 退出或 Backend 重启后仍可核对。

iOS 通过 `questions=1` 协商 `terminal-question` 订阅。点击通知先选择来源电脑，再用当前安装的
`X-Runweave-Installation-ID` 调用 `GET /api/terminal/questions/notifications/:questionRef`。
只有绑定该安装的已授权登录能读取定位。定位在 15 分钟后结束。连接重建时按原 thread、turn 和 item
重新核对，面板切换或连接不可用时可重新检查。答复沿用终端问答提交接口。提交状态未确认时保留草稿，
并暂停再次提交。

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
