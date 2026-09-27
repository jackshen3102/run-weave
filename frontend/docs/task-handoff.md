# 普通终端任务交接

入口：终端右侧工具区的“任务交接”。首版整理普通 Codex 会话，按当前 Backend、终端、面板、Thread 隔离。

## 用户行为

卡片展示当前目标、已有结果、待处理事项和下一步。结果附带“查看记录”，区分会话报告与有配对工具请求/结果的执行记录；这些都不是整体任务验收证明。用户可编辑目标，并从“查看完整历史”进入 Work History。

“继续验收”仅在当前会话空闲且目标仍为同一 Codex Thread 时可用。发送前向终端输入控制器申请发送权；已有未发送草稿、输入状态不明或正在发送时拒绝覆盖。传递目标、剩余事项及有限证据摘录；结果未确认时不自动重发。退出 Agent 后可阅读已有历史，但不能向 Shell 发送交接指令。

## 数据与生命周期

- 首次打开目标后启动整理。Backend 对已关注目标消费完成事件，并周期检查原生历史；关闭面板后仍可增量更新。Backend 重启后重新打开即可恢复已保存卡片。
- 使用既有 App Server history gateway 读取原生轮次，补充 Activity 工具记录；不能只依赖 Activity 回复流。首版不支持 Team 专属面板。
- 按轮次增量分析，串行调用现有只读 Codex provider。需要本机 Codex CLI 及可用登录态；单次分析最长 90 秒，失败保留旧卡并提供刷新入口。
- 每批最多 4 个新轮次，单条消息最多 4000 字符，每轮最多选取 12 条消息，文本预算约 100000 字符。工具记录最多扫描 10 页；长内容、图片、过期记录和截断范围显示在“记录覆盖范围”。这是有界摘要，不是完整自动验收。
- 引用必须存在于分析输入。保存被引用的脱敏文本、原始记录标识和时间；不读取引用中的任意文件，也不把结果中的指令当授权。Activity 原件过期后归档摘录仍可查看。
- 结果保存于 Backend `browserProfileDir/task-handoff`，原子写入、权限 0600。编辑通过修订号处理冲突；更正目标后重新整理相关历史。Backend 关闭时停止定时检查、取消并等待分析。
- 整理内容是模型生成的建议性摘要。手工纠正的目标优先于更早的历史要求，后续明确的新用户要求仍可改变目标；不生成整体完成率，不自动启动下一步。

## 接口和代码

鉴权接口 `GET /api/task-handoff/:terminalSessionId`、`POST .../refresh`、`PATCH ...`。参数 `panelId` 绑定面板；PATCH 额外携带 `threadId`、`revision`、`goal`。旧终端输入接口新增可选 `expectedThreadId`，旧调用不受影响。

- [共享合同](../../packages/shared/src/task-handoff.ts)
- [Backend 服务](../../backend/src/task-handoff/service.ts)、[来源读取](../../backend/src/task-handoff/source.ts)、[分析](../../backend/src/task-handoff/analysis.ts)
- [Sidecar 面板](../src/components/terminal/handoff/panel.tsx)
- [输入保护](../src/features/terminal/input/handoff-guard.ts)

界面设计参考 [历史原型](../../docs/prototypes/terminal-task-handoff/README.md)，运行时行为以源码为准。
