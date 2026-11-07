# 本机来源适配器合同

适用于 Daily Record 工作来源与独立 Browse 来源。统一的是来源回执及身份语义，工作与浏览仍使用不同的采集上下文、配置、状态、凭据和服务写入入口。新来源先实现此合同及领域适配，不因写入配置而自动获得采集授权。

权威构造入口为 [`source_adapter.receipt`](../scripts/source_adapter.py)，仅依赖 Python 标准库，不读取配置、正文或凭据，也不联网。该回执是本机采集产物，不替换服务已有的 `WorkReceipt`、`BrowseRun` 或冻结导入协议。

| 字段                               | 合同                                                                          |
| ---------------------------------- | ----------------------------------------------------------------------------- |
| `schemaVersion`                    | 当前为 1                                                                      |
| `source.domain/scope`              | `work` 或 `browse`；沿用稳定机器、账号或连接绑定的 scope，不以昵称作身份      |
| `items[].id`                       | 来源原生身份或稳定锚点；不得用本轮随机 UUID 当来源条目 ID                     |
| `items[].version`                  | 来源版本或内容哈希；重跑相同材料保持不变，内容变化产生新版本                  |
| `items[].occurredAt`               | 带时区的实际发生时间，必须落在请求范围；不以采集时间代替                      |
| `collectedAt`                      | 带时区的本次采集时间                                                          |
| `range.from/to/timeZone`           | 左闭右开时间窗口；业务日期为 Asia/Shanghai                                    |
| `range.effectiveFrom/expectedFrom` | 接入日期与本窗口中开始要求覆盖的时刻；未登记接入日则为 null，不倒推出历史覆盖 |
| `range.beforeEnrollment`           | 固定为 unknown；显式历史补采也不把接入前未观察的日子当完整或无活动            |
| `status/errors`                    | complete、partial、unavailable；失败回执无条目，有独立错误原因，不伪造空成功  |
| `coverageMode`                     | 固定为 recorded-only；只描述本次可见记录，不推断全部工作、阅读时长或阅读完成  |
| `itemsRevision`                    | 对去重并排序后的身份、版本和时间计算摘要；不包含采集时间，便于核对重跑        |

同一回执中的条目身份不得对应冲突版本。来源条目 ID、工作事实 eventKey 和随记条目 ID 是不同层次：原生材料先按身份关联，语义合并后的工作事实继续沿用 eventKey；浏览仍按连接、内容类型、内容 ID、上海日期入库去重。已存在的服务幂等键、冻结请求和独立回读规则保持生效。

## 工作来源

[`job.py`](../../daily-record/scripts/job.py) 在每个日期目录生成 `adapter-receipts.json`，路径保存在批次的 adapterReceipts 中。Agent 原始消息时间、飞书 create_time、屏幕跨度起点均保留到 evidence；条目版本分别使用正文哈希、消息快照哈希、卡片 revision 与 hash。

每个 Agent provider 独立执行和验收。某 provider 的命令、结构或身份错误只把该 scope 标为 unavailable，不提交该来源条目；飞书读取失败、账号变化及屏幕导出失败同样隔离，不能影响其它来源。飞书账号变化不替换已绑定身份；上下文失败保留该来源 partial。汇总日只有预期来源全部 complete 才完整。

现有 Agent/飞书接入日沿用 job.startDate；屏幕沿用明确的 effectiveFrom。服务的预期来源与缺报判断仍以管理员登记的 WorkSource 生效区间为准，未登记的旧日期是 unknown。新来源必须显式提供自己的接入日期并完成来源登记、配置迁移及权限核对，不追溯制造接入前缺报。

## 浏览来源

[`browse_job.py`](../../browse-record/scripts/browse_job.py) 为新批次生成 `adapter-receipt.json`，成功、部分成功和失败均可核对。来源身份为 connectionId，实际账号在采集开始与结束校验；条目身份为内容类型、原生内容 ID、上海日期，版本由标题、正文、来源 URL、内容状态计算。

私有配置可声明 effectiveFrom。默认采集范围不早于该日期；显式指定更早的 from 可作已授权历史补采，回执的 expectedFrom 仍从接入日开始，接入前保持 unknown。旧配置没有该字段时 expectedFrom 为 null，不因某次历史读取成功而推定它从何日开始应当覆盖。

每个连接有独立锁、批次、失败回执与恢复键。单连接失败不修改工作状态或其它连接；未来增加来源时，编排层按连接分别处理失败，不用一个来源的成功替代另一个。HTTP 登录失效不是零条历史；正文缺口与历史范围分别记录，临时缺正文不清空服务已保存的正文。

旧冻结批次保留原配置、材料和导入请求，不补写新字段改变其摘要。旧验证证据可以继续证明对应行为；新增回执格式不能倒推旧运行已经产生同版回执。
