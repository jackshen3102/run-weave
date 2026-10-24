# 工作事实进入随记

仅在用户要求保存到随记时执行。先按本 Skill 采集、阅读和核对材料，再合并同日同事项；不调用模型自动改写事实。不要把已有日报、周报或 Agent 派生成果再次当新工作导入。

使用本次可用的 `toolkit:suiji` Skill 及其 `scripts/suiji.py`，从当前加载位置定位，不写死全局 cache 版本。缺依赖或服务未声明 `features.workRecords` 时保留本地成果，不声称已写入。

## 统一包与身份

精确合同见 `@runweave/shared/suiji` 的 `ImportWorkFacts`。包为 schemaVersion=1、sourceNamespace、sourceCollectedAt、days；prepare 补入只读取得的 basedOnFeedRevision。

- sourceNamespace 固定于一个导出流，不用 collectionId、临时目录、标题或机器绝对路径。
- externalKey 固定标识某日某事项，eventKey 固定标识事项。飞书首次可采用 `日期:eventKey`。本机首次由执行 Agent 给事项分配键，保存受保护的映射，下次复用。不能从改变后的正文重新计算身份。CLI 在连接配置旁保留 `.work-identities.json`，校验稳定事项键并记住成功的事实 ID。
- 每天包含 date、requestedScopes、receipts、facts。工作日期固定 Asia/Shanghai。每个请求范围恰有一条实际回执：sourceScope、status（complete/partial/unavailable）、collectedAt、from、to。from/to 是该工作日上海零点到下一日零点的 UTC 时间，左闭右开。
- 包的 sourceCollectedAt 必须等于回执最大实际采集时刻。每条事实的观察时刻由它引用的范围回执决定。不能用导出时间替代原文读取时间；旧材料缺回执时说明缺失，不能编造 complete。核对存档只能声明存档范围及实际读取时刻，并保守使用 partial。
- 事实字段：externalKey、eventKey、title（1–80标量）、statement（1–4000标量，保留正文）、status、project（可为null）、sourceRefs。sourceRefs 仅传 channel、sourceScope、原生 nativeId、可选 revision/hash；不传路径、URL、完整聊天、JSONL、token 或凭据。一个事实保留全部核对依据，不在界面展示来源编号。
- 本机材料 ID 需解析回原生会话/事件身份。可用 threadId 作 nativeId、材料 textSha256 作 hash；不要上传 locator.path。飞书消息使用 message_id，文档使用 canonical Docx token，Wiki 别名不重复计。

状态映射必须区分两种 `reported`：

| 输入                                                        | 随记状态       |
| ----------------------------------------------------------- | -------------- |
| 本机 action=reported                                        | agent-reported |
| 本机 action=changed                                         | progress       |
| 本机 action=verified                                        | verified       |
| 本机 discussed/attempted                                    | 原值           |
| 飞书试验 status=reported                                    | progress       |
| 飞书 agent-reported/discussed/documented/attempted/verified | 原值           |

保留“Agent 报告”“已触发但未确认完成”“未验证收益”等正文限定。分类可空，不把仓库路径充当项目名字；不能据群名强行归属全部事实。

## 提交闭环

在受保护配置和设备凭据环境下执行现有随记 CLI：

```bash
python3 "$SUIJI_SKILL_DIR/scripts/suiji.py" --config "$CONFIG" --env-file "$TOKEN_FILE" \
  work-prepare --input "$EXPORT" --out "$NEW_PREPARED_DIR"
python3 "$SUIJI_SKILL_DIR/scripts/suiji.py" --config "$CONFIG" --env-file "$TOKEN_FILE" \
  work-import --input "$NEW_PREPARED_DIR/prepared.json" --request "$UNIQUE_REQUEST_FILE"
python3 "$SUIJI_SKILL_DIR/scripts/suiji.py" --config "$CONFIG" --env-file "$TOKEN_FILE" \
  work-list --from 2026-10-21 --to 2026-10-23
```

路径只是示例变量，日期按本次授权选择。prepare 只做本地校验、身份/能力核对和完整分页读取，生成精确 payload 与日期/状态/人工保护预览；不写服务。人工归类、清空项目及其他人工字段不被 import 覆盖。

每包最多100条、200KiB，按完整日期分包；单日超限拒绝，不截断。多日超限时prepare仅冻结首包，另生成未绑定revision的remaining.json；本包确认后才能对remaining.json再次prepare。每包依次 prepare → import → 回读确认，才能准备下一包的新 feedRevision。不要并行冻结相同旧 revision 的多个包。

import 在联网前将精确身份、操作键和 payload 写入0600请求文件。成功回执包含 importId、feedRevision、created/updated/unchanged/protected 和每条事实的ID/版本/sourceHash/有效字段。CLI 用详情独立回读，核对源字段及人工保护，确认后才解除冻结。新键导入同一稳定快照不新增事实或修订，遗漏事实不删除已有数据。

`WORK_FEED_CHANGED` 要重新读取并复核；`VERSION_CONFLICT` 要核对最新事实，不能强制覆盖。结果未知时停止后续包，保留原请求；列表中相似正文不是原请求成功证明。只有用户明确要求重试时执行现有 `retry --request`，保持原身份、键和参数，不自动换键重写。

读取覆盖不完整不能写“没有”；只有所声明范围全部 complete 且事实为空，才可说明该范围无记录。不推断其他机器或渠道。事实导入与旧待办状态无关，不标记交接待办完成。
