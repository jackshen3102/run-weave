# Runweave 个人调查 MCP

供 ChatGPT 结合本机代码、Activity、原生 Agent 会话和日志调查问题。单人 full-access，沿用运行账号及 rw 已有登录；命令和 SQL 可以读写。提供本地 HTTP MCP，通过官方 Tunnel 接入 ChatGPT。首次安装、账号配置和下次启动见 [接入指南](../../docs/deployment/runweave-research-mcp.md)。

## 本地运行

需要 Node.js 22、pnpm，以及目标 Runweave 实例的 rw 登录状态。SQL 便捷入口需要 `python3`，代码身份需要 `git`。命令继承启动进程的 PATH；使用 nvm 等环境时先加载对应 Node/CLI 环境。

在仓库根目录构建并启动，将工作目录替换成实际绝对路径：

```bash
pnpm --filter @runweave/mcp build
pnpm --filter @runweave/mcp start --instance stable --cwd /absolute/path/to/workspace
```

也可以在任意目录使用 Node 运行构建产物：

```bash
node /absolute/path/to/browser-viewer/packages/runweave-mcp/dist/index.cjs \
  --instance stable --cwd /absolute/path/to/workspace --port 5099
```

启动不依赖仓库当前工作目录；分发时仍须保留包的 `node_modules`，其中有 `fs-native-extensions` 原生依赖。它复用 `@runweave/cli/client` 的登录、刷新和实例选择，不复制 token 到新配置。

| 参数                         | 含义                                                     |
| ---------------------------- | -------------------------------------------------------- |
| `--instance`                 | 必填，沿用 rw 实例选择；例如 stable                      |
| `--cwd`                      | 必填，命令默认工作目录的绝对路径                         |
| `--config-dir` / `--profile` | 沿用 rw 的配置目录规则和已登录 profile                   |
| `--port`                     | 默认 5099；只监听 127.0.0.1                              |
| `--data-dir`                 | 可重复，增加文件检索根目录，目录 ID 为 extra1、extra2 等 |

`GET /health` 返回当前 MCP 实例和端点。`POST /mcp` 使用无会话的 Streamable HTTP；工具列表与调用均通过官方 MCP SDK。文件数据属于 MCP 所在机器；profile 指向远程 Backend 时，Backend 与本机文件可能来自不同机器。

浏览器 Origin 请求和非本机 Host 不进入这个完整执行能力端点。无需创建项目/字段权限，使用同机官方 tunnel-client 连接即可。

## 五个工具

| 工具           | 用途                                                                                                            |
| -------------- | --------------------------------------------------------------------------------------------------------------- |
| `list_sources` | Backend 健康、项目、Activity 留存、当前状态、ThreadRef 样本，以及本地日志/原生会话/代码路径；各来源独立返回错误 |
| `search`       | 标准 `{query}` → `{results:[{id,title,url}]}` 关键词检索，并返回一份可 fetch 的覆盖说明                         |
| `fetch`        | 标准 `{id}` → `{id,title,text,url,metadata}`；长内容沿 `metadata.next.id` 继续                                  |
| `query_data`   | Activity 明细/状态分布、原文、文件、SQLite、当前状态和会话引用                                                  |
| `run_command`  | 任意本机 shell，支持 start/read/cancel、分片输出、退出码和工作目录                                              |

原生 Codex、Pi、Claude JSONL 通过文件能力原样读取，包含工具项；不经过 UI 的消息展示投影。其他 Provider、外部数据库及自定义目录可用 `--data-dir` 或 `run_command` 发现。

示例参数：

```json
{
  "query": "source:activity project:PROJECT_ID from:2026-09-28T00:00:00+08:00 timeout"
}
```

```json
{
  "source": "activity",
  "filters": {
    "projectId": "PROJECT_ID",
    "runtimeChannel": "stable",
    "operationId": "OPERATION_ID"
  },
  "limit": 50
}
```

```json
{ "source": "file", "path": "/absolute/path/to/session.jsonl", "offset": 0 }
```

```json
{
  "source": "sqlite",
  "path": "/absolute/path/to/data.sqlite",
  "sql": "select name from sqlite_master where type = 'table'",
  "limit": 50
}
```

```json
{
  "action": "start",
  "command": "git status --short && git rev-parse HEAD",
  "cwd": "/absolute/path/to/repo",
  "waitMs": 1000
}
```

```json
{
  "action": "read",
  "commandId": "RETURNED_ID",
  "stdoutOffset": 16384,
  "stderrOffset": 0,
  "waitMs": 1000
}
```

`query_data.source` 为 `content` 时传 `contentId`；为 `status` 或 `threads` 时读取当前状态或 ThreadRef 样本。SQLite 支持单条 SQL，结果包含列名、行、截断状态和 changes；写语句会提交。SQL 由本机 Python 标准库执行，不隐式发给模型或其他数据库。

### 数据口径与续读

- Activity 时间窗为发生时间 `[from,to)`，默认最近 24 小时。可按项目、环境、会话、事件、操作和 correlation ID 过滤。Backend 新增相同可选过滤，旧安装态由 MCP 再核对新字段，不假定已经更新 Stable。
- `nextCursor` 绑定时间窗、过滤条件和 Activity 水位。后续请求复用原 filters 或返回的 effectiveFilters；中途改变过滤条件会拒绝。每页 `counts` 仅统计本页事件，全部页累加后才是已扫描范围的总量；没有结果状态的事件记为 unknown。
- 默认每次最多扫描 2000 条，可用 maxScan 调整至 20000；达到扫描/执行预算返回 partial 和游标。新查询产生新水位；事件数不等于请求数。
- Activity 搜索最多检查 100 条事实、20 个内容首片段，返回至多 25 个匹配。文件搜索默认最多扫描 100 个文本文件的末尾 64 KiB、5000 个目录项、8 MiB 内容。覆盖说明记录限制；它不是全历史全文索引，复杂检索使用 `run_command` 中的 rg、SQL 或脚本。
- `fetch` 文件片段约 32 KiB，Activity 内容片段最多 16384 个 UTF-16 单位；每片段携带下一引用。读取中修改/轮转文件会返回 source_changed，重新查询获取新版本。原文过期、删除或数据源离线返回明确错误。
- 文件证据包含快照摘要；位于 Git 仓库中时返回 HEAD、该文件 dirty 状态，部署状态保持 unknown。历史版本 bundled 不冒充 Git commit。时间相邻不代表因果关系。

### 命令生命周期

命令使用 `/bin/sh -c`，默认 60 秒、最多保留 64 MiB 输出；调用者可调整 timeoutMs/outputLimit。默认最多同时运行 8 条命令；输出写入本机临时目录，按 stdout/stderr 的 nextOffset 续读。read 的 waitMs 最长 10 秒，长任务用 commandId 继续读取。

cancel/超时会终止本工具创建的进程组，必要时补 SIGKILL；`processClosed` 表示输出管道和子进程已关闭。端点保持至多 128 条命令记录，超出后淘汰最早的已完成记录。停止 MCP 会终止它仍管理的命令并清理临时输出。命令自行脱离进程组的服务需按该服务的生命周期显式管理。

MCP 重启后证据 ID 失效，需重新搜索；最多保留 4096 个引用。引用页是本机 `http://127.0.0.1:PORT/evidence/ID`，供同机浏览器查看。Tunnel 不自动公开这些网页；ChatGPT 模型通过 fetch 读取文本，异机浏览器不能直接打开本机引用。

## 接入 ChatGPT

安装官方客户端、保存本机凭证、管理后台隧道、填写 ChatGPT 创建表单，以及停止/恢复与排障，
统一见 [ChatGPT 接入本机 Runweave MCP](../../docs/deployment/runweave-research-mcp.md)。

本仓库不包含真实 API Key、个人 Tunnel ID 或机器运行配置。平台身份与工作区关联沿用
官方机制，MCP 内部不新增权限平台。工具的写入能力由真实 annotations 描述。

## 验证

```bash
pnpm --filter @runweave/mcp typecheck
pnpm --filter @runweave/mcp lint
pnpm --filter @runweave/mcp build
pnpm testplan:validate docs/testing/architecture/research-mcp.testplan.yaml
```

真实行为合同见 [验收计划](../../docs/testing/architecture/research-mcp.testplan.yaml)。本地协议、文件、SQL 和进程验证不能替代其中的 ChatGPT/Tunnel 用例。没有配置账号时，明确记录那些用例未执行。
