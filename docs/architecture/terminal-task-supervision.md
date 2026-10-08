# 当前终端的任务监控

监控开关绑定 `terminalSessionId`，不绑定 thread。当前终端有 Agent TUI 即可开启；启动方式、Agent provider、版本、专用监督 Hook、对话是否已经产生、历史是否暂时可读都不是开启条件。切换对话、恢复会话、重新启动 Agent 和 Backend 重启保留终端的开关。

## 事件与处理

所有终端沿用现有 Hook、App Server 事件中心、终端状态和完成通知链路。监控服务订阅同一条完成流，也消费现有 App Server consumer 交付的 Hook、completion 和已有原生生命周期完成事件；开关只过滤后台业务处理，不控制采集。

普通事件更新等待状态、取消过期计算。主任务的最终回复事件触发独立 Codex 三分类：completed、blocked、continue。commentary、工具输出、SubagentStop 和静默不触发分类。完整回答从事件所指的原会话读取，不把通知摘要当完整报告；会话暂不可读时显示处理异常，开关保持开启。

当前会话 Agent 按原有任务授权执行；监控是附加的进展问询，不执行原任务，也不要求当前会话创建或联系其他 Agent。分类 Agent 只判断原任务、计划、用户范围修改及当前会话的报告，不独立执行或验收。评分表示三个选项的相对倾向，不是统计正确率；并列优先 continue、blocked、completed。

疑似缺陷必须先复现、再解决；未复现不得修改代码，需说明尝试条件、结果和信息缺口，没有新线索时不重复相同尝试。该前提不阻碍正常功能实现。未复现不代表已解决：原任务要求解决的问题仍按剩余义务和有效下一步判断；范围外疑点不增加任务义务。监控提醒只问询完成项、剩余项、复现与验收情况及阻塞，不构成新增任务、修复授权或直接执行指令。

## 终端开关与回复身份

`TaskWatch.enabled` 是终端开关；`target` 是当前任务的会话和执行器身份。服务按终端查找监听，不用 thread 决定是否启用。现有会话事件、查询和后台同步发现 thread / panel 变化时，立即清空目标、计划、结果、额度、等待状态和错误，并取消旧分类；历史判定保留。历史暂不可读或新会话尚无任务时显示等待新任务，不沿用旧目标。新会话首条真实用户消息自动成为任务起点，无需等待最终回复。

同一 thread 不识别独立新任务：后续真实用户输入作为原任务的范围修改，并开始新的处理轮次；按消息 ID 去重，Hook 与原生状态补偿不会重复重置额度。带监督标记的自动追问不改变处理轮次。执行器代次变化但 thread / panel 不变时，只取消旧计算和投递，不清空业务目标或额度。单纯清屏不改变会话身份，因此不重置任务。

Web 与 iOS 的当前判断、续接待确认提示按 thread 和 contextRevision 过滤；其他轮次保留在历史中，不能影响当前状态。当前目标仅展示有界原文摘录，完整交接文本和 JSON 可从“查看原始任务”读取；分类仍使用完整目标。

分类和投递期间仍核对 terminal、panel、thread、现有执行器代次、监控 revision 及用户输入 revision。身份变化或用户新输入使旧续接失效，但不关闭终端开关。续接固定发往产生该回复的原面板，不随 UI 焦点改变。

## 结果与续接

| 结果 / 操作          | 行为                                                                                                                               |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| completed            | 记录本轮完成，继续监听此终端后续回复                                                                                               |
| blocked              | 记录需要用户处理，继续监听；不代审批                                                                                               |
| continue             | 任务在现有授权内仍有有效下一步或需要状态澄清时，先持久化判定和额度，再向原面板当前会话发送进展问询；不直接要求执行或创建其他 Agent |
| 当前轮已续接 3 次    | 保持开关开启，暂停本轮自动续接；真实用户新输入重置本轮额度，新会话重置任务                                                         |
| 用户关闭开关         | 停止处理、取消待分类；事件仍照常采集                                                                                               |
| 历史、模型或投递失败 | 显示运行时错误；不增加入口限制，不创建替代执行任务                                                                                 |

续接带唯一 decisionId。已写入终端不等于原会话已消费；原会话出现对应监督输入才标记 observed。无法确认时保留额度和 unknown，不自动重放。关闭或重启 Backend 不补发旧事件、旧指令。

粘贴提交前先退出目标 tmux 面板的历史浏览模式，续接在退出后重新校验会话与输入版本，再发送完整监督标记和正文；否则 copy mode 会把粘贴内容当成导航按键，截断监督输入。

终端输入按实际 tmux 面板保持编辑保护。完整的滚轮控制序列和明确的终端回报不建立保护，也不撤销续接；混合或无法识别的输入、粘贴及可能调出历史草稿的按键保守地视为编辑。Esc / 中断撤销当前自动投递，但不能据此清空已有草稿标记。当前 Codex 接入无法读取真实输入框，因此保护表示“无法确认草稿状态”，不能宣称用户确实留有草稿，也不靠超时清除。

回复仍可分类，但草稿状态无法确认时不投递、不扣额度；判定保留为当前结果，`deliveryBlock=draft_unconfirmed` 单独说明未发送原因。普通 UserPromptSubmit 只清除对应已观察提交的编辑保护，提交后发生的新输入、其他面板输入及监督追问不受影响。日志记录面板、操作类别及保护设置/清除原因，不记录输入正文。

Web 和 iOS 提供“确认输入框为空并重试”。请求带当前判定 ID、监控 revision 与 discovery 返回的临时 inputVersion；Backend 重新核对原会话、最新用户消息和最终回复、Agent 空闲状态，再为同一未发送判定持久化额度和投递状态。新输入、会话变化、重复请求及已发送或接收未知的判定拒绝重放。确认只解除原面板保护，不清空实际输入框；旧版草稿拦截记录读取时迁移为相同的显式恢复状态，重启不会自动补发。

投递超时仅暂停同一 thread、同一处理轮次的监控，不重放追问。原会话迟到确认对应 decisionId 后，该轮自动解除 delivery_unknown；手动关闭仍保持关闭。新任务使用新的 contextRevision，历史 unknown 记录保留供核对，但不能再次暂停新任务。

任务上下文读取原始用户任务、后续范围修改、相关对话和完整 final。只有真实用户任务或范围修改直接引用的 `docs/plans/`、`docs/testing/` 文件自动纳入计划；Agent 说明中顺带出现的路径不会成为任务义务，刷新时移除不符合此规则的旧引用。计划限定在当前项目 realpath 内，最多 10 个引用。文件缺失时保留已有内容并标记 `snapshot`；从未读取到内容时标记 `missing`。缺失状态参与分类，不直接令整轮处理失败，也不自动增加恢复文件的义务；文件恢复后重新读取并标记 `current`。输入上限 180,000 UTF-8 字节；只减少最近对话，不能截断原目标、用户范围修改、计划和当前回答。

Codex 自动注入的 `AGENTS.md` 指令和环境上下文不作为用户任务。完整会话来源确认旧任务起点已被过滤时，重新绑定首条真实用户任务，并清空该错误起点的当前轮状态。

## 诊断日志

Backend 结构化日志中的 `task-supervision.*` 事件记录回复接收、处理与过滤原因、分类开始和结束、已提交的状态与判定、续接发送、投递状态变化及重启恢复。入口为 [diagnostics.ts](../../backend/src/task-supervision/diagnostics.ts)；状态和判定日志仅在 journal 保存成功后生成，无变化的后台同步不重复记录。

用 `eventSource + eventId` 关联原始事件，`attemptId` 关联一次回复处理，`watchId`、terminal / panel / thread / executorGeneration 与 `contextRevision` 区分终端和处理轮次，`decisionId` 关联判定、投递与原会话确认。`delivery.sent` 仅表示终端输入调用返回；`delivery.changed` 的 `observed` 才表示原会话出现了对应监督输入。`reply.finished` 表示处理结束，任务完成应查 `decision.recorded.outcome`。

日志保留评分、模型可用信息、耗时、输入字节数、消息 ID 和计划摘要；完整任务、对话、计划正文及分类理由仍从 journal 查看，不复制到诊断日志。模型为“Codex 默认模型”时，实际模型未知，不能据此比较模型质量。分类评分不是正确率，需人工复核判定才能评估误判。

日志复用 `logging.backendDirectory`、`logging.level` 和 `logging.toFile`，默认记录 info 及以上，按日和 50 MiB 轮转、保留 3 天。需要跨版本分析时，应在轮转前留存相关日志及 journal 快照；journal 含完整任务正文，应按私人资料保存。当前开关、错误和投递字段是可更新的状态，历史时间线应结合日志读取。

## 入口与配置

- 共享协议：[task-supervision.ts](../../packages/shared/src/task-supervision.ts)
- 开关与处理：[service.ts](../../backend/src/task-supervision/service.ts)
- 事件适配：[events.ts](../../backend/src/task-supervision/events.ts)
- 现有事件消费：[integration.ts](../../backend/src/app-server/integration.ts)
- 原终端投递：[terminal-task-monitoring.ts](../../backend/src/bootstrap/terminal-task-monitoring.ts)
- 原生 iOS：[TaskSupervisionSheet.swift](../../packages/app-ios/Sources/RunweaveIOS/Features/Terminal/TaskSupervision/TaskSupervisionSheet.swift)，终端菜单与已开启状态条进入，详情内容复用同一 API；生命周期见 [iOS 架构](../../packages/app-ios/docs/architecture.md#终端长任务监控)。
- Web / Electron：[status-strip.tsx](../../frontend/src/components/terminal/task-supervision/status-strip.tsx) 在已开启终端的顶部显示状态与续接额度，点击打开 [panel.tsx](../../frontend/src/components/terminal/task-supervision/panel.tsx)。状态条与详情共享按连接和终端隔离的查询缓存；前台每 5 秒同步，关闭详情仍同步，关闭监控后隐藏状态条。

`backend.taskSupervision.model` 和 `classificationTimeoutMs` 配置分类模型及时间预算。历史 `backend.taskSupervision.enabled` 字段不再作为开启条件；实际开关由终端监听记录保存。旧 `/internal/task-supervision` 请求兼容返回 allow-stop，不再承担分类或续接，避免重复处理。

受现有认证保护的 `/api/task-supervision` 提供终端发现、开启、查询和 pause / resume / update-context。发现时返回当前终端的开关和当前可见会话身份；没有 Agent 时仍返回已有监听状态，允许关闭。开启不要求手工选择任务起点或填目标，从原会话自动取得用户任务；最终回复仅触发分类。
