# 飞书采集与合并

仅在本次要求包含飞书消息或文档时读取。需要 Python 3.9+（含时区数据库）与已授权的 `lark-cli`；读取消息用 lark-im，找文档用 lark-drive，读取/写入正文用 lark-doc。先读可用技能或 `lark-cli skills read <skill>` 的相应指引，不自动换成 bot、扩大授权或安装其他连接。

## 候选发现

以下命令从本 Skill 目录执行。`--from` / `--to` 均包含，默认 Asia/Shanghai；脚本转换为每日零点至次日零点的左闭右开窗口，并为 lark-cli 设置相同 TZ。示例日期需按本次要求替换。

```bash
python3 scripts/feishu.py discover --from 2026-10-21 --to 2026-10-23 \
  --timezone Asia/Shanghai --out /private/tmp/feishu-candidates
python3 scripts/feishu.py review --bundle /private/tmp/feishu-candidates \
  --date 2026-10-21 --max-chars 1000
python3 scripts/feishu.py read --bundle /private/tmp/feishu-candidates --message-id <本人消息ID>
```

发现阶段只读取本人发送消息、本人创建或编辑文档的搜索结果，不读取各群消息流或文档正文。脚本验证用户身份，逐页消费 `has_more/page_token`，按 message_id 去重；目录 0700、文件 0600，新输出目录不得已存在。

- `--document-scope edited` 为默认：本人创建或参与编辑的文档。`authored` 将创建和编辑候选都限制为原始创建人是本人，仍保留本人在区间内编辑的旧文档；不是只看期间新建。
- `--channels all` 默认读取消息与文档候选；用户只要求其中之一时用 `messages` 或 `documents`，未请求的渠道不查询，其空数组也不代表该渠道没有事项。只采文档时不能扩展聊天上下文。
- 文档按天查询本人编辑窗口。`my_edit_time` 按小时聚合，结果中的 `update_time` / `edit_user_id` 可能是其他人的最后操作，不能代替本人编辑日期。本人编辑也不能证明整篇文字或所有技术成果由本人完成。
- `manifest.json` 记录日期、身份、每页参数/回执摘要和覆盖状态；`messages.json` 是本人消息全文，`documents.json` 是含活动日期的文档候选。原始页留在受保护目录，不整体送入模型或上传。
- 成功退出 0；创建输出目录前的错误退出 1；开始采集后失败或到达 `--max-pages`（默认每次查询 100 页）退出 2，manifest 标记 incomplete。失败材料不能当成“没有”。修复原因后用新目录重采；不覆盖已有产物。
- 搜索完整分页只证明读完本次可见结果，不保证服务端索引、权限或保留期覆盖全部历史。图片、音视频只保留占位，不进行默认 OCR/下载；撤回消息不纳入事实。

## 先甄别，再补上下文

先看本人消息预览，必要时 `read` 全文。保留实际讨论、行动、产物和结果；跳过纯寒暄、表情、无法理解的纯图片及没有事项内容的协调。预览的 `truncated=true` 不是全文。

只对有实质内容的本人消息补充相关回复：

```bash
python3 scripts/feishu.py context --bundle /private/tmp/feishu-candidates \
  --message-id <本人消息ID> --out /private/tmp/feishu-context-one
```

脚本不接受任意 chat_id/thread_id：种子必须来自完整发现包中的本人消息，当前账号也须一致。有话题读同话题回复；没有话题只读该会话时间窗，默认种子前后各 30 分钟，并裁到采集总范围。上下文的 `messages.json` 包含种子与筛选后回复，原始 API 页另存；不要把整个原始页交给模型。

话题接口不支持服务端时间范围，脚本倒序分页、在本地筛选，读到窗口之前即停止；根消息可能不在话题回复里，因此保留搜索种子。无发言的群不扩展；有发言也不能据此把全群讨论归给本人。非话题回复关联仍需 Agent 判断，时间接近不等于同一事项。

选定窗口完整不等于整个事项已经结束。结果迟到、问题未闭环或上下文不足时，可针对同一种子扩大 `--minutes`（1–1440）或选择另一个本人消息，并使用新输出目录；不要为取得全貌无条件抓整群。不得从未读后续推断成功或失败。

## 文档正文

读取 `documents.json` 的候选元数据，再用 lark-doc：

```bash
lark-cli docs +fetch --as user --doc <候选token> --scope outline --max-depth 3
lark-cli docs +fetch --as user --doc <候选token> \
  --scope section --start-block-id <相关标题ID> --detail with-ids
```

保留返回的实际 document_id、revision_id、抓取时间及已读章节；将 Wiki token、Docx token 和分享 URL 关联到同一文档。先定位再读相关正文，团队周报只取本人事项。需要嵌入表格/附件内部信息时按 lark-doc 路由下钻，不凭标签猜内容。

文档是读取时的当前快照，创建/编辑时间不是每项技术成果的发生时间。历史试验有聊天或原始 Agent 证据时按其发生日记录；只有当前正文时，仅可记录文档活动及其描述，不能臆造历史版本差异。保存快照后，后续采集可比较版本增量。

## 整理、核对与交付

使用主 Skill 的跨渠道合并规则。内部保存 `facts.combined.json`，每条包含 `date`、`project`、`eventKey`、`statement`、`status` 和 `sourceRefs`；引用写明渠道、材料包路径及原生 ID。文档引用另存实际版本和相关章节，跨日事项保留同一 eventKey、只记录当天新增动作。示例：

```json
{
  "date": "2026-10-22",
  "project": "Office 静态资源防劣化",
  "eventKey": "office-resource-monitor-design",
  "statement": "更新资源体积监控方案并在群里讨论；阈值仍待确定。",
  "status": "discussed",
  "sourceRefs": [
    {
      "channel": "feishu-message",
      "bundle": "/private/tmp/feishu-candidates",
      "id": "真实消息ID"
    }
  ]
}
```

这份跨渠道事实索引由 Agent 保存、逐条核对，当前脚本不校验或渲染它；不要把示例 ID 当真实材料。核对每条作者、日期、原文、状态、项目及重复关系；脚本不判断语义。

特别处理：

- 文档 + 群里分享 + 周报复述同一方案，只记一次；周报回顾不重复计为新实现。
- 新建文档与更新旧文档分开；转发旧链接不等于当天写文档。
- 远端 Agent 在飞书报告实现或评审时保留“Agent 报告”；机器人“触发部署成功”不等于部署完成。
- 本机 Agent 工具回执出现浏览器标签、别的项目名或 MR 链接，只证明界面里存在，不能当成在该项目做过工作。
- 未读取工作机器原生记录时说明边界，不宣称完成该来源的全部去重。

保存每日 Markdown 和合并报告，默认“日期 → 项目 → 当天结论”；不显示 sourceRefs、来源编号、采集说明或来源附件。空日完整读取且确无可记录事项才写“没有”；读取不完整则说明无法确认。回读核对日期、项目、条目和正文。没有新增事实时不重复保存同一批成果。

用户要求落地飞书文档时再通过 lark-doc 写入，并回读核对；记录本次生成文档的实际 token 和覆盖日期，以后识别为派生报告。定时触发、其他机器及消息发送沿用用户另行指定的范围，不因使用本 Skill 自动启用。
