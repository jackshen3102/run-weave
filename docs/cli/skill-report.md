# Codex Skill 使用报告

入口：[本地报告命令](../../scripts/skill-report/cli.mjs)。只读本机 Codex 历史日志，
显式和隐式合并统计；不执行历史命令，不调用模型或 Backend，不修改 Skill 或会话。
需要项目已安装的 Node.js 依赖；项目筛选还需要 Git。

```bash
pnpm skill:report
pnpm skill:report --days 30
pnpm skill:report --cwd /path/to/project --days 7
pnpm skill:report --all-projects --days 7
pnpm --silent skill:report --days 7 --json > /tmp/skill-report.json
pnpm skill:report --since 2026-10-01
pnpm skill:report --sessions-dir /path/to/logs --all-projects
```

默认最近 7 天，支持 30 天或 `--since`；日期 `YYYY-MM-DD` 按 UTC 解释。
统计结束时间固定为命令开始时刻，文件读取固定为扫描时的大小。
`--days` 和 `--since`、`--cwd` 和 `--all-projects` 分别互斥；参数无效以非零退出。

默认范围为当前 Git 项目、已登记 worktree 及其子目录；已删除且位于项目目录外的
worktree 无法自动关联。`--all-projects` 不要求当前目录属于 Git 仓库。
默认来源为 `$CODEX_HOME/sessions`、`$CODEX_HOME/archived_sessions`；未设置
`CODEX_HOME` 时使用实际 HOME 下的 `.codex`。`--sessions-dir` 替换默认来源。

## 统计口径

| 字段             | 含义                                                               |
| ---------------- | ------------------------------------------------------------------ |
| `confirmedTurns` | 同一会话、轮次、Skill 有确认加载证据，计一次                       |
| `candidateTurns` | 同轮只有候选关联；已有确认加载的轮次不再计为候选                   |
| `sessionCount`   | 有确认加载或候选关联的不同会话数                                   |
| `readCount`      | 确认完整读取的不同工具调用、路径组合数；同一调用内同一路径只计一次 |
| `lastLoadedAt`   | 最近确认加载的事件时间；没有确认加载则为 `null`                    |
| `lastRelatedAt`  | 最近确认加载或候选关联的事件时间                                   |

确认加载接受两种证据：

- 独立用户消息中的 `<skill>` 注入，包含名称、路径及匹配的 Skill 正文。
- 静态可识别的完整 `cat SKILL.md` 读取，关联工具结果明确退出码为 0、输出未截断，
  并出现匹配的 Markdown front matter 与非空正文。

支持直接 shell 工具的 JSON `cmd` / `command`，以及 `functions.exec` 中
`tools.exec_command({cmd: "字面命令"})`。嵌套 JavaScript 只解析语法，不求值。
部分读取、失败读取、缺少结果、输出截断、无法验证的读取工具和复杂 shell 命令，
仅提供候选关联。纯路径搜索、编辑工具及重定向写入不作为使用证据。
启动时的可用 Skill 清单、用户只提到 Skill 名称，不计入加载。

插件版本缓存路径与仓库安装路径合并到 `插件名:Skill 名称`；非插件 Skill 使用名称。
可明确关联单个正文的读取及注入使用正文声明的名称，归一目录别名。
同一目录出现不同声明名称时不强行合并。跨插件的同名 Skill 分开统计。

会话与归档的同 ID 副本只纳入一次；分叉或子 Agent 创建前的继承记录忽略。
相同轮次、调用 ID、路径、时间戳的复制证据跨会话去重，并优先归属较早创建的会话。
子 Agent 自身新轮次独立统计。默认排除仍在进行、审批评估及范围外会话。
没有 Token 记录不妨碍 Skill 统计。

## 证据与覆盖

Markdown 提供排行榜、证据路径和行号、扫描及排除数。
JSON `schemaVersion: 1` 提供 `skills`、`sessions`、`scan`，每条 Skill 的 `evidence`
含会话 ID、轮次 ID、时间、输入行和结果行。正文、原始命令和凭据不复制到报告。
报告中的路径与身份仍属于本机资料。

`scan.skipped` 报告目录或文件读取失败；会话 `coverage` 报告无法解析的记录、
忽略的继承记录与无法关联轮次的注入。零结果不等于零使用。

确认加载表示有正文加载证据，**不表示采用了工作流或执行成功**。仅靠确定性日志无法
区分执行前阅读和维护时审阅正文。沿用先前上下文、动态拼接路径、只加载部分正文、
读取结果由后续异步等待返回及未留存日志，都可能漏计确认加载。
同名的非插件自定义 Skill 可能被合并，具体来源可查看 `paths` 和 `evidence`。
这些限制不通过模型推测补齐，不输出成功率或价值评分。

日志目录、项目范围和轮次识别复用 [Token 报告](./token-report.md) 的读取能力；
统计与输出独立维护，Token 报告原有口径不变。
