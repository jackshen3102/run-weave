# Runweave 独立行为数据底座与经验生成系统测试用例

> 状态：待实施后执行
> 对应计划：`docs/plans/2026-07-11-system-activity-data-foundation.md`
> 原则：不新增单元测试；使用真实进程、API、文件、Playwright、CLI、Hook、Shell 和桌面运行时取证

## 验收范围

本用例验证四件事：

1. 事实是在行为发生时主动写入独立 Activity Hub，不是运行时扫描现有业务库拼出来。
2. Stable、Beta、Dev 与 external producer 能集中写入，同时保留真实来源、缺口、顺序和失败语义。
3. 7 天内容 / 30 天事实、隐私、删除、引用和海量写入符合计划。
4. Learning 只能由模型读取冻结 Context Pack 生成，且与事实隔离、可审计、可审核。

P0–P2 实施时执行 ADF-001 至 ADF-021；P3 执行 ADF-022 至 ADF-028；P4 执行 ADF-029 至 ADF-030。任一关键用例失败即停止该阶段发布。

## 环境与证据

准备：

- 一个隔离 Activity Hub home，例如 `/tmp/runweave-activity-hub-acceptance`。
- Stable、Beta、Dev 三个可区分 Runtime；至少两个 Backend profile。
- 一个 Runweave Terminal、一个安装全局 Agent Hook 的外部 TTY，以及一个未安装 Shell Integration 的外部 TTY。
- 一个包含 Browser tab 和 Agent Team acceptance case 的隔离 Project。
- 可控制时钟或 retention fixture；不能修改真实用户数据时间戳。
- 所有内容使用测试 secret 和测试正文，不使用真实 token、cookie 或私有代码。

证据至少包含：

```text
artifacts/activity-data-foundation/<phase>/
  environment.json
  api/
  storage/
  browser/
  desktop/
  privacy/
  retention/
  learning/
  command-results.json
```

`environment.json` 记录 Git SHA、Node、Activity Hub version/home、Runtime channel、surface、producer instance/boot、Project/Terminal/Thread/Run ID 和时间。证据不保存明文 secret。

## 必跑门禁

```bash
pnpm architecture:check
pnpm typecheck
pnpm lint
pnpm build
git diff --check
```

涉及 Web/Activity 页面必须实际执行 `$playwright-cli`。涉及 Stable/Beta Electron 并行、系统 Hook 或 Keychain 时先用 `$computer-use` 准备环境，再使用 `$playwright-cli` 对页面状态取证。未执行必须写明阻塞原因，不能用源码阅读代替。

## 测试用例

### ADF-001 行为数据写入独立根目录

方法：端到端、存储隔离。

前置：Stable App Server、Beta App Server、Backend 和 Activity Hub 分别使用隔离 home。

操作：从 Stable 与 Beta 各发送一条测试 Query，完成一次 Agent turn；列出 Activity Hub、两个 App Server、Backend profile 和 Project `.runweave` 中本次产生的文件；用 `file`、`sqlite3 .tables`、`PRAGMA journal_mode` 和主键查询检查 `activity.sqlite`。

预期：`activity.sqlite` 是 SQLite 3 数据库且启用 WAL；9 个 canonical behavior/content/ref/source/quarantine/retention 表都在该库；每个 Producer spool 也是 SQLite 且只有 `spool_events/spool_loss_ranges` transient 表；规范化 `user.query.submit_requested`、`agent.thread.*` 与 `agent.response.observed` 只以 Hub SQLite row/BLOB 存在；两个 App Server 的 operational event/state 仍各自隔离；Activity Hub 不创建 Fact JSONL/segment，也不写 Backend LowDB 或项目 run 文件。

失败：Activity Fact 复用 App Server JSONL、依赖项目 `.runweave` 才可查询，或 Stable/Beta 各自形成无法统一查询的行为库。

### ADF-002 事实不是读时扫描现有业务数据生成

方法：因果验证、依赖删除。

前置：已产生一组 Query、command 和 Agent Team phase 事实。

操作：停止 producer；复制并隔离删除相应测试 Thread snapshot、scrollback、Agent Team run 和 Backend profile；仅启动 Activity Hub 查询事实。

预期：30 天内结构化事实、关系、时间和结果仍可查询；External Ref 显示 missing/expired，但事实不会消失或在查询时重新生成。

失败：Facts API 必须访问 Backend/Thread/run 文件才能返回基本记录，或源文件删除后事件数量变化。

### ADF-003 Event schema 与 runtime/surface 不混淆

方法：判定表。

操作：分别从 Stable Desktop、Beta Desktop、Dev Web、Backend、CLI、Hook、Shell 写合法事件；再提交 CLI 被标成 runtime、缺 `eventId`、未知 major schema、超限 payload、未授权 event name、Query 伪装成 Agent actor、Agent Team 伪装成 User actor，以及 Producer 伪造 `deviceId/ingestedAt/hubOffset/privacy/retention` 的请求。

预期：合法组合保留 `runtime.channel` 与 `runtime.surface`；Hub-owned/Registry-owned 字段只能由 Hub/Registry 写；非法事件被拒或进入 SQLite quarantine，不能混进 Facts；Sources 显示 reject 数和原因。

失败：CLI 被当成 Runtime、Backend 被猜成 Web/Desktop、Producer 能覆盖 Hub 字段、unknown payload 直接入库、坏 Beta schema 影响 Stable 查询，或 reject 没有可见记录。

### ADF-004 Stable/Beta/Dev 集中展示且控制面保持隔离

方法：多运行时端到端。

操作：三套 Runtime 在各自固定的 Project scope 下执行 Query、Agent completion 和 verification；在其中一套停止/重启 App Server；用 `$playwright-cli` 打开 Facts 与 Sources。

预期：一个页面能按 Runtime 筛选全部事实；每条记录版本/profile/source 正确；停止一套 App Server 不影响其他 Runtime 或 Activity Hub；Activity Hub 不能控制任一 Runtime。

失败：channel 串标、事件写入不同 Hub、一个 Runtime 故障导致全局写入失败，或 Hub 获得运行时控制权限。

### ADF-005 外部 TTY Agent Query/Reply 覆盖

方法：等价类、能力边界。

操作：在没有 `RUNWEAVE_TERMINAL_SESSION_ID`、但已安装 Activity Hook 的外部 TTY 启动受支持 Agent，发送 Query 并完成；再在未安装 Hook 的 TTY 重复。

预期：第一组以 `runtime=external/surface=hook` 写 `user.query.submit_requested`、对应的 `agent.thread.started/resumed` 与主 Agent `agent.response.observed`；Query 事件只表示 Hook 观察到发送请求，不声称 Agent 已接受；SubagentStop 不混入用户回复；未知 Terminal ID 保留为空；第二组不产生伪记录，Sources/文档明确未覆盖；系统不从 UserPromptSubmit/Stop 猜造 `agent.turn.*` 生命周期。

失败：仍因 Runweave Terminal gate 跳过第一组、给外部 TTY 猜造 Session ID，或声称第二组已覆盖。

### ADF-006 外部任意 Shell command 仅由显式 Shell Integration 捕获

方法：正反例。

操作：在启用受控 interactive zsh integration 的隔离 shell 执行成功、失败、Ctrl-C、含管道和多行命令；再在未启用 integration 的 zsh、当前 bash DEBUG trap 与无 adapter 的 fish 中重复。

预期：受控 zsh 组产生 `terminal.command.started/completed`，成功、失败与 Ctrl-C 的 exit/result、duration、cwd 正确（Ctrl-C 不另造 cancelled variant）；正文按 7 天内容策略；其它组不通过 DEBUG trap 或 scrollback 拼装用户命令，Sources 标 coverage inactive。

失败：按键流被当作最终命令、IME/编辑内容错误、未启用组被猜测记录，或命令 secret 明文入库。

### ADF-007 Query 主线只使用显式关联 ID

方法：并发、错误猜测。

操作：同一 Thread 连续发送两个 Query；并行执行 tool、command、browser 和 verification；故意让一个 producer 不带 interactionId，但时间落在同一窗口。

预期：两个 interaction 不串联；带 ID 的动作沿 correlation/causation 展开；缺 ID 事件显示 unlinked/coverage gap，不按时间自动归入某个 Task。

失败：Thread 被错误等同单一 Task、相邻事件被猜到错误 Query，或 UI 隐藏未关联事实。

### ADF-008 Producer 顺序、Hub 接收顺序与跨源时钟偏差

方法：时序、边界。

操作：两个 producer 交错提交事件，并让其中一个 occurredAt 偏移 5 分钟、网络延迟后到；先保存 change-feed hubOffset，再提交迟到事件；检查 sequence、hubOffset、timeline snapshot 分页和 change feed。

预期：每个 producer sequence 单调；hubOffset 只表示接收顺序；timeline 同时呈现 occurred/ingested 时间和 clock skew，不伪造全局严格顺序；迟到事件通过 `afterHubOffset` 增量流出现，冻结 `asOfHubOffset` 的旧分页不漂移，刷新后可按 occurredAt 插回正确位置。

失败：Hub 重写 occurredAt、跨 producer 用单一自增 ID声称发生顺序，或迟到事件覆盖已有记录。

### ADF-009 Hub 下线时业务不阻塞且恢复后重放

方法：依赖不可用、恢复。

操作：分别使用两个新 Producer boot：第一组停止 Hub 后执行 critical Query/response/result 与 sampled UI events，并在 7 天内恢复；第二组在 Hub 已停止时启动且保持同一进程/boot，直到包含 `producer.instance.started` 的 encrypted spool bundle 超过 7 天并生成 loss range；随后重启并升级 Producer，再重启 Hub 等待旧 loss report ACK；测量业务路径耗时，检查 `spool_events/spool_loss_ranges/producer_instances`。

预期：业务继续；producer enqueue p95 符合预算；7 天内 spool 按 sequence 完整重放 critical Fact；超过 7 天的整个 bundle 被删除且不复活，先留下带 affected name/version/runtime/bootStartedAt 的无正文 loss range；Reporter 重启/升级后仍用旧 manifest 创建 `producer_instances(started_event_id=NULL)` 并产生 `source.events_dropped(reason=retention_expired)`，不得写入新版本/runtime；sampled 丢弃也产生对应 loss event；未知原因的 sequence gap 只显示 gap，不伪造 reason。

失败：用户动作等待 Hub、spool 丢 critical、恢复后乱序/静默丢失，或丢弃没有 gap。

### ADF-010 重复投递幂等

方法：at-least-once。

操作：同一 eventId/producer sequence/Content ID/Ref ID 重发 10 次，包含跨连接、跨进程和 ACK 丢失后的 retry；再分别发送“同 eventId 但 payload/content 不同”“同 sequence 但 eventId 不同”“同 contentId 换不兼容 role/kind”“跨 owner namespace 复用 content/ref ID”和“相同 payload 但新 eventId/sequence”五组。

预期：完全相同的 retry 只有一条 Fact/Content/Ref/link 并返回原 hubOffset；前两组 fingerprint 冲突以 `idempotency_conflict` 拒绝；不兼容 role/kind 以 `content_identity_conflict` 拒绝；跨 namespace 以 ownership error 拒绝；冲突留下脱敏 quarantine 记录；最后一组是新事实。去重不依赖 `Date.now()` 或模糊文本相似度。

失败：出现重复行、不同真实动作被错误合并，或 retry 生成新 ID。

### ADF-011 Sequence gap、迟到补齐与不可恢复丢失

方法：状态迁移。

操作：发送 seq 1、2、4；查询 Sources；随后迟到发送 3；再模拟 spool quota 丢失 5–7。

预期：2→4 形成 gap，3 到达后关闭；5–7 保留不可恢复 gap 与 dropped count；Facts/Context Pack coverage 都携带缺口。

失败：Hub 猜造缺失事件、gap 只在日志不可查询，或补齐后删除审计轨迹。

### ADF-012 Schema quarantine 不污染事实

方法：异常输入。

操作：提交坏 JSON、未知 event、字段类型错、超限正文、禁止 producer namespace 和未来 Beta schema。

预期：事件进入有界 7 天 quarantine 或明确拒绝；Facts count 不变；Sources 显示分类计数；合法 producer 后续仍可写。

失败：Hub crash、坏 payload 混入 SQLite Facts、quarantine 无上限，或 Beta schema 阻塞 Stable。

### ADF-013 SQLite transaction 与 WAL 崩溃恢复

方法：故障注入。

操作：分别在 `BEGIN IMMEDIATE` 前、Fact insert 后、Content/link insert 后、COMMIT 前、COMMIT 后但 ACK 前强制结束 Hub；重启后执行 `PRAGMA integrity_check`、`foreign_key_check`，并让 Producer 以相同 eventId/sequence 重放；通过 storage adapter 尝试写负 byte length、expiry 早于 anchor、反向 gap range 和 contiguous sequence 大于 seen 的 fixture。

预期：未 COMMIT 的 batch 整体不存在；已 COMMIT 的 Fact/Content/Ref/cursor/gap 全部存在；ACK 前崩溃的重放被幂等去重；所有已 COMMIT 的 hubOffset 唯一、严格递增且永不复用（未 COMMIT 的临时 rowid 不可见且允许被 SQLite 复用，retention 可留下空洞）；非法跨字段 fixture 被 SQLite CHECK 拒绝；WAL recovery 后查询正确。

失败：出现半事务、ACK 后丢失、相同 eventId 重复、foreign key 断裂、损坏被静默忽略，或同一 offset 两个事件。

### ADF-014 SQLite canonical 唯一性、完整性与索引重建

方法：存储唯一性、派生索引恢复。

操作：写入包含 Fact、Content ciphertext、External Ref、gap 的基准数据并记录查询结果；执行 `integrity_check/foreign_key_check`；删除并按 Registry migration 重建 secondary indexes；最后在一次性隔离副本中显式删除 `activity.sqlite`、WAL 与 SHM 后重启 Hub。

预期：索引重建前后 Fact rows、内容 hash、event count、filters、correlation、Sources gap 与 Content/Ref 状态不变，完整性检查通过；显式删库后旧 Facts 不会从 App Server JSONL、业务库或 shadow files 自动重建；首期目录没有自动 backup/replica。

失败：存在可查询的第二份 Fact store、删库后旧事实静默复活、索引重建改写 Fact、完整性失败被忽略，或把业务对象扫描结果伪装成恢复数据。

### ADF-015 7 天内容与 30 天事实分别过期

方法：边界值、时间迁移。

操作：用受控时钟构造 retention anchor 为 6d23h59m、7d、29d23h59m、30d 的 content/fact；再构造“occurred 6 天前、今天才从 spool replay”“occurred 在未来、今天 ingest”和已过 30 天才到达的请求；同时给仍在持续写新 Fact 的同一 boot 建普通 gap、loss gap、terminal receipt 三类 29d/30d fixture；执行 retention；查询事实、内容、ref、source gap 和 sweep state。

预期：anchor 永远是 `min(occurredAt, ingestedAt)`，replay 不重置 TTL；7 天前 SQLite ciphertext 被清空，Fact link 保留 digest/length，所关联 `activity_contents` tombstone 保留 kind/expired 状态到 30 天；30 天 Fact/link/tombstone rows 删除；已过 30 天才到达的请求不写 Fact，而以带 eventId/fingerprint 的 terminal receipt 推进 accounted cursor；三类 source gap 都按自身 expires index 在 30 天删除，不被同 boot 新 Fact 延长；迟到 row 仍会被 sweep 命中；没有永久 raw archive。

失败：删除 Fact 时才删内容、内容过期导致 Fact 404、超过 30 天仍静默保存，或清理重写全部历史造成不可接受停顿。

### ADF-016 Quota 与优先级保护

方法：容量、backpressure。

操作：在小 quota fixture 中写大量 Blob、sampled UI、normal tool 和 critical Query/response；触发 80/95/100% 水位。

预期：先清过期 Content/quarantine、checkpoint 并 incremental vacuum，再采样低优先级；7 天内 critical 保留或进入可靠 `spool_events`；任何 spool 删除先在预留 quota 的 `spool_loss_ranges` durable；Sources 显示 quota、dropped 和 gap；业务收到可退避的 429。

失败：无序删除、先丢 Query、磁盘填满导致运行时崩溃，或 loss 不可见。

### ADF-017 Secret 双层拦截和 Content 加密

方法：安全等价类。

操作：在 Query、command、tool args/result、URL、header、`.env` 路径和 evidence excerpt 中放测试 token/cookie/password/private key/high-entropy secret；检查 Producer spool SQLite、`activity.sqlite`、WAL/SHM、export 和 API；轮换一次 Keychain content key 后重读旧/新 row；尝试把两行完整 ciphertext/nonce/tag 互换并解密。

预期：禁止字段不落盘；允许内容被一致替换并报告 redaction；Content/locator 列只含 AES-GCM ciphertext 与非敏感 key ID/version，key bytes 不在目录；同 key nonce 不重复；轮换后旧/新 row 均可按版本读取；跨行置换因 AAD 不匹配而认证失败；database/WAL/SHM 权限为 0600、根目录为 0700；搜索测试 secret 0 命中。

失败：任一 SQLite page/WAL/spool、日志或导出泄漏，只有 UI 打码，key 与 ciphertext 同目录，或 redaction 破坏 event schema。

### ADF-018 Capability 权限与审计

方法：权限矩阵。

操作：分别用 producer append、UI read、export、delete、Learning Agent read token 调所有 API；重放/过期/跨 namespace token。

预期：最小权限生效；producer 不能读，Learning Agent 不能任意 export/delete 或读 source locator；每次 read/export/delete/model job 有无正文的 audit。

失败：共享万能 token、跨 producer 写入、审计泄漏正文，或 Activity Hub token 与 App Server/Auth token 复用。

### ADF-019 Facts 页面只区分 Recorded、Computed 与 Model-generated

方法：真实浏览器、语义边界。

操作：用 `$playwright-cli` 打开 Facts，查看直接事件、Duration/retry computed 字段和一个后续模型摘要 fixture；切 Runtime/Surface/Project/Thread/Run/Kind/Actor/Result filter。

预期：Recorded 和 Computed 清晰区分；模型文本带 run 标识；Facts 不显示未经模型生成的 Goal/Outcome，不显示无显式事件支撑的 Rework；filters 与 API 数量一致。

失败：把 mock Goal/Outcome 当事实、用模型 confidence 百分比、隐式任务分组，或页面数字无法追到 Fact IDs。

### ADF-020 Interaction Timeline 显示完整轨迹与缺口

方法：真实浏览器、端到端。

操作：完成一次包含 Query、Agent message、tool、terminal command、browser、verification 和 completion 的交互；制造一个 gap 和一个 expired content；用 `$playwright-cli` 展开/折叠、打开详情/ref。

预期：actor/action/result 顺序和 ID 正确；高频事件可折叠但仍存在；gap、unlinked、expired/missing ref 明确；不存在的证据不能显示“已验证”。

失败：时间线只剩摘要、隐藏失败/缺口、跳错 Thread/Run，或正文直接进入 `payload_json` 导致页面/接口失控。

### ADF-021 Sources 页面证明覆盖而不是声称覆盖率

方法：真实浏览器、数据对账。

操作：让一个 producer 正常、一个 produced>acked、一个 gap、一个 invalid、一个 inactive，并制造高 commit latency/WAL backlog；对照 producer spool SQLite、Hub cursor、SQLite 状态和 API；用 `$playwright-cli` 查看 Sources。

预期：显示 latest produced/acked、gap range、dropped/rejected、heartbeat、runtime/surface/version、SQLite commit latency 与 WAL/checkpoint 状态；没有无分母的 82%/98% 数字。

失败：所有来源默认绿色、Beta/external 混淆、gap 只在后台日志，或状态不能与 cursor 对账。

### ADF-022 UI 与 Agent 生成使用同一个 AnalysisJob API

方法：等价类、接口一致性。

操作：在 UI 选择相同时间/Project/Runtime/facts 生成一次；再由 CLI/Agent 用同一 filter 生成；比较 job、Pack 与权限。

预期：都创建 AnalysisJob 和 Candidate；使用相同 Context Pack builder/policy；Agent 不能绕过 review 直接发布。

失败：UI 在前端拼 Prompt、Agent 任意扫本机文件、两条链路 schema 不同，或 Agent 自动写正式 Learning。

### ADF-023 Context Pack 冻结、可复现与 coverage 完整

方法：快照、一致性。

操作：创建 Pack 后继续写新 Facts、补齐 gap、让一个 raw content 过期；使用相同 Pack hash 重跑模型。

预期：Pack 中 fact IDs/hash、resolved excerpts、schema、redaction、hubOffset/source watermarks、gap 和 truncated 状态不变；Learning 增量只按 hubOffset 取数，不因迟到 occurredAt 漏事件；新事件不进入旧 Pack；重跑输入字节一致。

失败：模型运行时动态扫库、过期后 Pack 内容漂移、缺少来源缺口，或同 hash 对应不同输入。

### ADF-024 Pack-time DLP 与 Project 模型策略

方法：权限/隐私判定表。

操作：分别使用 `modelAccess=none/local-only/approved-provider` Project，创建包含测试 secret、private excerpt 和 External Ref 的 Pack；切换本地/外部 model provider。

预期：none 不创建可发送 Pack；local-only 禁止外部 provider；approved-provider 只发送脱敏最小 excerpt；locator、完整 Thread/scrollback/header/env 不进入模型输入。

失败：模型持有全库 token、策略只在 UI 约束、secret 通过 External Ref 绕过，或发送内容无法预览/审计。

### ADF-025 Candidate claim、数字与 evidence 强校验

方法：模型输出恶意 fixture。

操作：让模型输出不存在的 evidence ID、Pack 外 ID、错误次数/日期、无证据建议、超出 evidence scope 的泛化结论和合法 Candidate。

预期：非法 Candidate validation failed；数字由系统覆盖/拒绝；每条 claim 有 evidence/counterEvidence；单案例只能是 `single_case` 或缩小适用范围。

失败：引用仅检查格式、模型自报 3 incidents 被接受、好建议无证据也发布，或用模型 confidence 代替 coverage。

### ADF-026 Candidate 审核、编辑、合并与版本不可变

方法：状态迁移。

操作：对 Candidate 分别接受、编辑、缩小 scope、拒绝、合并和标记冲突；对 Published Learning 添加新证据并更新。

预期：人工操作生成 revision/audit；Published version 不可原地改；新证据生成新 Candidate/version；supersedes/mergedFrom/conflictsWith 可追溯。

失败：编辑覆盖模型原文、拒绝删除审计、semantic similarity 自动合并，或旧引用打不开。

### ADF-027 7/30 天过期后 Support Capsule 最小可追溯

方法：保留期、删除优先级。

操作：发布含最小证据的 Learning；让 raw content/Fact 过期；再执行用户删除/tombstone。

预期：自然过期后 Learning 保留 claim、当时的最小脱敏事实片段、hash、Pack/model/prompt/policy 与原始证据已过期状态；用户删除后 capsule tombstone，Learning 进入 needs_revalidation/deprecated。

失败：永久保存完整 Thread/scrollback、只留失效 Fact ID 无法审核，或 Learning 阻止用户删除。

### ADF-028 模型失败不改变事实

方法：故障隔离。

操作：模拟 provider timeout、输出非法 JSON、token 超限、费用限制、进程崩溃和取消；比较前后 `activity.sqlite` Fact row count/content hash 与独立 `learning.sqlite`。

预期：Facts 完全不变；LearningRun 记录失败；可基于相同 Pack 重试；不存在部分发布。

失败：模型回写/修正事实、失败后 Pack 丢失、重复计费无去重，或半个 Candidate 可见为 Published。

### ADF-029 定时/事件 Learning Agent 按 watermark 增量处理

方法：调度、去重。

操作：触发多次 completion/run done/verification；在 quiet period 内继续写事件；执行 daily/expiry sweep 并重启 Agent。

预期：相同窗口聚合成一次 job；只处理 watermark 后新事实；重启不重复生成同 input hash；7 天内容过期前有可见 sweep。

失败：每事件调用一次模型、全库每次重扫、重启重复 Candidate，或 lag/gap 被忽略。

### ADF-030 Published Learning 检索与反馈闭环

方法：端到端、状态反馈。

操作：让 Agent 在匹配/不匹配 Project 与 tool 下检索；使用 Learning 后提交 useful/stale/wrong/unsafe；累计负反馈并创建新版本。

预期：只有 Published version 被检索；返回 `learningId@version`、适用范围和最小证据摘要；retrieved/applied/feedback 成为新的 BehaviorFact；负反馈进入复审而非自动改/删。

失败：Candidate 被注入 Agent、所有经验无边界塞进 prompt、反馈不可追溯，或旧 version 静默改变。

## 需求追溯

| 目标                          | 对应用例               |
| ----------------------------- | ---------------------- |
| 独立主动存储，不扫描现有库    | ADF-001、002、013、014 |
| Stable/Beta/Dev/external 集中 | ADF-003–006、021       |
| 真实 Query/操作轨迹           | ADF-007、008、019、020 |
| 可靠写入与海量数据            | ADF-009–016            |
| 7 天/30 天留存                | ADF-015、016、027      |
| 隐私、权限、删除              | ADF-017、018、024、027 |
| 模型生成而非规则伪造 Learning | ADF-022–026、028       |
| Agent 总结与经验闭环          | ADF-029、030           |

## 执行记录

本文件是实施前验收设计，本轮没有实现 Activity Hub，因此以上用例均未执行。实施时必须逐条记录状态、命令、证据路径、实际结果和阻塞原因；禁止预填“通过”。
