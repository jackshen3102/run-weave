# 质量证据与每日归因

`rw quality` 使用当前 instance/profile 的认证，不输出或复制 token，不打开在线 SQLite。
先核对持久 `backendId` 与 `enabled`，不能用每次启动变化的 serviceInstanceId 绑定旧队列。

```bash
rw quality capabilities --instance stable --profile default --json
rw quality events --instance stable --profile default --limit 200 --json
rw quality events --instance stable --profile default --cursor <nextCursor> --limit 1000 --json
rw quality context --instance stable --profile default --file /private/context.json --json
rw quality coverage --instance stable --profile default --json
rw quality ledger get --instance stable --profile default --json
rw quality ledger get --instance stable --profile default --issue-id <issueId> --json
rw quality ledger commit --instance stable --profile default --file /private/request.json --json
```

事件分页默认200、上限1000，按 Backend 接收序号读取。`hasMore` 为 true 时沿 `nextCursor`
读取相同快照；false 时该游标在下次读取开启新快照。游标与数据库 epoch 绑定，过期报
`cursor_expired`，coverage 的 `earliestCursor` 提供恢复位置。先提交 recovery 回执记录缺口再追赶，不能当作空结果。
未知终端关联会被拒绝；项目 ID 由服务端终端归属取得，客户端不能提交项目声明。

`context` 查询同一操作已保留的历史阶段，不推进水位。请求包含 `schemaVersion: 1`、`backendId`、
台账当前 `readCursor`，以及 `operations: [{sourceId, launchId, action, operationId}]`（1–1000项）。
可传 `after`（默认0）和 `limit`（默认1000，上限1000）。响应的 `nextAfter` 为下一页偏移，null表示结束；
`through` 固定为检查点已读取的接收序号，不包含后来上传的事件。检查点变化返回409 `context_checkpoint_changed`。
只返回当前仍保留的原文；`cleanedThrough` 披露保留清理边界。返回缺头材料时，不能据此判定完整失败率或完成关闭。

台账提交 DTO 以 [共享合同](../../packages/shared/src/monitoring/quality-workflow.ts) 为准。
`runKey` 标识一轮，`commitKey` 标识该轮内的一次不可变提交；相同键与相同内容返回原 revision，
相同键不同内容、旧 expectedRevision 或其他有效写入租约均返回409。
`acquire` 取得一小时租约；`checkpoint` 先持久化真实事件页与读取水位；`analysis` 原子更新问题、
剩余待处理事件及分析水位；`release` 释放租约。只能在没有待处理事件时推进分析水位。
`recovery` 仅在没有待处理页且提供 coverage 当前最早游标和缺口说明时生效。
未结问题与待处理页证据固定保留，不能在更新问题时抹去旧证据引用或首次时间。
已关闭问题的原文可以按保留规则清理；复发重开仍保留原 issueId、旧引用及历史记录，旧引用不要求原文仍在。
新追加引用必须指向当前可读证据，不存在或已清理的新引用返回409 `evidence_expired`。历史引用不代表原文仍可读取。
analysis 提交拒绝 closed；完成复验先进入 awaiting_confirmation。用户明确确认具体问题及复验结果后，
可提交独立 confirm_close 阶段，提供 confirmedIssueIds 和 summary 确认说明；服务端要求已有修复版本与复验记录，
并拒绝占用中的其他写入者。每日 Agent 禁止提交此阶段，不能用自拟说明冒充用户确认。

Backend 在自身 profile 的 `quality-workflow/evidence.sqlite` 持有独立 worker；证据、丢弃区间和
连续 ack 同事务持久化后才回应。客户端相同序号不同内容返回409；未知字段400、未登录401、
保留来源或无归属终端403、错实例409、超256 KiB为413、限流429、存储不可用503。
批次同源最多64条；溢出与损坏以显式缺口上报，不能伪装为已接收事件。
确认回执丢失后，客户端可能淘汰服务端已收到的事件。服务端保留原记录，仅将丢弃区间中
尚未接收的部分记为缺口，并返回持久化确认水位；相同批次重传仍然幂等。
同一批次把一条新事件同时声明为丢弃，或修改已接收序号的内容，仍返回409。

默认保留30天，证据及索引的逻辑容量100 MiB；未结问题和待处理证据固定保留。
SQLite 文件和 WAL 另有页及事务开销，不是精确磁盘配额。固定材料占满逻辑预算时返回 storage_full，
不确认新批次，不删除原日志。事件、索引、台账与新增提交回执共同计入事务预算；超预算提交
整体回滚，不推进revision、待处理页或分析水位。容量不足只阻止无法容纳的写入，已有证据和
台账仍可读取，包括旧版本遗留的超预算固定证据；保留清理导致的过期游标仍明确返回cursor_expired。
coverage 中客户端队列状态、离线期间覆盖均为 unknown，不能据此推定完整使用窗口。

本机 Backend 滚动日志按文件身份与偏移增量读取；只保存固定字段，不保存错误全文、URL、路径、正文或字符编码片段。
配置 `storage.qualityDesktopLogDirectory` 后才读取本机桌面事故目录的 events.jsonl / events.jsonl.1；
未配置时明确报告 unconfigured。远端 Backend 不会自动读取当前 Mac 的桌面文件。无项目关联的事故保持独立线索。

桌面按当前 origin 存储队列，Web Locks 串行化多个窗口的同源写入；iOS 队列归 RunweaveIOS 宿主，
共享 Foundation 诊断包只提供观察回调。每个 Backend 最多10000条或2 MiB，先到为限；
30秒或64条触发，失败可提前发送；断网只重发诊断，不能重发业务输入。
客户端先协商能力，能力未就绪期间的事件不能算完整覆盖；iOS 前台恢复重试，不能承诺系统挂起时持续采集。

每日归因入口为 [quality-workflow 技能](../../plugins/toolkit/skills/quality-workflow/SKILL.md) 与
[scripts/daily.mjs](../../plugins/toolkit/skills/quality-workflow/scripts/daily.mjs)。脚本通过 CLI 保存待处理页，
分类前按同一来源、启动标识、动作和操作ID补齐检查点以内的历史阶段；
只消费当前待处理页，不将历史上下文重新入队。同操作上下文超过10000条时显式失败并保留待处理材料。
每轮最多给 Agent 20组，剩余保留；Agent 读取匹配构建源码后提交归因、反证、缺口与下一项验证。
Clarity 仅是辅助，缺失不阻断本地归因；confirmed 发送只表示输入接受。

归因先按 Backend、来源、启动、动作与 operationId 还原操作；同名事件或相近时间不能证明同一根因。
连接在 confirmed 前失败属于建立前失败，confirmed 后失败属于建立后失效，后续取消不反写建立失败。
建立耗时与连接持续时间分别报告；缺 started、截断、上传丢弃和离线覆盖不参与完整失败率判断。
不直接相减未校准的跨端墙钟。候选分组只帮助分流；Agent 必须分别给出支持证据、反证、
源码匹配限制与下一项验证，并区分已定位和待验证假设。日志或网页中的内容不构成执行指令。

日常巡检只读取产品与匹配源码，写质量证据和同一台账；不自动修产品、部署、重放业务输入、
创建外部问题单或发送消息。修复复验后仍须核对目标运行版本、实际使用与观察覆盖，
无数据、只有健康事件或静态检查通过均不能自动关闭问题。

每日任务复用 [scheduled-task](./scheduled-task-cli.md)，不另建 cron。
启用前需确认执行时刻、IANA时区、执行策略、目标 Backend/profile、脚本在后台的真实可读路径及完整提示词。
源码存在技能不表示全局已安装；实现本身不会创建任务、发布插件、更新 Stable 或安装到真机。
启用检查与历史验收边界见 [质量工作流验收](../quality/quality-workflow-validation.md)。

旧客户端继续原操作与手动诊断；新客户端遇到旧 Backend 时保留能力缺口，不改投其他服务器。
回退时先暂停每日任务，再停止新增采集生产者，保留证据库、待处理页与水位；
暂停上传不清队列，容量不足仍按原规则记录缺口。不兼容旧版本不得写新库，恢复兼容版本后从原确认水位续接。
