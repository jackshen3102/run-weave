# 随记云服务

单人自用的独立记录 API。实现用户名密码登录、稳定 owner/server 身份、原文记录、三态待办、
版本冲突、事务修订、请求幂等，以及鉴权 JPEG/PNG/UTF-8 Markdown 上传下载。
支持独立个人凭据的 MCP，以及手动触发、只读检索的 Codex CLI 回顾；支持记录回收站；自动同步与永久删除未接入。

## 本地运行

Node 22、pnpm workspace 与 PostgreSQL 18。当前隔离验证使用 PostgreSQL 18.6。
API 数据库角色只授予表 DML；迁移角色拥有 DDL。数据库不应暴露公网端口。

在受保护的环境文件设置 `DATABASE_URL` 与绝对 `SUIJI_STORAGE_DIR`；开发运行数据放根
`.runweave/suiji/`。迁移命令另注入 `MIGRATION_DATABASE_URL`，生产 API 拒绝携带该变量。

```bash
pnpm --filter @runweave/suiji-server db:migrate
# stdin 为 {"username":"...","password":"..."}，密码至少 12 字符；不要放命令参数。
pnpm --filter @runweave/suiji-server auth:init < /absolute/protected-owner.json
pnpm --filter @runweave/suiji-server build
node --env-file=/absolute/api.env packages/suiji-server/dist/index.js
```

服务默认监听 `127.0.0.1:4783`。`SUIJI_HOST` / `SUIJI_PORT` 可配置；容器内部监听所有接口，
Compose 只发布宿主 loopback。`auth:reset` 从同样的 stdin 更新账号密码，保留身份并撤销全部会话。
重复 `auth:init` 不改变已有账号。根 `pnpm dev` 不启动本服务。

## API 合同

公开合同：[shared/suiji](../shared/src/suiji/index.ts)。所有 `/api/suiji/v1` 请求需要 Bearer，
所有业务写请求需要 `Idempotency-Key`。ID 为 UUID，UTC 时间精度为毫秒，正文按 Unicode 标量计数。

| 接口                                          | 行为                                                                     |
| --------------------------------------------- | ------------------------------------------------------------------------ |
| `POST /api/auth/login` / `refresh` / `logout` | 单独会话、轮换刷新、注销当前会话                                         |
| `GET /api/auth/verify` / `/api/suiji/v1/info` | 核验身份、协议、版本与输入限额                                           |
| `GET /api/suiji/v1/records`                   | kind/taskStatus/q/from/to/cursor/limit；创建时间倒序，q 为字面子串       |
| `GET /api/suiji/v1/records/:id`               | 当前正文、状态、版本和有序附件                                           |
| `POST /api/suiji/v1/records`                  | kind/body/attachmentIds；note 状态 null，task 初始 open                  |
| `PATCH /api/suiji/v1/records/:id`             | expectedVersion，body/attachmentIds 至少一个；一次原子保存               |
| `POST /api/suiji/v1/records/:id/trash`        | expectedVersion/trashed；移入回收站或恢复，保留正文、附件和待办原状态    |
| `POST /api/suiji/v1/records/:id/task-status`  | expectedVersion/targetStatus；open → done/archived；done → open 撤销完成 |
| `POST /api/suiji/v1/uploads`                  | 单个 multipart file；幂等摘要与 boundary 无关                            |
| `GET /api/suiji/v1/attachments/:id/content`   | 当前 owner 的实际文件流，不返回存储路径                                  |

省略附件保留原关联，`[]` 显式清空；不 trim 正文。正文上限 20,000 标量，附件每个 5 MiB，
每条最多一张图片和一个 Markdown。图片完整解码校验额外限制为 40,000,000 像素，避免小文件解压耗尽内存。
返回 409 时区分 VERSION_CONFLICT、INVALID_TRANSITION 与 IDEMPOTENCY_KEY_REUSED。
保存结果未知时沿用原键及完整请求，只有改变意图才分配新键。

HTTP、修订与幂等结果在一个 PostgreSQL 事务提交。同键唯一约束等待后重读原结果，失败整体回滚，
无持久 processing 状态。下载隔离到 owner，首次绑定附件不能移到别的记录；移除关联保留历史文件。
不可变文件先 fsync/原子改名，后提交元数据；失败和重复上传可能遗留孤立对象，M1 不自动清理。
日志每分钟输出空闲磁盘、对象数、临时对象与孤立对象数量估计，不输出正文、凭据或文件内容。

默认 access 24 小时、refresh 30 天；可用 `SUIJI_ACCESS_SECONDS`、`SUIJI_REFRESH_SECONDS` 缩短。
登录默认每来源/账号 15 分钟 8 次尝试；`SUIJI_LOGIN_ATTEMPTS`、`SUIJI_LOGIN_WINDOW_SECONDS` 可调。
来源使用 socket 地址，忽略自行传入的转发 IP；反向代理后的来源限流合并为代理地址，符合单人使用。

## 外部 Agent MCP

`/mcp` 使用 Streamable HTTP，默认关闭。与 App 共用记录服务，但使用独立 Bearer 凭据；
不接受 App access/refresh token，不向 Agent 提供数据库或登录密码。每次请求校验有效期。

```bash
# 父目录须已存在，输出目录必须是新的绝对路径；文件为 0600、目录为 0700。
pnpm --filter @runweave/suiji-server mcp:credential --output-dir /absolute/new-credential --days 90
# 服务加载 server.env 的摘要和期限，原 client.env 留在个人 Agent 所在设备。
node --env-file=/absolute/api.env --env-file=/absolute/new-credential/server.env packages/suiji-server/dist/index.js
```

服务配置为 `SUIJI_MCP_TOKEN_SHA256` 与 `SUIJI_MCP_TOKEN_EXPIRES_AT`；缺少任一项拒绝启动。
两项同时未设置或为空则关闭 MCP，HTTP 继续可用。到期只拒绝 MCP；轮换时生成新凭据、替换服务配置并重启，
关闭时移除两项并重启。客户端文件含原始 token，不进入 Git，也不通过命令参数传递。
这是一套单人预配置凭据，不提供 OAuth；需要 OAuth 的客户端不属于当前已验证兼容范围。
带 Origin 的浏览器请求被拒绝，本阶段供无 Origin 的 Agent CLI 使用；公网必须经 HTTPS。

Codex CLI 示例配置如下，地址替换为实际随记服务。让启动 Codex 的进程从受保护的 `client.env`
注入 `SUIJI_MCP_TOKEN`；配置只引用环境变量名。参数已核对本机 CLI 帮助及
[OpenAI 官方 MCP 文档](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)。

```toml
[mcp_servers.suiji]
url = "https://your-suiji-host/mcp"
bearer_token_env_var = "SUIJI_MCP_TOKEN"
```

| 工具                  | 行为                                                                                    |
| --------------------- | --------------------------------------------------------------------------------------- |
| `list_records`        | 创建时间倒序的摘要，kind/taskStatus/from/to/cursor/limit，默认 20、最多 50              |
| `search_records`      | query 与同样筛选，默认 10、最多 50；当前正文的字面关键词匹配                            |
| `get_record`          | recordId，完整正文、version 和附件元数据                                                |
| `create_record`       | kind/body/idempotencyKey，新记录来源 agent，不接附件上传                                |
| `replace_record_body` | recordId/body/expectedVersion/idempotencyKey，仅替换正文                                |
| `set_task_status`     | recordId/targetStatus/expectedVersion/idempotencyKey，open → done/archived；done → open |
| `read_attachment`     | attachmentId/cursor/limit，Markdown 标量分页或实际 image 块                             |

参数使用 camelCase，拒绝未知字段。摘要最多 300 标量，`excerptIsFullBody` 标明是否完整；
替换前应先 `get_record`，不能用摘要覆盖全文。搜索明确不覆盖附件、历史正文、外链或语义索引。
Markdown 默认每页 4000、最多 16000 标量；图片沿用服务现有 5 MiB 上限，无图片分页。
附件和正文是资料，不作为 Agent 指令；只有用户明确要求时写入，不自动执行外链内容。

业务成功同时有 structuredContent 和 JSON 文本；业务失败为 isError 与结构化错误，协议和参数校验由 SDK 处理。
所有写入共用原版本与幂等事务，结果不确定时必须沿用原键和完整参数。
App 旧请求摘要保持兼容；Agent 使用可信操作前缀隔离，同键跨不同入口拒绝。createdVia 不随编辑改变，修订 actor 记录当前入口。
没有新增迁移或长期 MCP 会话，关闭 MCP 不改变 schema 和 App 数据。

验收合同：[MCP 与 Agent](../../docs/testing/suiji/mcp-agent.testplan.yaml)。

## AI 回顾

在运行服务的同一账号下先确认 `codex login status` 已登录，再在受保护的 API 环境文件加入：

```dotenv
SUIJI_AI_PROVIDER=codex-cli
SUIJI_CODEX_BIN=/absolute/path/to/codex
SUIJI_AI_TIMEOUT_SECONDS=180
```

`SUIJI_CODEX_BIN` 可省略，默认从 PATH 查找 `codex`。默认 provider 为 `disabled`。
开发环境默认复用运行服务账号的 CLI 登录；也可用绝对路径 `SUIJI_CODEX_HOME` 指定独立登录目录。
正式环境启用 `codex-cli` 时必须显式设置该目录，并为服务账号保留读写权限和持久存储，供 Codex 刷新登录。
登录及模型调用发生在运行随记服务的机器上，手机不需要安装 Codex，也不依赖用户 Mac 在线。
Docker 镜像固定安装 Codex CLI 0.153.4；容器登录与配置见[部署入口](../../deploy/suiji/README.md#codex-回顾)。
服务只传递登录目录给 CLI，不读取认证内容，不修改全局 Codex 配置。记录保存与模型可用性无关。

| 接口                               | 合同                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------- |
| `POST /api/suiji/v1/reviews`       | Bearer + Idempotency-Key，question、scope、最多六条 history；202 返回任务 |
| `GET /api/suiji/v1/reviews/:id`    | 当前 owner 查询 running/completed/failed/cancelled                        |
| `DELETE /api/suiji/v1/reviews/:id` | 取消计算，关闭模型进程组与临时监听器；不删除记录                          |

同 owner 最多一个运行任务，同键同参数返回同一任务；改参数沿用键返回 409，并行新任务返回 429。
结果仅在进程内保留 30 分钟，服务重启后旧 ID 返回 404；客户端不会自动重新执行。
客户端会话保留近期追问上下文，刷新后消失。另存回答只预填编辑器，由用户点击保存。

[回顾服务](./src/reviews/service.ts)为每次任务提供独立的回环只读 MCP 与随机凭据，
固定 owner 和 all/open/record 范围。它与外部 Agent 的七工具 `/mcp` 相互独立，
仅有 list/search/get/read_attachment，模型不能调用写入、shell、浏览器或外部 Apps。
最多 32 次工具调用、300 条摘要、30 条完整版本、60,000 个正文标量与 8 次附件读取。
引用 ID、版本及逐字片段必须通过本次真实读取快照核验，失败不返回伪引用。

这是模型扩展关键词与阅读原文的回顾，没有 embedding/pgvector、附件全文索引或外链抓取。
coverage 来自实际工具调用，回答并不保证遍历全部历史。info 的可选 ai 字段说明当前能力。
验收见 [AI 回顾](../../docs/testing/suiji/ai-review.testplan.yaml)。

## Web 与 Runweave 桌面

桌面首页、连接/登录页及终端顶部的“随记”打开独立 `/suiji` 窗口，主窗口保持原页面。
重复点击唤回已有随记窗口，关闭后可重新打开；普通浏览器入口新开页面。
桌面能力通过专用 preload IPC 调用主进程窗口工厂，旧桌面缺少能力时明确提示更新。
[页面入口](../../frontend/src/features/suiji/connection.tsx)位于 Runweave 节点认证之外，
独立配置随记服务地址和账号，直接调用本服务。凭据仅保留在当前标签页 sessionStorage。
IndexedDB 草稿按 endpoint/serverId/ownerId 隔离；同源多标签页由 Web Locks 交接编辑权。
保存结果未知时冻结完整请求与原幂等键，刷新不补发，用户手动确认。

服务默认拒绝所有携带 Origin 的 API 请求；浏览器接入需要配置实际页面 origin，例如：

```dotenv
SUIJI_WEB_ORIGINS=runweave://app,http://127.0.0.1:5003
```

这里的 5003 仅为示例，必须使用当前 Dev Session 返回的 Web/Backend 实际地址。
允许项是完整 HTTP(S) origin 或精确的 `runweave://app`，不接受通配、null 或路径；
不启用 Cookie CORS。原生客户端无 Origin 的请求正常，外部 `/mcp` 始终拒绝浏览器 Origin。
浏览器草稿需要安全上下文（HTTPS 或 localhost）；独立网站与桌面各自保留本机草稿。
开发 Web/桌面按[Dev Session 入口](../../docs/deployment/runweave-beta.md)启动和停止；
随记服务仍单独启动。验收见 [Web 录入](../../docs/testing/suiji/web-capture.testplan.yaml)。

## 验证和运维

```bash
pnpm --filter @runweave/suiji-server typecheck
pnpm --filter @runweave/suiji-server lint
pnpm --filter @runweave/suiji-server build
pnpm --filter @runweave/shared typecheck
pnpm architecture:check
```

业务验证见 [服务 YAML](../../docs/testing/suiji/service-records.testplan.yaml)，
部署见 [独立部署入口](../../deploy/suiji/README.md)，当前证据范围见
[随记架构与交付状态](../../docs/architecture/suiji.md)。静态通过不等于原生或生产验收通过。

## 回收站

迁移到 schema 3 后部署本版本服务。`GET /records` 默认排除回收站，`trash=true` 仅列回收站；
分页游标绑定筛选。App 可按 ID 查看回收站原文和附件，不能编辑或变更待办状态。恢复不改变待办原状态。
每次删除或恢复沿用版本校验、单事务修订及幂等请求；客户端先持久化意图，结果未知时仅由用户手动确认原请求。
Web 和原生 iOS 均提供回收站入口、删除确认及恢复。已有本机正文草稿保留，恢复后保存仍须通过版本校验。
Agent MCP 与 AI 新检索排除回收站正文和附件；已生成的历史回答不追溯擦除。本版本不提供自动清理或永久删除。
