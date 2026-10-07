# 当前终端的任务监控

监控开关绑定 `terminalSessionId`，不绑定 thread。当前终端有 Agent TUI 即可开启；启动方式、Agent provider、版本、专用监督 Hook、对话是否已经产生、历史是否暂时可读都不是开启条件。切换对话、恢复会话、重新启动 Agent 和 Backend 重启保留终端的开关。

## 事件与处理

所有终端沿用现有 Hook、App Server 事件中心、终端状态和完成通知链路。监控服务订阅同一条完成流，也消费现有 App Server consumer 交付的 Hook、completion 和已有原生生命周期完成事件；开关只过滤后台业务处理，不控制采集。

普通事件更新等待状态、取消过期计算。主任务的最终回复事件触发独立 Codex 三分类：completed、blocked、continue。commentary、工具输出、SubagentStop 和静默不触发分类。完整回答从事件所指的原会话读取，不把通知摘要当完整报告；会话暂不可读时显示处理异常，开关保持开启。

当前会话 Agent 按原有任务授权执行；监控是附加的进展问询，不执行原任务，也不要求当前会话创建或联系其他 Agent。分类 Agent 只判断原任务、计划、用户范围修改及当前会话的报告，不独立执行或验收。评分表示三个选项的相对倾向，不是统计正确率；并列优先 continue、blocked、completed。

疑似缺陷必须先复现、再解决；未复现不得修改代码，需说明尝试条件、结果和信息缺口，没有新线索时不重复相同尝试。该前提不阻碍正常功能实现。未复现不代表已解决：原任务要求解决的问题仍按剩余义务和有效下一步判断；范围外疑点不增加任务义务。监控提醒只问询完成项、剩余项、复现与验收情况及阻塞，不构成新增任务、修复授权或直接执行指令。

## 终端开关与回复身份

`TaskWatch.enabled` 是终端开关；`target` 只是最近一次处理的回复身份。服务按终端查找监听，不用 thread 决定是否启用。收到新 thread 的回复后，读取该会话自己的任务和上下文，不沿用旧会话的目标。

分类和投递期间仍核对 terminal、panel、thread、现有执行器代次、监控 revision 及用户输入 revision。身份变化或用户新输入使旧续接失效，但不关闭终端开关。续接固定发往产生该回复的原面板，不随 UI 焦点改变。

## 结果与续接

| 结果 / 操作          | 行为                                                                                                                               |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| completed            | 记录本轮完成，继续监听此终端后续回复                                                                                               |
| blocked              | 记录需要用户处理，继续监听；不代审批                                                                                               |
| continue             | 任务在现有授权内仍有有效下一步或需要状态澄清时，先持久化判定和额度，再向原面板当前会话发送进展问询；不直接要求执行或创建其他 Agent |
| 当前任务已续接 3 次  | 保持开关开启，暂停本任务自动续接；用户新输入或新会话开始新的处理轮次                                                               |
| 用户关闭开关         | 停止处理、取消待分类；事件仍照常采集                                                                                               |
| 历史、模型或投递失败 | 显示运行时错误；不增加入口限制，不创建替代执行任务                                                                                 |

续接带唯一 decisionId。已写入终端不等于原会话已消费；原会话出现对应监督输入才标记 observed。无法确认时保留额度和 unknown，不自动重放。关闭或重启 Backend 不补发旧事件、旧指令。

普通终端输入按实际 tmux 面板保持草稿保护；元数据与状态事件不能清除这一标记。回复仍可分类，但原面板有未提交输入时不投递、不扣续接额度。新的普通 UserPromptSubmit 只清除对应面板的保护；其他面板提交及监督追问不会清除该草稿的保护。

投递超时仅暂停同一 thread、同一处理轮次的监控，不重放追问。原会话迟到确认对应 decisionId 后，该轮自动解除 delivery_unknown；手动关闭仍保持关闭。新任务使用新的 contextRevision，历史 unknown 记录保留供核对，但不能再次暂停新任务。

任务上下文读取原始用户任务、后续范围修改、相关对话、完整 final 及对话引用的 `docs/plans/`、`docs/testing/` 文件。计划限定在当前项目 realpath 内，最多 10 个引用。输入上限 180,000 UTF-8 字节；只减少最近对话，不能截断原目标、用户范围修改、计划和当前回答。

## 入口与配置

- 共享协议：[task-supervision.ts](../../packages/shared/src/task-supervision.ts)
- 开关与处理：[service.ts](../../backend/src/task-supervision/service.ts)
- 事件适配：[events.ts](../../backend/src/task-supervision/events.ts)
- 现有事件消费：[integration.ts](../../backend/src/app-server/integration.ts)
- 原终端投递：[terminal-task-monitoring.ts](../../backend/src/bootstrap/terminal-task-monitoring.ts)
- 原生 iOS：[TaskSupervisionSheet.swift](../../packages/app-ios/Sources/RunweaveIOS/Features/Terminal/TaskSupervision/TaskSupervisionSheet.swift)，终端菜单与已开启状态条进入，详情内容复用同一 API；生命周期见 [iOS 架构](../../packages/app-ios/docs/architecture.md#终端长任务监控)。
- Web / Electron：[status-strip.tsx](../../frontend/src/components/terminal/task-supervision/status-strip.tsx) 在已开启终端的顶部显示状态与续接额度，点击打开 [panel.tsx](../../frontend/src/components/terminal/task-supervision/panel.tsx)。状态条与详情共享按连接和终端隔离的查询缓存；前台每 5 秒同步，关闭详情仍同步，关闭监控后隐藏状态条。

`backend.taskSupervision.model` 和 `classificationTimeoutMs` 配置分类模型及时间预算。历史 `backend.taskSupervision.enabled` 字段不再作为开启条件；实际开关由终端监听记录保存。旧 `/internal/task-supervision` 请求兼容返回 allow-stop，不再承担分类或续接，避免重复处理。

受现有认证保护的 `/api/task-supervision` 提供终端发现、开启、查询和 pause / resume / update-context。发现时返回当前终端的开关和当前可见回复身份；没有 Agent 时仍返回已有监听状态，允许关闭。开启不要求手工选择任务起点或填目标，收到回复后从原会话取得上下文。
