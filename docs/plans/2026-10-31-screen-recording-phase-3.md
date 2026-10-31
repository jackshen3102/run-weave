# 屏幕记录三期：事项时间线与既有每日总结接入

日期：2026-10-31。状态：实施中，尚未完成全部验收。规划以二期已经可用为前提；本期隔离验证不替一、二期宣布最终验收通过。

前置：[二期实施合同](2026-10-31-screen-recording-phase-2.md)。本期采用 Dayflow 的增量事项整理方式，提供两项成果：在自研 ScreenJournal／Runweave 中按时间线回顾事项；把屏幕事项作为新来源加入现有 Daily Record 定时任务，最终记录继续存入随记。

## 1. 已确认的决策

- 一、二期的采集、媒体库和原生回放继续独立工作，不以模型、Runweave 分析器或随记在线为条件。
- 模型运行在 Mac 上的 Runweave Backend 外部分析模块；ScreenJournal 只提供原始材料、保存衍生结果并展示，不内置模型执行。
- 自动增量整理时间线；以事项为单位、按时间排列，应用名称只是当前证据的辅助字段。同一 Runweave 内的不同工作可以分开，同一工作跨应用可以合并。
- 同时记录用户可见活动和明确的 Agent 后台工作，保留 actor/source 区别。多个 Agent 可以并行，不能把后台执行跨度累计为本人工作时长。
- 每日总结扩展**已有任务**，不新建第二个每日总结任务，不更改其运行时间、身份、目标、已有来源或自动发布策略。
- 随记保存合并后的每日工作事实，不上传原始截图、回放视频或全文会话；不另外生成一篇重复的每日笔记，不改变普通待办完成状态。
- 本轮不创建或更新线上定时任务、不发送通知、不调用模型分析个人画面、不发布随记。部署与启用在实现和隔离验收完成后执行。

## 2. 当前代码与真实任务基线

### 已有任务，只读核查于 2026-10-31

通过 `rw scheduled-task list --instance stable --json` 核实：

| 项目     | 当前值                                                                   |
| -------- | ------------------------------------------------------------------------ |
| 任务     | 每日工作事实记录（本机＋飞书→随记）                                      |
| taskId   | `9154ea45-2619-4889-bdc4-02b587f00336`                                   |
| revision | `2`；实施更新前必须重新 get，不能把此快照当永久 revision                 |
| 调度     | 每天 `03:00`，`Asia/Shanghai`，enabled=true                              |
| 提示词   | `使用 daily-record 技能，按本机配置补齐截至昨天的每日事实并发布到随记。` |
| 执行     | codex，现有 model/effort 与执行权限保持原值                              |
| 补跑     | catch-up-latest，最大延迟 86400 秒；已有 bounded continuation            |
| 本机配置 | `~/.runweave/daily-record/mac-job.json`，autoPublish=true                |
| 已有来源 | 本机 Codex/Pi/Claude/Trae、本人飞书消息、已登记 Mac 浏览来源             |

配置中的 producerId、sourceNamespace、stateDir、collector、随记凭据位置和来源标识继续沿用，不在本计划复制凭据或替换身份。只有该 Mac 添加屏幕来源；其他机器保持原配置。安装态 Skill 与 collector 是部署对象，不能只修改 worktree 后声称任务已经升级。

### 可复用代码与需要补齐的能力

| 入口                                                                                            | 核查事实及本期用途                                                                                                   |
| ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `packages/shared/src/screen-recording/index.ts`、`backend/src/screen-recording/`                | 二期已有 status/ranges/views/frame 合同与同用户 socket 客户端；浏览快照短期存活，不能拿 viewID 作为长期分析身份      |
| `packages/screen-recording-macos/Sources/ScreenJournalCore/JournalReadService.swift`            | ready 画面、索引与读取许可由 App owner 控制；分析取帧复用清理协调，不直接打开正在写入的库或媒体                      |
| `backend/src/work-history/work-history-service.ts`                                              | 可查终端、项目、线程和来源状态；线程引用／运行状态不能独立证明任务完成，需要实际对话及工具回执                       |
| `packages/daily-record/src/`、`packages/shared/src/daily-record.ts`                             | 已能读取本机 Agent 原文、项目、origin、工具回执；原生 collect 目前完整扫描，不能每分钟完整扫描并复制全天材料         |
| `plugins/toolkit/skills/daily-record/scripts/job.py`、`job_facts.py`                            | 已有 prepare/read/validate/publish/reconcile、同日事项合并、稳定键、事实状态和自举排除；新增屏幕材料适配，保留原链路 |
| `job_state.py` 的 config／migrate_sources                                                       | 配置严格校验，目前迁移只允许增加 browser；直接添加 screen 字段会失败，需要显式兼容迁移                               |
| `packages/shared/src/suiji/work-records.ts`、`packages/suiji-server/src/work-records/schema.ts` | sourceRefs 当前没有 screen 来源；需要增加受能力声明保护的引用类型，不能冒充 local-agent 或 browser-visit             |
| `backend/src/device-monitor/scheduled-task-alerts.ts`                                           | 已有定时任务完成推送及幂等投递，手机目标为 scheduled-run；复用该能力，不为日报新建推送服务                           |
| `backend/src/scheduled-tasks/providers/codex.ts`                                                | 可参考 Codex 进程、取消和超时管理，但其结果 schema 只接受任务 outcome，不能直接当作事项 JSON 接口                    |
| `packages/shared/src/scheduled-tasks/types.ts`                                                  | 通用调度仅 daily/weekdays/weekly/once，没有 interval。不得假设可配置“每分钟”或创建 96 个 daily 任务                  |

## 3. Dayflow 固定参考与调整

固定参考提交：[730d6f84b919998158ff7fdab15e3f032f7d8135](https://github.com/JerryZLiu/Dayflow/tree/730d6f84b919998158ff7fdab15e3f032f7d8135)。这些是源码依据，不是本项目已实现或质量保证。

| 规则                                                  | 采用方式                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 每分钟检查、目标 15 分钟一批、截图间隔超过 2 分钟切批 | 参考 [AnalysisManager](https://github.com/JerryZLiu/Dayflow/blob/730d6f84b919998158ff7fdab15e3f032f7d8135/Dayflow/Dayflow/Core/Analysis/AnalysisManager.swift) 与 [BatchingConfig](https://github.com/JerryZLiu/Dayflow/blob/730d6f84b919998158ff7fdab15e3f032f7d8135/Dayflow/Dayflow/Core/AI/LLMTypes.swift)，用 Backend 轻量 tick，只在材料成熟时运行模型                                              |
| 前 45 分钟事项上下文                                  | 带入已发布事项的固定版本，允许延长、合并或修订最近事项，不每批从零建卡                                                                                                                                                                                                                                                                                                                                   |
| 一件连贯事项一张卡，目标变化才拆分                    | 参考 [ClaudeTimelinePrompt](https://github.com/JerryZLiu/Dayflow/blob/730d6f84b919998158ff7fdab15e3f032f7d8135/Dayflow/Dayflow/Core/AI/ClaudeTimelinePrompt.swift)；10–60 分钟作为展示倾向，不能为了凑时长覆盖缺口、合并不同项目或抹掉短事项                                                                                                                                                             |
| 带时间的代表帧加既有事项生成结构化结果                | 参考 [CodexProvider+Timeline](https://github.com/JerryZLiu/Dayflow/blob/730d6f84b919998158ff7fdab15e3f032f7d8135/Dayflow/Dayflow/Core/AI/CodexProvider%2BTimeline.swift) 与 [OneStepTimelineSupport](https://github.com/JerryZLiu/Dayflow/blob/730d6f84b919998158ff7fdab15e3f032f7d8135/Dayflow/Dayflow/Core/AI/OneStepTimelineSupport.swift)；每批常规最多 15 帧，1080 高度，不把所有原始采样都发给模型 |
| 空闲批次跳过模型                                      | 参考 [IdleBatchClassifier](https://github.com/JerryZLiu/Dayflow/blob/730d6f84b919998158ff7fdab15e3f032f7d8135/Dayflow/Dayflow/Core/Analysis/IdleBatchClassifier.swift) 的输入空闲证据；仅记录“无输入记录”，不写“没有工作”。明确有 Agent 事件时仍处理后台工作                                                                                                                                             |
| 每日另行汇总已有事项并通知                            | 参考 [DailyRecapScheduler](https://github.com/JerryZLiu/Dayflow/blob/730d6f84b919998158ff7fdab15e3f032f7d8135/Dayflow/Dayflow/Core/AI/DailyRecapScheduler.swift) 的分层结构；本项目沿用现有 03:00 任务及上海自然日，不移植凌晨 4 点日界、Daily 解锁或 180 分钟活动门槛                                                                                                                                   |

源码移植更新现有 Dayflow 许可证来源映射。模型选择不照抄上游硬编码：采用用户配置的已可用视觉模型；初始配置可沿用现有任务 model/effort，经一批隔离图片能力验证后启用，不自动切云厂商、模型或提高权限。

## 4. 时间线产品行为

Mac 查看窗口与 Runweave 手机屏幕记录页增加“事项／原始记录”切换，默认事项；原始回放完整保留。事项尚未分析时显示“正在整理”及已处理至何时，可立即切原始记录。分析失败显示缺失区间和重试，不把失败变成空闲或当日无记录。

卡片示例：`09:00–09:40 排查手机登录失败`，摘要 `找到令牌刷新异常，Agent 已修改，等待模拟器验证。` 副标签为项目、本人活动／Agent 后台／混合。展开后显示过程、状态、来源及关联时间片；点击已有画面证据进入二期原生回放。Agent-only 事项可打开现有会话入口，无截图时不伪造截图。来源不可达或过期时保留文字，明确证据不可用。

标题针对目标与产物，不是应用名。前台应用仍只是证据元数据；整屏包含多个窗口，不能按前台应用推断全部内容。不同项目／会话不因时间相邻自动合并；相同仓库也不自动等于同一事项。只有明确来源标识或上下文证据才关联屏幕与终端，匹配不确定时保留分开记录。

同一事项分多段发生时使用同一个 matterId、多个时间片；时间线保留顺序，每日总结按事项合并。并行后台任务可以重叠，标记“后台执行”；本人屏幕活动同一时段只归属一条主活动，不能把截图观察时间、Agent 运行跨度混加成工时。不做效率打分或生产力排名。

事实状态沿用现有语义：discussed、attempted、progress、agent-reported、verified、documented。屏幕上打开文件只能证明看到相关内容；Agent 自述完成必须标 agent-reported；verified 需要独立工具回执，不能由截图中的“成功”或模型自评直接升级。

本期补“重试分析”及“原始记录”入口，不另做完整的事项编辑器。用户对最终记录的手工修改继续在随记进行并受人工字段保护；拆并存在歧义时保留待核对，不以相似标题覆盖历史键。

## 5. 分析执行与材料选择

### 5.1 运行位置与调度

新增 `backend/src/screen-recording-analysis/runtime.ts`，由 Backend 的 ResourceScope 托管。仅 Mac、功能已启用、绑定 deviceID 且模型配置有效时工作。每 60 秒检查一次，启动也检查；无新材料时只读索引，不启动模型，不新增通用 scheduled task 类型。

ScreenJournal owner 在衍生库持久化作业及 claim，Backend 作为外部 worker；同一 deviceID 最多 1 个模型作业，多个 Stable/Dev Backend 不能同时领取。claim 含 workerID、generation、到期时间，30 秒续期、5 分钟租期；失联后旧 generation 的结果拒绝。worker 必须核对自己拥有的进程才取消，lease 过期不意味着可以杀未知进程。后台关闭停止新调度、取消自有模型进程并等待退出，不能停止采集 App。

首启只处理启用日期之后且仍可读的数据；正常扫描最近 24 小时，积压在原始保留期内按最早待处理优先补齐，超过期限标 source-expired。每次 tick 最多安排 4 批、执行总预算 10 分钟，余项留队列；不是一次启动处理完七天。记录 UI 最近成功时间、队列数和缺口。

### 5.2 批次与尾部

只消费 ready 帧；按实际时间累计到约 15 分钟，超过 2 分钟的缺口、会话切换或时间回拨切批，不用二期 15 分钟展示 rangeID 当永久 batchID。分析账本记录已处理 capture ID 集合和最大连续覆盖，晚提交段必须重新发现，不能只按“最大时间戳”跳过。日界为 Asia/Shanghai 00:00，与现有每日任务一致。

最新不足 15 分钟的活跃尾部先等待。暂停／会话结束、最后采样已超过 20 分钟，或跨上海自然日时，对此前 ready 尾部结算；不足 5 分钟也保留短观察，不能套用上游 skipped_short 丢失当天最后工作。writing 数据只记 pending，不强迫 writer 封段。迟到 ready 数据形成增量修订，不能改写成“此前已完整”。

每批固定输入 manifest：deviceID、capture IDs、真实毫秒时间、隐私／缺口、必要的 idleSeconds、输入摘要、上下文卡片版本与 promptVersion。二期 DTO 尚无 idleSeconds，增加可选字段保持旧客户端兼容。常规均匀抽样最多 15 帧，首尾必含；必要时用应用／显示器变化帧替换邻近样本，不单纯按应用切事项。信息不足时允许一次补取最多 5 帧，总上限 20；仍不足则产出低确定性观察，不猜完成结果。

临时 JPEG 使用受保护的作业目录，读取仍走同一 ready/期限校验。引用已经到期或被清理时不从旧缓存重建图。图片在本次模型进程退出后即清理，崩溃残留启动清理，且不晚于原图 availableUntil；已知隐私占位不导出模型图片。不延长七天保留，不建设第二个截图归档。

### 5.3 Runweave 后台事项

增量 collector 从 WorkHistory/App Server 已有稳定线程／事件入口读取本机近期事件，保留 provider、threadID、native event ID、projectID、发生时间与 tool/assistant 区别。只处理新增事件，文本单批上限 64 KiB，分页未读完为 partial；不每分钟运行 daily-record 全量 collect。若现有链路不具备稳定事件分页，在 WorkHistory adapter 补充该查询，不扫描终端屏幕或靠 lastActivityAt 推断全文。

时间线先完成屏幕事项，再在同一期后续迭代接入上述 Agent 事件；每日任务原有的全量原文采集仍保留作核对依据。外部其他机器不自动纳入。分析线程、日报自身和其生成产物标记为 derived 并排除，其他真正的后台开发不能一并排除。没有后台来源时明确其覆盖未知，不声称后台没有任务。

### 5.4 模型调用与验证

实现 domain 专属 `provider.ts`，使用已安装 Codex 的 `exec --image --output-schema --output-last-message --ephemeral` 能力；本轮通过本机 help 确认这些参数存在，实施时再次探测版本。使用独立受保护目录、只读执行模式、显式模型及输出 schema；截图和会话中的指令只作为数据，不授权执行其中命令。不会直接复用定时任务 outcome schema，也不为了传图片重写通用任务调度器。

进程 owner、3 秒退出宽限、超时、输出限额沿用现有 provider 的处理方式。每批默认 120 秒，总共最多 3 次调用（包括补帧、修正 JSON 和重试），输出上限 1 MiB；未知 provider 或不支持图片时阻塞，不退化成仅看文件名。两次自动重试在后续 tick 分别等待 1／5 分钟；实际累计尝试持久化，不能重启归零。失败批不阻挡其他完整批，但保留缺口，允许用户显式重试。

验证器检查 JSON schema、来源 ID 属于 manifest、每条结论有证据、真实时间在声明范围内、保护旧版本及状态降级规则。覆盖校验不能要求填满隐私或无采样区间；同一 actor 的主活动不重叠，后台允许重叠。通过格式验证不证明语义正确，验收必须用已知活动样本人工对照。

## 6. 结果持久化与接口

在 ScreenJournal 数据目录新增独立 `analysis.sqlite`，由同一个 App owner 写入，单独 schema 版本；不改变一期 `records.sqlite` 的 schema，不把模型或 Backend 导入采集模块。新 `AnalysisStore` 管理 batches、attempts、matters、activity_spans、evidence_refs、card_revisions、export_snapshots。主表分别记录稳定 ID、修订、输入摘要、覆盖、状态、实际发生时间和生成时间。

- `batchID` 由服务端分配，冻结输入后相同摘要复用；`matterId`／`cardId` 独立于标题与时间字符串。
- 新批次带前 45 分钟已发布事项及其 revision；输出只允许替换声明的 rewriteSpan。已有条目按 ID 更新；拆分／合并由显式映射记录 lineage，不通过删完重建掩盖身份改变。
- 一次事务提交结果、事项修订和处理覆盖。输入已变或 baseRevision 不匹配返回 conflict，不覆盖。相同 operationId、inputHash 重放返回原回执；同键不同内容拒绝。响应丢失时先查询提交回执，不重新分配事项 ID。
- 画面清理不级联删除文字记录；引用变成 expired。近期时间线按最近可用日期展示，历史最终事实在随记。衍生文字与 revisions 默认本地保留 30 天、最大 256 MiB，输入原文不做长期全文副本；待发布仍无法在期限内完成时标记永久缺口，不能假报 complete 或无限保留图像。
- 衍生库计入全目录磁盘预算，但先清理其过期临时产物，不靠每 tick VACUUM；坏库／不支持 schema 仅阻塞分析和事项展示，不破坏采集与原始回放。回滚关闭分析，保留衍生库供恢复。

为既有同用户 socket 增加独立能力 `analysisVersion=1`，不改变旧 read 协议。新增只读 analysisStatus、analysisCards、analysisCard、analysisExport；新增 owner 校验后的 claimAnalysis、renewAnalysis、commitAnalysis、analysisReceipt、retryAnalysis。分析写入不接受任意 SQL／路径、用户自报完成或原始媒体写操作；App 再次校验 manifest 与 revision。

Backend 在 `/api/screen-recording/analysis/` 下提供 status、cards（day/cursor/limit 最大100）、cards/:id、export（day、snapshotRevision）、retry（card/batch ID、expectedRevision、幂等键）。沿用 requireTunnelAuth、requireAuth 和二期设备／连接隔离；claim/commit 仅供本机 worker socket 调用，不作为手机任意写入接口。状态变更 retry 同样需要现有授权，不把手机 token 交给 App。

export 返回 schemaVersion、deviceID、day、timeZone、snapshotID、revision、generatedAt、sourceReadAt、coverage、missingIntervals、cards 与摘要；分页绑定 snapshotRevision，修改后返回 conflict，不能混合两个版本。没有材料是完整的已记录范围空集合，来源不可达是 unavailable；不能把两者写成同样“无工作”。回放证据通过 captureID 重新解析现有媒体能力，不保存易失的 viewID 或路径。

## 7. 接入既有 Daily Record 任务

### 7.1 配置与来源迁移

在现有 sources 增加可选 `screen`，缺省关闭，格式为 enabled、effectiveFrom、expectedDeviceID、exporterArgv。exporter 使用固定已部署版本的 `rw screen-recording analysis export --instance stable`，日期／输出目录由 job adapter 提供；实现 CLI 子命令并复用现有 Backend 鉴权。配置不保存新的模型凭据、手机 token 或另一份随记配置。

新增 `job_screen.py`，只读上述冻结导出，校验 deviceID、上海工作日、版本、hash、分页及缺口。`job_state.py` 扩展 config 与 migrate-sources：仅添加这个新来源，不改变旧来源、producerId、namespace、起始日、目标、身份映射和 outbox；持锁、dry-run、备份与 migration journal 沿用 browser 迁移机制。存在未结束批次先恢复原请求，禁止手删状态来绕过。生效日前不追溯要求屏幕来源。

登记 scope 为 `screen:<producerId>:<deviceID>:observed`，来源名称明确“屏幕事项（仅已记录范围）”。随记增加 `features.workScreenTimeline=true`、`WorkSourceRef.channel=screen-timeline` 及服务端／CLI 校验。现有 source_snapshot 是 JSON，先核对实际数据库约束；若无需 DDL 则不抬高 schema，若必须变更只追加迁移，不改旧迁移。

sourceRefs 使用稳定 card/matter ID、revision 和摘要，绝不上传路径、JPEG 或完整对话。来源 complete 只表示该日已保存且应分析的材料全部结算并读取完，不能证明全天工作完整；unavailable/pending/expired-unprocessed 为 partial 或 unavailable，明示缺失。

### 7.2 原任务如何运行

保持原任务提示词优先不变，升级它引用的 Daily Record Skill 与运行脚本即可；只有确需明确新来源时，对原 taskId 做最小 prompt 更新，保留其余字段，重新 get/revision 校验并回读。不得重新创建同名任务或第二个日报任务。

03:00 的原流程仍先 reconcile 旧 pending，再 prepare 截至昨天的缺日。screen adapter 只读导出已完成时间线；昨天的尾部由增量 worker 的自然日结算规则处理，adapter 对 pending 最多轮询等待 120 秒。模型忙、App 不在线或部分原图已过期时记录 partial，继续整理可用的其他来源，不无期限挂起日报，也不新启第二个分析器。

每日 Agent 阅读屏幕事项、原有本机 Agent 原文、飞书和浏览材料，先合并同日同目标，再生成最终事实。屏幕记录用于补充“当时看到了什么、何时发生”，Agent 工具回执用于证明执行结果；同一任务不因多来源重复发布。屏幕摘要中的模型结论不是独立核验依据：纯屏幕事实最多 documented／discussed，不能单独成为 verified；要升级须引用现有当天工具材料。

保留原 eventKey/externalKey 及人工字段。screen evidence 不能凭相似标题把两条旧事项强制合并；歧义使用原有 AMBIGUOUS_FACT_MERGE 路径，不覆盖已有结论。新事实逐条附可追溯依据；列表继续简短，不把时间线每个 15 分钟片段逐条写入随记。

原 validate → 冻结 export → publish → 独立回读 → confirmed 链路保持不变，未知写入结果仍复用原请求与幂等键，不换键。pure screen 的 sourceIds、全文阅读回执和状态限制纳入 job_facts 校验；autoPublish 沿用当前 true，不新增每日人工确认流程。

### 7.3 修订、缺日与通知

screen export 的 dayRevision 后续可能因补分析改变。job state 保存已消费 revision；prepare 除既有缺日外检查最近 7 天的来源 revision，发生变化的已发布日重新核对，按稳定键更新，而非永久跳过 confirmed 日。正在 pending 的旧包仍先完成原样恢复，然后再处理新 revision。超过补查窗口的修订只在显式日期重整时处理，不能暗改任意历史日。

复用当前 scheduled-run 的手机通知和订阅设置；日报只有完成随记独立回读后才输出 succeeded／“已保存”。本轮未验证手机推送订阅或 APNs 到达，不把代码存在当成用户已经收到通知。已有失败、blocked 通知保留准确语义，不另发“总结已完成”。通知失败独立重试，不重新生成或发布日报；多个补报日期合成一次本轮任务结果通知，沿用幂等 eventId。

通知点击沿用当前 scheduled-run 入口，结果中列明已确认日期和随记记录；手机在随记现有工作记录页按日期查看，不为了自动跳随记新建跨 App deep link 协议。接入任务通知渠道是本期验证项，未开启则提示沿用已有订阅设置，不私自改变通知偏好。

## 8. 实施迭代与文件范围

### 3.1 增量分析基础，先得到可核对的屏幕事项

- [ ] `ScreenJournalCore/AnalysisStore.swift`、`AnalysisModels.swift`、`AnalysisCoordinator.swift`：衍生库、批次账本、claim、版本、原子提交；修改 socket dispatcher 与 App owner 装配，保持媒体读取不变。
- [ ] `backend/src/screen-recording-analysis/{runtime,collector,batching,provider,validator}.ts`：分钟 tick、材料快照、视觉模型、限额及恢复；接入 `bootstrap/runtime-services.ts`、contract 和资源关闭。
- [ ] `packages/shared/src/screen-recording/analysis.ts` 及入口：跨端 DTO；配置通过现有配置目录注册，新增文件读取登记到 `scripts/quality/configuration-accesses.json`，不散落环境变量和硬编码个人路径。
- [ ] 固定上游提示词行为与自家验证规则；建立标注了事项边界、缺口及结果证据的隔离样本，验证生成质量和失败分支。先不发布随记。

### 3.2 后台事项与原生时间线

- [ ] `backend/src/screen-recording-analysis/agent-evidence.ts` 和 WorkHistory adapter：稳定事件分页、明确来源和后台 actor；去重截屏与线程中的同一事实，保留未读／来源缺失状态。
- [ ] `backend/src/routes/screen-recording-analysis.ts`：只读事项、详情、导出与有界重试；原鉴权和连接切换失效语义不变。
- [ ] Mac `ScreenJournalApp/Views/JournalActivitiesView.swift`／详情及现有 browser 入口，iOS `Features/ScreenRecording/` 与 Contracts／APIClient 扩展：事项与原始记录切换、时间片、后台标记及证据回放。
- [ ] Mac 与 iOS 模拟器各实际验证事项列表、重试、跨段回放、证据过期和连接切换；继续只支持在线手机查看，不宣称真机通过。

### 3.3 加入已有日报，保留发布与恢复合同

- [ ] `plugins/toolkit/skills/daily-record/scripts/job_screen.py`；更新 job.py、job_state.py、job_facts.py、SKILL.md 与 scheduled-reporting 参考，扩展来源迁移、导出冻结、阅读和 revision 补报。
- [ ] `packages/runweave-cli/src/commands/` 增加 `screen-recording analysis export` 及命令路由，固定 instance、鉴权、只读导出和新目录写入，不能通过匿名本机文件读绕过来源身份。
- [ ] `packages/shared/src/{daily-record,suiji/work-records,suiji/auth}.ts`、suiji-server `work-records/schema.ts`、`http/app.ts`、`mcp/router.ts` 和 suiji Skill 校验器：新增 screen channel 与 feature，保留旧输入兼容。Suiji iOS 复用原 WorkFact 合同，除非发现新枚举解析需求，不顺手新增展示模块。
- [ ] 在隔离配置与隔离随记服务验证来源迁移、同事项合并、人工保护、pending 恢复和补报；不修改用户真实 task 作为测试夹具。

### 3.4 部署接入与到点验收

- [ ] 先部署服务能力，再部署固定 CLI／Skill 版本；沿原路径保留权限和配置，不依赖本次临时 worktree。
- [ ] 重新读取 stable 的目标 task、原 mac-job 配置和 pending 状态。对 screen 来源生成迁移 dry-run，核对 deviceID、生效日、注册 scope 与已有身份；按支持的迁移入口执行，不手工重置状态。
- [ ] 在原任务手动执行一次验证真实屏幕来源及随记独立回读，然后观察一次真实 03:00 scheduledFor 的运行与手机通知。只读任务查询、手动 run、到点 run、APNs 接受和手机收到分别报告。
- [ ] 若需要改原 task 提示词，使用现有 scheduled-task 校验和原 revision 更新流程；新来源配置迁移与代码部署才是主要变更，不修改已确认的 03:00 时刻。执行前据本次授权和实际变更范围判断，不重复索要已确认的自动发布权限。
- [ ] 回滚时先停用分析 worker，回放和原日报旧来源继续；屏幕 scope 按生效日期停用，保留旧 ledger/outbox/身份映射。不能通过删除 scope 或倒退登记日期消除历史缺报。

## 9. 验收与完成标准

新增两份行为合同：[增量事项与展示](../testing/screen-recording/analysis.testplan.yaml)、[既有日报屏幕来源](../testing/skills/daily-record-screen.testplan.yaml)。同时回归受影响的二期 read-service/playback，以及已有 daily-record-reporting、daily-record-browser 和随记 work-records 导入用例；只重跑受影响范围，不写单元测试。

实施时运行对应构建／检查：Mac 沿包 build.sh；Backend、shared、runweave-cli、suiji-server 沿各包 typecheck/lint/build；修改配置访问后跑配置检查，跨运行时改动跑 architecture:check。原生 UI 用 CUA／toolkit:agent-device，模拟器按设备池申请并释放；不在本轮计划阶段启动环境。

隔离模型样本至少覆盖：同应用两个任务、同任务跨应用、中途继续、并行后台、短尾、隐私、空闲阅读、截图宣称成功但工具失败、来源缺失和恶意页面指令。逐条与预期事实对照，分别记录事项划分、证据、状态错误；格式通过不是质量通过。

资源验收记录单批帧数、文本字节、模型耗时／调用次数／可得 token、临时目录字节、积压及取消释放。无材料 tick 不得调用模型；正常采集 15 分钟材料成熟后，在二期封段等待之外，正常两分钟模型预算内完成一批；实际延迟包含封段与排队，不能承诺每逢整刻立即有卡片。原始采集不能因模型失败、网络中断或随记不可用而停止。

最终分别报告：源码与 schema 校验、隔离集成、真实模型语义对照、Mac 操作、Runweave 模拟器、真实来源迁移、随记回读、原任务到点执行、手机通知。遇到缺模型／权限／设备／推送订阅时记录对应阻塞，不用生成图片、构建或 provider 退出码代替业务完成。

## 10. 合并后补充交付记录（2026-10-31）

基线为 PR #882，`98c3151f3734c6814cceb28248f3d422a7240e4a`。本次后续工作区改动：

- 实现 Agent-only 到既有原生会话的导航，两端核对来源身份；不可达保留文字。修复 iOS sheet 关闭与会话打开时序，Mac 刷新清除失效详情和旧图。
- 修复到期批次阻塞后续队列；媒体删除前记录 30 天 capture 身份账本，为未完成材料产生永久缺口。
- 隔离验证通过：94 帧跨日/十五分钟/短尾/迟到边界、租约和新进程预算恢复、坏分析库不阻断原存储、4 帧清理留下 2 个永久缺口及文字卡、真实模型拆分与合并。
- Mac Debug + Beta、iOS Simulator 实际通过会话可达/不可达、重试、原图清理失效；Simulator 两设备切换取消 45 秒延迟旧响应，断线清空详情。
- Backend/Frontend/Electron 类型检查、受影响 TS lint、Mac Debug 与 iOS Simulator 构建、架构检查、文档检查通过。没有新增单元测试。

本机详细证据为 `.runweave/screen-recording/evidence/phase-3-followup.md`，截图和诊断 JSON 同目录；未提交的本地证据不作为远端 CI 产物。两个专属 Beta Dev Session、两个合成 Mac owner、代理及 Simulator 租约已释放。

以上为分项验收，不将两份测试计划全部标记通过。正式版部署、个人屏幕分析启用、真实日报迁移、03:00 到点和手机通知未执行；不以隔离样本代替这些结果。后续源码改动尚未提交。
