# 会话搜索

会话搜索只读取所选 Backend 电脑上的 Agent 原生 JSONL 记录。Codex、Pi、Claude 是格式适配器；Activity、日报、Work History 和经验库不进入正文索引。索引是可重建的 SQLite/FTS5 派生数据，不修改原始记录。

Web / Electron 的「会话搜索」、iOS 首页菜单、CLI 和 MCP 共用 Backend 的同一个索引。跨机器聚合、向量搜索、自动生成经验和自动交接不在此功能范围内。

## CLI

```bash
rw session-search status --json
rw session-search index --json
rw session-search search --query 'spawn codex ENOENT' --cwd /path/to/repo --json
rw session-search search --query '中文关键词' --all-projects --level work --provider codex --json
rw session-search show <搜索结果中的64位recordId> --json
rw session-search search --query '缓存查询' --all-projects --no-update --json
```

- 默认按当前目录的 Git 仓库身份检索，同仓库的 worktree 合并。也可传 `--project-id <已注册项目ID>`；`--all-projects` 必须显式开启。
- `--level chat`（默认）：用户和模型的可见对话。`work` 增加工具请求与原生操作回执；`full` 再加入工具输出。隐藏推理、图片和启动注入上下文不进入对话搜索。
- 默认排除后台任务、子 Agent、审查与未知来源；`--other-origins` 显式包含。识别依据是原生元数据及已知启动标识，未知格式不会伪装成完整覆盖。
- `--from` / `--to` 为带时区的 ISO 时间，区间左闭右开。`--limit 1..50`，默认 20；`--cursor` 跟随返回的下一页游标。索引版本变化后游标返回 409，需重新搜索。
- 查询是关键词的 AND 匹配，不是自然语言问答。至少三个字符的词使用 trigram FTS，短词使用有界查询。每次最多取 2001 个候选片段，按原生会话合并；触及上限明确返回 `partial`，不承诺完整召回。
- `search`、`show` 默认在回答前检查并更新索引；`--no-update` 跳过更新，但空索引仍先建立一次，与 ags 0.5.0 CLI 一致。`status` 只读当前索引状态。
- `index` 手动更新并等待本轮扫描结束后返回状态，不提供 `--wait`。来源 `partial` / `unavailable` 不能当作全量索引成功。
- 使用现有 `--instance`、认证与输出规则。首次重建可能耗时，状态显示当前 Backend 节点和每种格式的覆盖情况。

## 更新与定位

更新触发策略严格对齐 ags 0.5.0：按需查询或手动 `index` 时更新；没有文件监听、定时扫描或 Backend 启动预扫描。打开页面及状态查询只读取已有索引元数据。新文件完整建立索引；追加文件先校验旧前缀哈希，再解析新增完整行；重写、截断或替换会重建。追加路径仍会读取旧前缀，不声称只读新增字节。未完成的末行暂缓，损坏行和不支持的格式明确报告覆盖缺口。已删除文件从索引移除，不可读来源暂停返回结果。

默认目录遵循 Agent 自身配置：`CODEX_HOME/{sessions,archived_sessions}`、`PI_CODING_AGENT_DIR/sessions`、`CLAUDE_CONFIG_DIR/projects`；未配置时使用各 Agent 的默认用户目录。索引位于 Backend browser profile 的 `session-search/index.sqlite`，通过独立 Worker 读写。单文件上限 512 MiB，单行 16 MiB，单条文本 2 MiB；超限来源或记录会在覆盖状态中报告。

每条命中携带原文件、行号、UTF-8 字节范围和 SHA-256。展开上下文或 MCP fetch 时重新读取并核对原文；变化或缺失时不返回旧正文。工具配对仅依据原生调用 ID；代码模式包装调用与内部动作不猜测关联。上下文最多 12 条、同调用最多 8 条、唯一正文合计 64,000 字符；截断标记 `partial`。搜索片段与正文使用现有证据脱敏规则。

Pi 与 Claude 根据原生父节点链选择当前分支。Codex `history_mutation` 暂无经过验证的规范重放适配：整个文件明确标记不支持并排除，避免返回被撤销的内容。Claude 压缩边界报告局部覆盖。搜索命中和模型自述不能代替执行成功证据，确认操作需阅读原生请求、结果与文件变更回执。

## MCP / HTTP

MCP 的 `search_sessions` 接收 `query`、`projectId` 或显式 `allProjects`、`provider`、`level`、`includeOtherOrigins`、`from`、`to`、`limit`、`cursor`；默认当前配置的工作区仓库。返回可 fetch 的证据引用和独立的覆盖回执。`session_search_status` 查看同一 Backend 索引；标准 `search` 也支持 `source:sessions`。MCP 不建立第二套索引。每个 MCP 进程只在首次会话工具调用时尝试更新一次，后续搜索和 fetch 读取已有索引；首次更新失败也不自动重试，与 ags 0.5.0 保持一致。MCP 后续调用本身不追新；其他查询或手动 `index` 更新同一索引后，MCP 可读到新记录。重启 MCP 会重新触发一次更新。

认证 HTTP 入口：`GET /api/session-search/status`、`POST /api/session-search/refresh`（空对象，等待完成后返回状态）、`GET /api/session-search/search`、`GET /api/session-search/records/:id`。`search` 与 `records` 默认更新后读取，`noUpdate=true` 读取已有索引。查询必须指定 `projectId`、`cwd` 中的一项，或显式 `allProjects=true`。合同见 [共享 DTO](../../packages/shared/src/session-search.ts)，服务入口见 [SessionSearchService](../../backend/src/session-search/service.ts)。
