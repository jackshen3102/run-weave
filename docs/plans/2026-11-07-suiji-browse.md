# 随记「浏览」独立模块重构与知乎采集实施计划

日期：2026-11-07。状态：A–E 产品实现、正式服务升级与真实知乎手动闭环已完成；模拟器及桌面交互已执行。真实手机验收由用户排除；自然调度仍等待频率选择与最终配置确认，未启用。

## 1. 决策与范围

本计划替代[原素材计划](./2026-11-07-suiji-materials.md)中「记录内素材分类」和「素材自动进入工作总结」的设计。原有实现和历史验收记录仍是迁移依据，不回退或覆盖其他 Agent 的工作。

- 底部保留四个 Tab：**记录、待办、浏览、工作**。回收站移入右上角「更多」。
- 原素材从记录的功能、数据、查询和 AI 上下文中摘出，统一归属「浏览」。记录的「全部」不包含浏览。
- 浏览承接文章、截图、照片、文字、聊天片段和未来的应用使用记录；来源与内容类型分开建模。
- 第一阶段不分析浏览与工作的关系。浏览原文、图片和派生摘要都不进入工作 Agent 输入、工作事实、工作计数或工作周报。
- 本次自动采集只实现知乎；截图、文字、链接和选图复用既有主动保存能力。微信自动同步、相册自动同步、拍照入口、应用停留时间采集、通用网页爬虫、自动工作关联均不是首版交付内容。
- 现有直接工作依据（Agent 执行回执、明确的本人飞书工作事项）保留。聊天内容一旦经浏览采集入口进入，就不能因来自飞书而被重新认定为工作依据。

视觉参考：[浏览 Tab 图片原型](../../suiji-browse-tab-prototype.png)。这是生成的设计示意，不是已实现截图；卡片内容、照片和时间是样例，不能作为采集证据。

## 2. 当前实现与已验证边界

| 位置                                                                                       | 当前事实                                                         | 本次变化                                                     |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- | ------------------------------------------------------------ |
| `packages/suiji-ios/Sources/SuijiIOS/App/SuijiRootView.swift`                              | 记录/待办/回收站/工作，工作能力缺失时第四项是 AI；素材为记录筛选 | 独立浏览导航与列表状态；回收站改次级入口，保留老服务降级提示 |
| `packages/shared/src/suiji/records.ts`、`materials.ts`                                     | `note` 附带 material，只有 image/text/link 和 sourceUrl          | 新建独立浏览合同，不扩大 note/task 语义                      |
| `packages/suiji-server/src/records/service.ts`、`materials/service.ts`                     | 素材仍在 records；默认全部包含素材；消费回执关联工作导入         | 独立浏览服务及迁移适配；终止工作消费                         |
| `packages/suiji-server/src/storage/attachments.ts`                                         | 附件绑定 record，读取时检查 record 的删除状态                    | 增加浏览附件归属与访问检查，迁移不能丢图                     |
| `packages/suiji-ios/Sources/SuijiCaptureCore/`、`ios/SuijiShare/ShareViewController.swift` | 已有分享、持久队列、图片/文本/链接输入                           | 保存目标改浏览；保留冻结请求、身份隔离和手动恢复             |
| `packages/suiji-ios/Sources/SuijiIOS/Features/RecordEditorSheet.swift`                     | PhotosPicker 手动选图                                            | 浏览编辑器复用选图能力，不声称自动读取相册                   |
| `plugins/toolkit/skills/daily-record/scripts/job.py`、`job_facts.py`                       | browser/materials 被放入 evidence.json，纯浏览概览仍导入工作     | 在材料装配之前分流，并处理旧批次和旧来源配置                 |
| `packages/suiji-server/src/reviews/context.ts`                                             | all scope 使用普通记录查询，get 可读取指定记录                   | 普通/工作回顾无浏览工具及浏览内容，包括按 ID 和附件读取      |
| `packages/suiji-server/src/work-reports/service.ts`、`work-records/sources.ts`             | 周报要求该周期全部工作事实，计数统计全部 work_facts              | 统一有效工作范围；历史混入项需隔离审计                       |

本会话已在用户登录的 Runweave 浏览器中读到 2026-11-06 的 11 条知乎历史（8 回答、3 文章），取得其文字正文，读取前后 11 条历史时间未改变。历史读取跨两页；这只能证明当时接口返回的可见范围，不证明完整访问次数、读完、停留时长、长期登录稳定性或全部手机活动。

观察到的接口：历史 `https://api.zhihu.com/unify-consumption/read_history?offset=0&limit=10`；回答 `https://www.zhihu.com/api/v4/answers/{id}?include=content,paid_info`；文章 `https://zhuanlan.zhihu.com/api/articles/{id}`。www 域的文章接口曾返回 403；专栏域接口当时成功。它们是实测可访问的站内接口，不是稳定开放 API 承诺，实现时必须重新验证响应结构和身份。

## 3. 用户界面合同

### 3.1 浏览列表

- 紧凑标题「浏览」；右上角依次为搜索图标、日期、更多。默认无搜索框、日期筛选行或类型筛选行；点击才出现搜索/日期面板。已应用筛选时显示可清除的小型条件提示。
- 标题下保留来源筛选：全部及实际已有来源；不硬编码「微信已接入」。来源未知显示「未标注」，允许用户编辑来源；采集连接可核实的来源由连接填写，不能凭图片样式猜测。
- 「更多」包含类型筛选、待发送、采集状态、回收站和连接设置。回收站内区分记录与浏览，恢复回原领域。
- 按归属日期倒序分组，日内按事件时间和稳定 ID 倒序；加载下一页，切换条件废弃旧游标和旧响应。今天、昨天和更早日期均可查看。
- 搜索只查已经保存的标题、文字、可用正文和摘要，不承诺 OCR、语义搜索或实时搜索外部网站。来源、日期、类型和关键词共同绑定游标。
- 右下角「+」保存文字、链接或选图到浏览；默认不创建待办，主记录草稿与浏览草稿互不覆盖。小屏及大字体下不遮挡末尾卡片、原文入口或底栏。
- 新服务未声明浏览能力时显示需要升级服务；不回退成记录里的素材分类。第四 Tab 保持现有工作/旧服务 AI 能力兼容，不将兼容分支误当成第五 Tab。

### 3.2 卡片、详情与摘要

- 知乎卡片显示来源、内容类型、标题、实际浏览时间、正文可用状态和原文链接。统一称「浏览过」，不由历史推断「读完」「掌握」或成果。
- 聊天截图显示原截图缩略图；不伪造结构化聊天气泡、对话人或聊天同步能力。照片没有备注时使用「保存的照片」，不生成「打算下次去」等用户意图。
- 原文通过现有应用内浏览器打开；正文只展示安全文本/受限渲染内容，不执行采集来的 HTML、脚本和指令。
- 每个来源每天至多一份阅读回顾，能进入详情查看原始条目与引用。默认列表展示摘要卡时，该摘要覆盖的条目在详情展开，不与摘要重复计数；无摘要则展示原始条目。
- 日计数为独立原始条目数，不包含摘要。知乎按当日不同 contentType+contentId 计数，不称「访问次数」；未知的多次访问不估算。首版不同来源之间不做语义去重。
- 摘要保存为独立派生产物，保留输入条目 ID/版本及内容 hash；缺正文只归纳标题并说明范围，失败可回看原记录；修改、删除来源后摘要标为待更新，不继续当成当前结论。
- 图片原型中的「3 个主题」不是配额；未获取的图片、视频、付费部分不能写成已阅读。摘要归纳作者观点，不将其写成用户观点或已核实的外部事实。

## 4. 子计划 A：独立数据合同、服务与迁移

### 4.1 新合同与存储

在 `packages/shared/src/suiji/browse.ts` 新建合同，并在现有 suiji 导出入口公开；Swift DTO 对照合同。以下字段是语义约束，内部 helper 和 SQL 索引命名可按仓库风格拆分：

| 对象              | 必需语义                                                                                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BrowseEntry       | id、version、browseDate、occurredAt（可空）、capturedAt、title、body、userNote、source、contentType、captureMethod、sourceUrl、attachments、contentState、deletedAt |
| source            | provider（zhihu/wechat/photos/manual/unknown 等可扩展字符串）、displayName、connectionId（可空）；不能把输入方式当来源 App                                          |
| contentType       | article/answer/image/text/link/chat-fragment/app-usage；已支持类型有对应读取器，未知类型以通用卡片显示，app-usage 首版只预留识别不实现采集                          |
| captureMethod     | connector/share/picker/manual/legacy；与来源分离                                                                                                                    |
| contentState      | available/metadata-only/unavailable，加结构化原因；正文太长分块存储/读取，不复用普通 note 的 20000 字限制并静默截断                                                 |
| BrowseConnection  | owner、provider、稳定外部账号标识、绑定机器和 browser profile/group 的配置引用、状态、最近成功时间；云端不存 Cookie、密码或 CDP token                               |
| BrowseObservation | 连接、外部内容类型/ID、源 read_time、observedAt、runId；保存观察证据，不伪造未观察到的访问事件                                                                      |
| BrowseDigest      | owner、日期、来源连接、正文、版本、entryRefs(id/version/hash)、inputRevision、state；不属于 BrowseEntry，也不是 WorkFact                                            |
| BrowseRun         | runId、连接、请求日期范围、分页结果、metadata/content 覆盖、错误、提交回执；complete 只表示本次声明范围读取完成                                                     |

业务日固定 Asia/Shanghai，日期范围包含首尾。事件时间、采集时间和归属日期分开；旧数据缺事件时间时保留 null，界面显示保存时间而非伪造浏览时间。

新增独立 `browse_entries`、`browse_observations`、`browse_connections`、`browse_runs`、`browse_digests`、版本/变化流及附件关联存储。摘要与浏览变更使用独立 revision，不推进 work feedRevision，也不让已有周报因新增浏览而过期。

### 4.2 API 与并发语义

在 `/api/suiji/v1` 下新增以下资源，并用同一服务实现 HTTP 与 MCP：

| 接口（拟新增）                                | 行为                                                                                                      |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| GET /browse/entries                           | source、type、from、to、q、trash、cursor、limit；返回条目、全筛选范围的日计数、nextCursor、browseRevision |
| POST /browse/entries                          | 主动保存，captureId 幂等；owner 来自鉴权，不能由 payload 指定                                             |
| GET/PATCH /browse/entries/:id                 | 详情/编辑，PATCH 带 expectedVersion；保留采集原文与用户备注边界                                           |
| POST /browse/entries/:id/trash                | 删除/恢复，带 expectedVersion；不删除远端知乎历史                                                         |
| GET /browse/changes                           | 独立冻结上界的变更游标；包含删除，绑定账号与服务身份                                                      |
| GET /browse/connections、GET /browse/runs/:id | 读取连接状态、范围、失败原因及导入回执                                                                    |
| POST/PATCH /browse/connections                | 由已授权采集配置流程建立或停用连接，绑定已核实外部账号；改变账号须新连接，不复用旧检查点                  |
| POST /browse/imports                          | 已授权本机采集器提交固定 runId、连接身份、观察项和覆盖；原子发布并返回 created/updated/unchanged          |
| GET /browse/digests、POST /browse/digests     | 读取/发布摘要；校验所有输入版本仍有效，禁止引用删除项；相同输入重跑不增版本                               |

新增 MCP 工具对应 `list_browse_entries`、`get_browse_entry`、`import_browse_entries`、`publish_browse_digest` 及必要读写接口；它们只提供给浏览任务，不装配进工作回顾上下文。附件上传复用底层能力，但读取、绑定及删除检查必须识别所属领域和 owner。

同一连接、内容类型、内容 ID、业务日期唯一形成一个浏览条目；同日新 read_time 更新该条目的 last observed 信息，观察表保留实际看到的时间。跨日再次出现形成另一日条目，不移动已采到的昨天记录。采集更新不得覆盖 userNote。手动 captureId 与来源内容身份分别去重。正文修订有 hash；日摘要按实际有效输入版本更新，不把自身作为下一轮输入。

超时、限流、未登录、身份变化、解析失败分别返回状态；不得统一记为空列表。导入丢响应时沿用原 runId/幂等键和冻结 payload 查询或重试；内容不同不能复用原键。删除的采集条目保留 tombstone，相同身份重采不能自动复活。

### 4.3 原素材迁移与兼容

1. 先 dry-run 清点每个 owner 的有效/已删除素材、附件、captureId、修订、跟进、旧处理回执、待发送协议及可能已导入的工作事实，输出计数与 hash。只迁移当前有 material 的对象，不猜测普通笔记是否曾是素材。
2. 追加迁移，不修改已有 `.cjs`。旧 material 一对一映射 BrowseEntry，保留 ID 映射、日期、正文、备注、来源 URL、删除状态、附件字节与顺序、版本历史。缺少来源明确置 unknown；旧 image 不能自动判为照片或截图。
3. 附件增加可验证的浏览归属和复合外键；在事务中迁移关联，避免同一附件同时可写绑定两个领域。普通记录附件继续按旧合同工作；归档修订仍可回查原附件，不能依赖已删除的关联。
4. 切换后旧素材在 records 列表、搜索、标签统计、变化流和默认 AI 回顾中不可见；旧 get/edit/附件路径不能绕过领域检查。普通记录变化流对迁出条目发失效事件，使旧本地索引移除；保留归档/映射供兼容和审计，不将归档继续作为 note 返回。
5. 旧版分享扩展发送的 material payload 通过有界兼容适配器落到浏览。保留原操作的幂等摘要与已提交响应；不先改写未知结果的冻结请求。旧 captureId 再次提交不得新增第二份数据。
6. 新 App 升级本地草稿与队列时先按原请求确认 sending/unknown 的结果，再迁移引用。未提交 queued 草稿可转换目标但保留 captureId/身份/附件；上线、前台恢复和联网不自动发送。无法确认则保留待确认，不丢弃。
7. 旧客户端通过迁出记录 ID 的读写返回明确的「已迁入浏览，需要新版」错误；兼容适配器只为旧分享和旧冻结操作提供结构化确认，不把正文暴露回普通工作工具。禁止 material:null 将迁出对象重新变成普通笔记。
8. 清点旧跟进与修订：如有，迁入浏览的只读历史/备注展示并保留引用，不丢弃；首版不增加新的浏览跟进工作流。

发布时按 server→兼容层→App/分享扩展→采集器顺序开启能力。迁移在隔离数据库备份恢复上验证后再发布；每个 owner 切换须有事务/迁移锁，旧写入不可在复制间隙漏掉。回滚优先关闭新采集与入口、使用能识别新库的修复版本；不能把不理解新 schema 的旧镜像直接连上。恢复旧数据库必须配合附件和切换后写入备份，避免回滚丢数据。

## 5. 子计划 B：彻底隔离工作链路

- `daily-record` 在装配 evidence 前不调用 suiji-material 和 browser-visit 的工作采集支路；它们以后归浏览管道，不能只在提示词中说忽略。
- 旧配置声明 browser/materials 时提示迁移并阻止其作为工作来源。以切换日期关闭旧 work source 生效区间，维护工作覆盖范围，不能因被移走的来源导致工作日永远 partial，也不能改写过去的采集回执。
- 切换时清点 active batch、evidence.json、priorFacts、冻结导入与本地索引。未提交旧批次废止并重新采集；结果未知的旧请求仅核对原回执，不能再发布含浏览的 payload。恢复必须重新创建工作 Agent 上下文，旧聊天消息中的浏览材料不能沿用。
- 工作导入服务拒绝新 `browser-visit`、`suiji-material` 或浏览引用，混合工作来源也不能绕过。浏览来源不允许通过「项目为空」「documented」等状态伪装进入。
- 工作 Agent 的工具服务只暴露工作范围，服务端对 list/search/get/附件/缓存及派生历史执行相同隔离；不给该任务同时装配通用浏览凭据。该保证针对产品管理的工作流程，不声称能约束用户任意外部 Agent 手动粘贴内容。
- 普通记录回顾也不能因 all scope 读到浏览。独立浏览摘要 Agent 只获取浏览证据，不能调用工作写入工具。
- 工作列表、日计数、周报输入集合和发布 sourceFacts 校验共享同一有效工作范围；仅浏览数据变化不得改变这四项。
- 迁移审计若发现旧浏览已经混入 work_facts：纯浏览/素材来源标为 excluded；混合来源标为 needs-review；保留原文、来源和人工字段，不删除。两者均不进入新的工作 Agent 输入与统计。独立工作证据经人工核对后可恢复 eligible，不能把排除内容直接送回工作 Agent 请求它自行判断。
- 已生成历史周报不静默改写，受污染来源影响的周报标注需复核，后续工作 Agent 不将其作为证据。人工编辑周报保持保护。迁移审计无此类数据时记录 0，不杜撰污染。
- 屏幕来源不在本轮整体移除；已经被定义成浏览截图/使用记录的条目必须隔离。已有独立工作执行证据的 screen-timeline 行为保持原约束，不借此扩大采集范围。

## 6. 子计划 C：知乎采集和独立阅读回顾

### 6.1 执行位置与身份

采集运行于用户已登录知乎的那台 Mac，通过 `$toolkit:using-rw` 解析绑定的 Runweave Profile/Group，再由 `$toolkit:playwright-cli` 附着现有浏览器。不在云端重新登录，不复制 Cookie、密码或签名，不创建第二个隐式账号环境。需要登录时让用户在原浏览器完成。

每次先读取可验证的稳定知乎账号标识，与 BrowseConnection 绑定比较；不能仅凭可变昵称判断同一人。无法取到稳定标识则阻止自动导入，不能跨账号串数据。开始与结束均核对身份；期间切换账号则本批次不提交。

首次仅选择昨天和今天作为默认范围，过去日期由显式参数提供；不默认导入当前保留的全部历史。本机会话和云端 owner 双重绑定。单连接只允许一个运行持有带期限的执行锁，过期接管也沿用已持久化批次身份。

### 6.2 采集流程

1. 保存本次范围和 runId。若浏览器不可用、登录失效或返回验证页，记录 unavailable/needs-login；不关闭用户页面、不自动登出、不记成零条。
2. 在同源 API 页面上下文读取历史；www→api 的带凭据跨域请求曾失败，不能据此放宽浏览器安全设置。只允许预先定义的知乎源站和路径，分页 next 必须校验 origin/path。
3. 按 source read_time 过滤上海业务日，持续分页到跨过下界或服务 is_end。限制每次最多 100 页，每页最多 20 项，单请求 15 秒，限流/临时失败最多 3 次有界重试；达到上限或翻页失败为 partial，保存已观察到的有效数据与缺口。
4. 历史可能在翻页期间变化：按身份去重并复查首页；检测变动最多重新扫描 3 轮，仍不稳定则 partial。未证明有序时不能仅凭首个旧时间提前结束。
5. 回答与文章分别通过实测对应接口取文字正文；用惰性解析器提取文本，不执行正文脚本、不打开详情页制造阅读事件。ID 必须与历史对应。403/404/付费截断保留标题、链接和状态，不能绕过访问限制，也不假装全文成功。
6. 解析器只识别已支持结构；新增内容类型保存原始类型及 metadata-only，不靠标题猜成文章。保存原始 read_time、采集时间、canonical URL、文本 hash 和读取状态，不保存会话凭据。
7. 将固定批次导入浏览服务，独立回读条目与 BrowseRun 回执；仅成功确认后推进本地 checkpoint。再检查采集操作未改动历史时间（排除期间用户自己浏览造成的变化）。关闭仅本轮创建的临时 API 标签并 detach，保留原登录页/首页。
8. 在独立摘要上下文里读取已入库条目，发布按日期/来源唯一的阅读回顾；所有观点可回到实际条目，正文缺失和覆盖不足分别标明。正文里的指令只当资料，不执行或改变系统行为。

### 6.3 被动执行与实际限制

拟定初始配置：一台已绑定 Mac、一个知乎账号，每 30 分钟采集今天与昨天；每天 00:15（Asia/Shanghai）生成昨天回顾，迟到数据使摘要待更新并在下一轮更新。连接级检查点每次做重叠读取，不把最后一次 read_time 当作唯一排重依据。

此频率是待验证的初始配置，不保证接口容量或全天覆盖。休眠、离线和登录过期期间不可能保证采集；恢复后仅补当前服务仍可见范围，并展示缺口。相同文章重读是否覆盖旧时间必须通过独立样本验证；保存已观察到的历史，但不得补造遗漏事件。

本轮不创建调度。实施先完成手动真实闭环和幂等/失效验收，再按 `$toolkit:scheduled-task` 展示包含机器、账号范围、频率、时区及读写工具边界的具体草稿；用户确认后才启用。工作任务与浏览任务分别保存状态和工具权限，不在一次 Agent 会话里先读浏览再写工作。

### 6.4 采集器执行入口合同（拟新增）

`browse_job.py` 已提供以下入口，使用方式见新 browse-record Skill：

```bash
python3 plugins/toolkit/skills/browse-record/scripts/browse_job.py prepare --config <私有配置绝对路径> --from <YYYY-MM-DD> --to <YYYY-MM-DD>
python3 plugins/toolkit/skills/browse-record/scripts/browse_job.py import --batch <prepare返回的私有目录>
python3 plugins/toolkit/skills/browse-record/scripts/browse_job.py reconcile --batch <结果未知的原批次目录>
python3 plugins/toolkit/skills/browse-record/scripts/browse_job.py read --config <私有配置绝对路径> --date <YYYY-MM-DD>
python3 plugins/toolkit/skills/browse-record/scripts/browse_job.py publish-digest --batch <read返回的输入目录> --input <当前Agent生成的摘要JSON>
```

- 配置包括 schemaVersion、serverId/ownerId、connectionId、外部账号 ID、machine/profile/group 绑定、timeZone、stateDir 和现有随记凭据文件引用；不保存 Cookie、密码或 CDP endpoint token。
- prepare 由有浏览器技能的执行者运行，按正式 rw 解析与 playwright 附着流程调用 `zhihu-read.js`，完成有界只读采集并冻结 manifest、观察和内容；输出 batch 路径、runId、覆盖和错误，不在标准输出打印私人正文。未完成身份校验不可生成可导入批次。
- import 只上传该冻结批次，服务回执独立回读；reconcile 只恢复原操作身份，不重新采集后覆盖未知请求。阶段状态持久化为 prepared、pending、confirmed 或 failed，持久锁防止同连接并发重复提交。
- read 只读本次来源/日期的有效浏览条目及内容版本，冻结摘要输入；当前 Agent 阅读后生成 `title/body/entryRefs/inputRevision`。publish-digest 校验引用集合及版本，通过隔离摘要工具写入；不暗中启动额外模型改写事实。
- 配置、批次和正文目录设为仅当前用户可读；接收任何 credential 或 endpoint token 的中间结果不得输出到日志。示例命令中的动态路径由执行环境实际提供，不写用户的真实账号与凭据到仓库。

## 7. 任务拆分与代码落点

执行者先读各包最近的 AGENTS.md，重新检查最新工作区；下面新路径是拟新增模块，不表示已经存在。

| 阶段               | 文件范围与职责                                                                                                                                                                                                    | 完成条件                                                                   |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| A1 合同/服务       | 新 `packages/shared/src/suiji/browse.ts`；新 `packages/suiji-server/src/browse/{schema,service,repository,imports,digests}.ts`、`src/http/browse.ts`、`src/mcp/browse.ts`；接入 `http/app.ts`、MCP 装配及能力声明 | 独立 API、owner 隔离、分页、版本/幂等、摘要引用校验可通过真实 HTTP/PG 验证 |
| A2 迁移/兼容       | 新追加 migration 与迁移审计脚本；现有 `records/{service,changes,repository}.ts`、`materials/`、`storage/attachments.ts`、`schema.ts`                                                                              | 备份恢复演练、切换期间写入无遗漏、附件/草稿/旧请求完整、普通记录不受损     |
| B 工作隔离         | `daily-record/scripts/job.py`、`job_state.py`、`job_facts.py`、旧 `job_materials.py`/`job_browser.py` 调用方；`work-records/{schema,imports,service,sources}.ts`、`work-reports/service.ts`、`reviews/context.ts` | 材料进入模型前过滤；未知旧批次不重发；列表/计数/发布依据一致               |
| C iOS/分享         | `SuijiRootView.swift`；新增 `State/BrowseModel.swift`、`Features/Browse/`；DTO、APIClient、CaptureCore、ShareViewController、原素材组件                                                                           | 四 Tab、低频筛选、列表详情、原文、回收站、主动保存及队列迁移               |
| D 知乎适配         | 新 `plugins/toolkit/skills/browse-record/SKILL.md`、`scripts/browse_job.py`、`scripts/zhihu-read.js`、`references/zhihu.md`；复用正式 rw/playwright 工具边界                                                      | 持久批次、身份核对、真实历史与正文导入、独立摘要；首版不扩展其他自动采集器 |
| E 兼容客户端与说明 | `frontend/src/services/suiji.ts`、`frontend/src/features/suiji/` 必要的迁出提示与旧字段处理；daily-record Skill/引用、Suiji server/iOS README、新浏览 Skill 的安装打包发现入口                                    | Web 不把浏览显示为笔记；新能力可被安装后的任务发现，移除旧自动工作消费说明 |

顺序：A1 → A2 与 B → C → D → E/完整验收。不得先把知乎写入 work_facts 再等待后续拆库。Web 首版只保证兼容和正确排除，不要求复制整套移动浏览 UI。

## 8. 验收计划与证据

独立测试计划：

- [浏览领域重构与隔离](../testing/suiji/browse-domain.testplan.yaml)：迁移、导航、主动保存、数据权限、工作输入隔离及统计。
- [知乎采集端到端验收](../testing/suiji/browse-zhihu.testplan.yaml)：真实历史/正文、分页、身份、幂等、异常、摘要、手机回看和自然调度。

这些用例取代旧 `materials.testplan.yaml` 中记录内分类/旧状态断言，以及 `daily-record-materials.testplan.yaml` 的工作消费断言；实施时同步更新或退役旧冲突用例，不同时要求两套相反行为通过。既有分享队列、连接、附件、跟进和工作事实用例的无冲突不变量继续复用。

验收分层：

1. **真实手动链路**：使用已授权知乎账号读取执行当日的昨天；先冻结实际可见基线，导入隔离随记 owner，真实手机在浏览查看标题/日期/正文/原文及摘要。不得要求永远返回 2026-11-06 的 11 条；历史已清理时使用新的可控样本。
2. **工作隔离**：隔离 owner 中独立准备一条工作事实，以及正文含唯一串的知乎样本、截图、照片、文字、聊天片段与摘要。实际运行工作采集/检索和日报周报生成，检查最终模型请求或工具返回的边界产物里不存在这些串、ID、附件、URL；工作条目数量和发布引用保持不变。只看最终回答没有提到浏览不算通过。
3. **故障与权限**：在隔离连接、独立浏览器 Profile 和受控服务响应中建立失败样本，不注销用户当前真实账号，不删除其知乎历史。fixture 能证明错误处理，不替代真实知乎正常链路。
4. **自然调度**：启用获确认的计划后，至少一次自然采集触发和一次自然摘要触发各自回读。手动运行、定时配置截图和构建成功均不能代替实际调度结果。

受保护证据目录建议 `.runweave/suiji/browse-<日期>/`；保存 runId、身份摘要、HTTP 状态、分页覆盖、内容 hash、导入前后计数、工作输入排除证明和真实 UI 截图。正文/个人历史不提交 Git，凭据不落输出。手机截图注明 DEV/正式设备，浏览器、模拟器与真机证据分别报告。

实现后的检查命令（按阶段执行，非本轮已执行结果）：

```bash
pnpm --filter @runweave/shared typecheck
pnpm --filter @runweave/suiji-server typecheck
pnpm --filter @runweave/suiji-server lint
pnpm --filter @runweave/suiji-server build
pnpm --filter @runweave/frontend typecheck
pnpm --filter @runweave/frontend lint
pnpm architecture:check
pnpm --filter @runweave/suiji-ios mapping:check
pnpm --filter @runweave/suiji-ios ios:build --simulator <共享池申请的UDID> --configuration Debug
pnpm testplan:validate docs/testing/suiji/browse-domain.testplan.yaml
pnpm testplan:validate docs/testing/suiji/browse-zhihu.testplan.yaml
pnpm docs:check
git diff --check
```

mapping:check 扩展为读取真实浏览 HTTP 响应后通过生产 Swift Codable 往返；不使用伪造 JSON 代替合同验证。原生交互用 `$toolkit:agent-device`，浏览器用 `$toolkit:playwright-cli`；按共享模拟器池和设备入口规则执行。不新增单元测试。

最终交付必须分别报告：代码/格式检查、隔离迁移、真实知乎读写闭环、手机交互、工作输入隔离、部署和自然调度。任何未执行项标为未验证/阻塞；特别是工作输入隔离未通过时，不允许正式接入浏览采集。

## 9. 实施与验证结果（2026-11-07）

A–E 已实现：独立浏览合同、schema 14–16 追加迁移、HTTP/专用 browse MCP、工作专用 MCP、
迁移审计与旧请求兼容、四 Tab 原生界面、独立草稿/分享队列、知乎采集与摘要、Web 兼容及 Skill。
插件按目录发现 browse-record，已通过正式 toolkit:sync 安装；新版后台会话才能加载更新。

已执行的验证：

- shared/server/frontend typecheck、server/frontend lint、server build、架构检查、文档与 YAML 校验；
  两份浏览计划各 18 条 required 的格式通过，不把格式通过计作逐条行为通过。没有新增单元测试。
- 隔离 PostgreSQL 18 + 实际 HTTP/MCP：版本与幂等冲突、owner/游标隔离、长正文分块、附件领域与删除、
  摘要输入版本/哈希/顺序及失效、删除后重采不复活、采集保留备注、独立工作 revision/计数。
- 丰富旧库恢复：图片、Markdown、已移除的历史附件与跟进附件逐字节核对；迁移事务锁阻止复制间隙写入遗漏；
  旧直接 ID 读写/取消素材不能绕回记录；切换前、切换后备份分别恢复验证。
- 工作隔离：实际 daily-record 采集器材料、工作专用工具返回、工作导入和周报发布引用均排除浏览唯一串；
  混合引用也拒绝；旧未知导入只查原回执，丢响应后只恢复原请求身份。旧浏览工作合同已退役。
- 真实知乎：扫描接口当前可见的 10 页，仅保存上海 11 月 6–7 日的 16 条；15 条文字正文、1 条不支持类型仅元数据。
  昨天为 11 条（8 回答、3 文章），实际读完正文后发布独立阅读回顾。前后历史时间不变；重采不增加条目。
- 受控浏览器响应：分页失败、循环/恶意 next、100 页上限、持续变化的历史、未登录、前后身份切换、
  403/404/付费/未知类型、恶意 HTML 及三次限流重试均验证边界；这是受控异常验证，不是真实知乎异常样本。
- iOS 模拟器：当前源码构建安装；四 Tab、浏览来源/搜索、正文、应用内原文浏览器、主动保存与普通记录排除已操作。
  用旧格式 queued 和已提交 uncertain 队列数据重启新版 App：未自动发送、原冻结字节保持；
  手动确认后 queued 转为浏览、uncertain 复用旧请求且不重复创建，持久确认回执保留。
  删除与恢复通过独立 HTTP 回读确认；实际加载 31 条隔离旧日数据的下一页后，前页摘要仍可打开，摘要的 11 个编号引用可回原始条目；回收站使用独立状态。实际浏览 HTTP 响应通过生产 Swift Codable 往返。Web Beta 的真实随记抽屉仅显示普通记录。

受保护的执行证据在 `.runweave/suiji/browse-2026-11-07/`；模拟器交互在
`.runweave/mobile-qa/suiji-browse-20261107/`。私人正文、数据库与凭据不提交 Git。

## 10. 正式切换与剩余验收

正式随记服务已从 schema 13 升级到 16；新镜像来源归档 SHA256 为
`5fc15ea15c51e6c5b06680018866c466831c2851e45fa2e94fe00c12dc1d0872`，
不是 Git commit。归档内容与本次 server/shared 源码逐文件一致。

升级前静态数据库及附件已异机复制并逐文件校验；新镜像先在隔离容器恢复、迁移、执行 owner 切换并做实际 API 读写，
再迁移正式库。236 条记录、380 条跟进、116 份附件保留，116 份附件哈希均匹配，原有 27 张表旧字段在追加 schema 时保持。
正式库没有当前 material 对象，迁移数为 0；工作审计发现 6 条纯浏览、32 条混合事实，分别 excluded/needs-review，
保留原文和人工字段。实际 Mac 的旧浏览来源与本地映射已隔离，191 个独立工作身份保留，使用新的 work 专属凭据。

正式 HTTPS 登录及独立回读通过；正式浏览已接收本次真实 16 条知乎资料，昨日阅读回顾已发布并回读。正式重采 created=0、updated=0、unchanged=16；前后全部 637 条工作事实、599 条有效事实、work feedRevision=41 及周报哈希保持一致。
普通个人凭据、服务配置、Codex 登录和既有工作任务定义保留。Mac 实际使用的独立安装 daily-record 与兼容 Suiji CLI 也已备份后更新，避免仅更新插件却继续运行旧浏览支路。新浏览调度与既有周报 work 专属凭据迁移均已准备只读校验草稿；定时任务尚未创建或修改。

剩余验收范围明确如下：

- 真实手机上的 UI、分享扩展及设备升级：用户明确排除，本轮不执行；模拟器证据不能替代真机。
- 自然调度：当前 Backend 只支持 daily/weekdays/weekly/once，没有每 30 分钟规则。
  已准备每日 00:15 的替代草稿并执行只读校验，等待用户选择频率并确认最终完整配置。
  不创建 48 个 daily 任务模拟周期，不把手动执行或配置校验冒充自然触发。
- 在用户确认并启用后，仍需独立回读至少一次真实自然采集与摘要运行，才可关闭这两项门禁。
  后台浏览按运行自己的 Browser Group 解析，不借用交互终端组；仍核对已授权 Mac/Profile/稳定账号。
