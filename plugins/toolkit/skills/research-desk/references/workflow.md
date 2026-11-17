# 配置与材料合同

默认资料库为 `~/Documents/ResearchDesk/library`；可在子命令前传 `--library <absolute-path>`。
每个方向位于 `topics/<id>/`，其 `topic.json` 是唯一配置来源。`init --config <file>` 可用完整JSON配置创建新方向；已有配置不被初始化命令覆盖。

## 配置

`init` 生成可直接编辑的完整配置。主要字段：

| 字段                                              | 默认值与含义                                                                                      |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `id`、`name`、`keywords`                          | 方向ID、名称及发现关键词。修改研究范围后旧范围不会作为相同正文的去重依据                          |
| `sources`                                         | arXiv、Letta/LangChain站点地图、Hugging Face和美团RSS；按来源轮询分配候选，不让单一源占满全部名额 |
| `window_days`、`candidate_limit`、`max_documents` | 60、80、5；明确URL来源由用户指定，不强制落在时间窗内                                              |
| `history_days`、`history_limit`                   | 180、30；仅使用已准入研究，实际绑定数量受完整输入预算约束                                         |
| `generation_model`、`review_model`                | `gpt-6.1-sol`、`gpt-6-astra`；必须不同，以CLI请求配置记录，不推测服务端内部模型                   |
| `max_model_turns`                                 | 24，包含修订和结果未知的已预留CLI轮次；不等同服务端请求计数或美元费用                             |
| `model_timeout_seconds`                           | 每轮600秒；超时终止本次子进程组，保留未知结果，不自动重发                                         |
| `max_source_chars`、`max_prompt_chars`            | 单篇完整正文200000字符、每次输入600000字符；不截断原文冒充全文                                    |

来源对象支持四种类型：

```json
[
  { "kind": "arxiv" },
  { "kind": "rss", "url": "https://huggingface.co/blog/feed.xml" },
  { "kind": "sitemap", "url": "https://www.langchain.com/sitemap.xml" },
  { "kind": "url", "url": "https://arxiv.org/abs/2611.17068v1" }
]
```

arXiv按提交时间返回候选，显式论文链接保留版本。RSS按可确认的发表时间和标题/摘要关键词筛选；站点地图仅发现URL，主文元数据确认发表日，不能拿lastmod当发表日。当前只读取所配置的单个站点地图，不递归展开索引。候选按规范URL、可获得的arXiv ID和DOI去重；不宣称穷尽来源。

JSON-LD的发表时间仅采信可解析的日期字符串；数组、对象等元数据忽略后回退到候选已知日期。显式链接可保留日期未知；依赖时间窗筛选的来源仍无法确认日期时，跳过该篇并记录原因，不阻断后续候选。

论文优先官方HTML，失败后提取官方PDF的全部页文字。博客要求存在主文容器；不绕过登录，不借用浏览器Cookie，不使用搜索摘要代替正文。全文提取不包含图像像素，表格/公式抽取仍有误差；模型不得补造未读内容。

## 执行与恢复

- `run` 新建批次并冻结配置、执行器版本、时间窗口、来源、正文和历史材料。方向锁串行执行；不终止别人的执行者。
- `resume [--run <id>]` 继续原批次，沿用配置快照，不重新选择模型或输入。兼容的执行器修复会记录代码摘要；执行合同版本变化时停止。旧调用仅在任务说明、模型及输入内容一致时复用，JSON字段顺序不影响比较，不能用新提示覆盖旧回执。
- `status` 只读列出当前状态、阶段与阻塞原因；不启动模型。
- `report [--run <id>]` 校验准入材料后返回报告路径；不启动浏览器。
- 生成模型和审阅模型均在新线程运行。分析工具权限限制为冻结输入只读、无网络；模型也被指令禁止工具调用，出现工具事件时拒绝其输出准入。
- 在请求前落盘调用预留；最终响应须与完成事件一致。存在未知预留时不重新调用。进程退出、文件出现或模型自述均不单独证明完成。
- 已知完成的步骤可重用。审阅拒绝的结果留在回执，正式报告只引用通过的总结；综合未通过则明确 `no_insight`。
- 第二轮可以读取上一轮通过的总结及其完整原文；历史没有被纳入模型输入就不能声称已参考。

## 材料布局

```text
topics/<topic-id>/
  topic.json
  collection/<content-key>/original.html 或 original.pdf
  collection/<content-key>/original.md
  runs/<run-id>/
    config.json、discovery.json、collection.json
    state.json
    calls/<call-id>/prompt.txt、request.json、events.jsonl、response.json
    summary/*.md
    report.md
    accepted.json
```

正文和已交付报告只增不改。`state.json` 是执行器检查点，`accepted.json` 最后写入，绑定输入、输出与模型回执；散列提供变化检测，不保证原始文献正确。编辑阅读笔记请复制到另一个文件，避免修改受保护的生成结果。

资料库跟随实际执行电脑，不把Mac路径当作远端服务器已存在的资料库；换电脑须显式配置位置。此版本不自动同步GitHub、Obsidian或发布内容，也不创建独立UI。
