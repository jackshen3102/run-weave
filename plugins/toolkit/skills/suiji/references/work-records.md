# 工作事实 API 与 CLI

能力：HTTP info 和 MCP get_service_info 的可选 features.workRecords。缺失时不调用新接口。工作日期为有效 YYYY-MM-DD、Asia/Shanghai；不以 createdAt 代替。状态为 progress/discussed/documented/attempted/agent-reported/verified，项目可null。标题和项目最多80 Unicode标量，正文1–4000标量，保留原文。

App HTTP 根 `/api/suiji/v1/work-facts`：GET列表（from/to两端包含，单边可选，limit默认30最大100）、GET `/:id`、POST创建、PATCH `/:id`（expectedVersion+明确提供的字段）、POST `/reclassify`（items[{id,expectedVersion}]+project）、POST `/reclassify/undo`（items[{id,expectedVersion,project}]）。撤销只恢复项目且整批版本检查，不回滚正文快照。所有App写入沿用Bearer和Idempotency-Key；无App导入HTTP入口。

MCP工具：list_work_facts（同列表）、get_work_fact({factId})、import_work_facts({idempotencyKey,input})、edit_work_fact({factId,idempotencyKey,input})、reclassify_work_facts({idempotencyKey,input})。actor和owner来自设备认证，不能输入指定。未添加到旧AI回顾的检索桥。

列表响应 items/days/nextCursor/feedRevision。days的count是整日总数；coverage为complete/partial/unknown。游标绑定服务、owner、日期和revision。WORK_FEED_CHANGED(409)带currentFeedRevision，丢弃旧分页并重读；不得拼接变化前后的半份数据。

CLI配置、设备token和请求恢复沿用主Skill，不复制鉴权客户端。新增命令：

- `work-prepare --input <0600统一包> --out <新目录>`：只读身份/能力/当前revision和全部事实；生成prepared.json与preview.json，保存稳定键索引，不发送业务写。
- `work-import --input <prepared.json> --request <全新文件>`：先落盘冻结完整请求，再调用MCP；校验回执和逐条详情，确认后删除待确认文件。保留importId/回执作为本轮结果。
- `work-list --from <date> --to <date>`：读完全部分页，分页变化时明确失败，不输出半份成果。
- `work-get --fact-id <UUID>`：当前事实及版本。
- `work-reclassify --input <0600 JSON> --request <全新文件>`：输入items[{id,expectedVersion}]/project，原子修改项目并回读；撤销可省略全局project，在每项提供原project和成功后的expectedVersion。
- `retry --request <原文件>`：仅用户明确要求时手动重放；身份、键、目标与完整参数不变。网络、读取或启动不会自动重试。

统一包为schemaVersion=1、sourceNamespace、sourceCollectedAt、basedOnFeedRevision、days[{date,requestedScopes,receipts,facts}]。完整结构见 shared/suiji 的 ImportWorkFacts；跨渠道导出见 daily-record Skill 的 references/suiji-work-records.md。包最多100条且200KiB，按完整日期逐包prepare/提交/确认，不并行冻结旧revision。sourceCollectedAt来自实际回执，不是导出时钟。

importId和created/updated/unchanged是本次导入互斥计数；protected为人工字段被保护的附加条数。同键返回原回执；同稳定身份同源快照不新增版本。人工清空项目仍为保护字段。来源倒退、同时间不同快照明确拒绝，整包回滚，遗漏条目不删除旧事实。

sourceRefs只保留原生channel/sourceScope/nativeId/revision/hash，不上传原始聊天、绝对路径或凭据。只有请求范围均complete且事实为空，才说明范围内无记录；partial/unavailable/未导入不能写成没有工作。工作事实无附件/删除/任务完成能力。

定时 Daily Record 可使用显式保护配置的 `work-reconcile --request <原冻结文件> --job-config <任务配置>`，
仅在 autoPublish=true、目标身份及来源范围匹配时，对工作事实导入最多原样恢复3次并独立回读。
它不改变人工 retry，也不为笔记/待办操作增加自动重试。详见 Daily Record 的 scheduled-reporting.md。
`work-sources --from <日期> --to <日期>` 调用只读 list_work_sources，要求 features.workSources。
schema11 的预期来源登记用于判断全来源完整性；无登记旧日期保持unknown，不再把已收到部分来源的complete当全天完整。
