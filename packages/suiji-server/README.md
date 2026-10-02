# 随记云服务

单人自用的独立记录 API。实现用户名密码登录、稳定 owner/server 身份、原文记录、三态待办、
版本冲突、事务修订、请求幂等，以及鉴权 JPEG/PNG/UTF-8 Markdown 上传下载。
支持独立个人凭据的 MCP，以及手动触发、只读检索的 Codex CLI 回顾；支持记录回收站；提供只读增量变化接口，自动推进与永久删除未接入。

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

| 接口                                          | 行为                                                                                 |
| --------------------------------------------- | ------------------------------------------------------------------------------------ |
| `POST /api/auth/login` / `refresh` / `logout` | 单独会话、轮换刷新、注销当前会话                                                     |
| `GET /api/auth/verify` / `/api/suiji/v1/info` | 核验身份、协议、版本与输入限额                                                       |
| `GET /api/suiji/v1/records`                   | kind/taskStatus/q/tag/from/to/cursor/limit；创建时间倒序，q 为字面子串，tag 精确匹配 |
| `GET /api/suiji/v1/tags`                      | 当前 owner 有效记录的去重标签，按最近使用记录更新时间倒序，返回 items                |
| `GET /api/suiji/v1/records/:id`               | 当前正文、状态、版本和有序附件                                                       |
| `POST /api/suiji/v1/records`                  | kind/body/attachmentIds/tags；note 状态 null，task 初始 open                         |
| `PATCH /api/suiji/v1/records/:id`             | expectedVersion，kind/body/attachmentIds/tags 至少一个；一次原子保存                 |
| `POST /api/suiji/v1/records/:id/trash`        | expectedVersion/trashed；移入回收站或恢复，保留正文、附件和待办原状态                |
| `POST /api/suiji/v1/records/:id/task-status`  | expectedVersion/targetStatus；open → done/archived；done → open 撤销完成             |
| `POST /api/suiji/v1/uploads`                  | 单个 multipart file；幂等摘要与 boundary 无关                                        |
| `GET /api/suiji/v1/attachments/:id/content`   | 当前 owner 的实际文件流，不返回存储路径                                              |

编辑可切换想法与待办，保留记录 ID、创建时间和附件。想法转待办时状态设为 open，待办转想法时清空状态；类型不变时保留原待办状态。省略 kind 保留原类型。

标签最初引入于 schema 4；当前运行版本要求 schema 9，先迁移并更新服务，再更新客户端。每条允许 0–2 个标签，标签名称去首尾空白后为 1–20 个 Unicode 标量，不能重复或包含控制字符；大小写敏感。创建省略 tags 默认为空，编辑省略保留原值，`[]` 清空。标签属于记录，随草稿、修订和回收站恢复保留；目录只汇总未删除记录，标签总数不限制。目录不受记录分页影响，筛选和其他条件取交集。旧服务严格校验 schema，不能直接回退二进制或删除标签列。验收见[标签测试计划](../../docs/testing/suiji/tags.testplan.yaml)。

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

每台设备独立生成 token，只把摘要登记到服务端。当前运行时要求 schema 9；
`SUIJI_MCP_ENABLED=true` 开启 MCP，默认 false。注册、撤销不重启服务；App 会话不受影响。

```bash
# 真实 serverId/ownerId 来自已验证的服务身份；父目录存在，输出目录必须是新绝对路径。
pnpm --filter @runweave/suiji-server mcp:credential --name Mac --server-id <UUID> --owner-id <UUID> --output-dir /absolute/new-device
# 在服务器上执行，沿用真实 deployment env、project 和全部 Compose 文件（含 override）。
docker compose --env-file /absolute/deployment.env --project-name <project> -f deploy/suiji/compose.yaml run --rm -T admin mcp-credentials register < /absolute/registration.json
docker compose --env-file /absolute/deployment.env --project-name <project> -f deploy/suiji/compose.yaml run --rm -T admin mcp-credentials list
docker compose --env-file /absolute/deployment.env --project-name <project> -f deploy/suiji/compose.yaml run --rm -T admin mcp-credentials revoke --id <UUID>
```

本地目录权限 0700，`client.env` 和 `registration.json` 为 0600。前者含原文，始终留在设备上；
后者含版本 1、稳定 ID、名称、serverId、ownerId、tokenSha256 和 expiresAt，可经安全渠道送服务器。
默认期限 90 天，`--days` 允许 1–365。原文不打印、不进 Git、不进命令参数。
`--legacy` 仅为维护旧版服务生成旧格式文件，不能与名称/身份参数混用，不用于多凭据登记。

管理命令的 JSON 输入走 stdin；服务身份不匹配返回 IDENTITY_MISMATCH；非法输入返回 INVALID_INPUT。
同 ID 同内容重复登记不重复创建；同 ID 或同摘要被其他内容占用返回 CREDENTIAL_CONFLICT。
已撤销或过期的 ID 不可复活，重复登记返回 CREDENTIAL_INACTIVE；重复撤销成功且时间不变，未知 ID 返回 NOT_FOUND。
列表仅包含元数据，状态优先 revoked、expired、active，不返回摘要或原文。
最近使用时间精度为一分钟，表示成功认证而非业务成功。

鉴权逐请求查数据库：失效/错误 token 为 401，数据库故障为 503；不缓存有效凭据。
撤销提交后开始鉴权的请求被拒绝，已通过鉴权的在途请求可完成；上传入口遵循同一规则。
多把 token 共用 owner 的现有 MCP 权限，不改变业务幂等空间或 actor；不支持 scopes 或 OAuth。
浏览器 Origin 仍被拒绝，公网仍要求 HTTPS。

旧版迁移见[部署说明](../../deploy/suiji/README.md#多凭据迁移)。只导入摘要和原期限即可保留旧 token，
无需复制 Mac 上的原文。服务启动不自动导入，也不会因重启恢复已撤销凭据。

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
不创建长期 MCP 会话；凭据表由 schema 6 迁移创建，关闭 MCP 不改变 schema 和 App 数据。

验收合同：[MCP 与 Agent](../../docs/testing/suiji/mcp-agent.testplan.yaml)、[多设备凭据](../../docs/testing/suiji/mcp-credentials.testplan.yaml)。

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
固定 owner 和 all/open/record 范围。它与外部 Agent 的十工具 `/mcp` 相互独立，
仅有 list/search/get/read_attachment，模型不能调用写入、shell、浏览器或外部 Apps。
最多 32 次工具调用、300 条摘要、30 条完整版本、60,000 个正文标量与 8 次附件读取。
引用 ID、版本及逐字片段必须通过本次真实读取快照核验，失败不返回伪引用。

这是模型扩展关键词与阅读原文的回顾，没有 embedding/pgvector、附件全文索引或外链抓取。
coverage 来自实际工具调用，回答并不保证遍历全部历史。info 的可选 ai 字段说明当前能力。
验收见 [AI 回顾](../../docs/testing/suiji/ai-review.testplan.yaml)。

## 手动文字纠错与词库

`info.features.correction` 仅在 `SUIJI_AI_PROVIDER=codex-cli` 时为 true；未提供该字段的旧服务由客户端隐藏入口。纠错沿用上文的 CLI 登录和超时配置。点击编辑器的“纠正文字”后才发送本次正文及当前 owner 的词库快照。历史辅助默认关闭；开启后服务端最多添加三条相关人工修改的局部示例，仍只调用一次模型。纠错 CLI 不接随记 MCP，也不读取附件、文件或网页；结果只作为候选，服务不执行记录或词库写入。

| 接口                                   | 合同                                                                                      |
| -------------------------------------- | ----------------------------------------------------------------------------------------- |
| `GET /api/suiji/v1/correction-lexicon` | 当前 owner 的 `{version,entries}`；空库为版本 0                                           |
| `PUT /api/suiji/v1/correction-lexicon` | Bearer + Idempotency-Key，`{expectedVersion,entries}` 整份替换；冲突返回 VERSION_CONFLICT |
| `POST /api/suiji/v1/corrections`       | Bearer + Idempotency-Key，`{text,recordId?,feedbackCapable?}`，202 返回任务               |
| `GET /api/suiji/v1/corrections/:id`    | 当前 owner 查询状态、候选全文、不确定词与可点选的纠正词                                   |
| `DELETE /api/suiji/v1/corrections/:id` | 取消当前 owner 的任务与模型进程                                                           |

历史辅助接口：`GET/PUT /api/suiji/v1/correction-preferences` 读取或按版本更新开关；`POST /api/suiji/v1/corrections/:id/feedback` 在保存后用记录 ID、版本和原保存键核验反馈；`GET/DELETE /api/suiji/v1/correction-history` 分页查看或清空本账号历史，`DELETE /api/suiji/v1/correction-history/:id` 删除单条。写入均要求幂等键。

schema 8 的历史辅助仅对声明可反馈的记录正文生效。完成快照先保存输入与候选；只有应用候选、成功保存且服务端能找到对应 `record_revisions` 修订时，才关联最终正文。未应用、取消、无新修订不产生人工修改示例。关闭开关停止后续检索和采集；清空使旧快照失效，单条删除和清空只清理纠错派生文本。待反馈快照保留 24 小时，已关联历史保留 90 天。普通随记正文参考仍待对照评测，当前不送入模型。

schema 7 的 `correction_lexicons` 按 owner 存储。最多 200 个标准写法；每个可有 0–5 个误识别写法。每个写法去首尾空白后为 1–80 个 Unicode 标量，不能包含控制字符，也不能在整个词库重复。词库写入与记录保存分别提交。只有用户点击候选中的词或选中正文短词，编辑并确认“加入词库”后才写入；应用候选、手动修改正文及保存记录都不自动学习。词库写入结果未知时客户端保留同一请求键，等待用户手动确认。

同 owner 最多一个运行中的纠错任务，进程内最多保留 100 个任务，完成后保留 30 分钟。CLI 失败、超时与取消不会改变原记录。原文、词库及模型原始诊断不写日志。验收见[手动纠错](../../docs/testing/suiji/manual-correction.testplan.yaml)和[显式收词](../../docs/testing/suiji/manual-correction-learning.testplan.yaml)。

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

迁移到当前要求的 schema 9 后部署本版本服务。`GET /records` 默认排除回收站，`trash=true` 仅列回收站；
分页游标绑定筛选。App 可按 ID 查看回收站原文和附件，不能编辑或变更待办状态。恢复不改变待办原状态。
每次删除或恢复沿用版本校验、单事务修订及幂等请求；客户端先持久化意图，结果未知时仅由用户手动确认原请求。
Web 和原生 iOS 均提供回收站入口、删除确认及恢复。已有本机正文草稿保留，恢复后保存仍须通过版本校验。
Agent MCP 与 AI 新检索排除回收站正文和附件；已生成的历史回答不追溯擦除。本版本不提供自动清理或永久删除。

## 跟进与最终成果

schema 5 增加独立、只追加的跟进及附件关系；部署前执行追加迁移。跟进不改原文、父记录版本、修订或待办状态。记录响应新增可选 followupSummary，info.features.followups 标明能力；旧客户端兼容，新客户端对旧服务隐藏新入口。

App 使用 GET/POST `/api/suiji/v1/records/:id/followups`，POST 带 Idempotency-Key；分页默认 20、最多 50，sequence 倒序，游标绑定记录。跟进最多 20000 Unicode 标量，支持一张 JPEG/PNG 和一个 UTF-8 Markdown，各 5 MiB。附件绑定父记录但关系独立，原文编辑不会删除成果附件。App 可只读回收站跟进，Agent 不可新读取，任何入口不可新追加；恢复保留数据。

外部 MCP 共 11 工具（另含下文 list_changes）：原七工具加 get_service_info、list_followups、append_followup。列表与搜索增加精确 tag。新 POST `/mcp/uploads` 使用同一 MCP 个人凭据上传单个 multipart file，actor 固定 agent；原 App token 不可互用。agentName/sessionId 是可选自报显示信息，不代表独立身份。认证/关闭/过期/Origin 拒绝同时作用于上传。

相同写意图沿用原幂等键与完整参数，结果未知时手动确认，不自动重放。不同 Agent 的不同追加都保留；成果与任务状态独立，用户在 App 完成或明确指示 Agent 完成即可。Skill 只写最终成功成果，不写过程、失败、中断，不触发后续执行。

入口见 [随记 Skill](../../plugins/toolkit/skills/suiji/SKILL.md)；验收分别见 [服务](../../docs/testing/suiji/followups-service.testplan.yaml)、[客户端](../../docs/testing/suiji/followups-clients.testplan.yaml)、[Agent](../../docs/testing/suiji/followups-agent.testplan.yaml)。这些是验收合同，实际通过范围须读取本次证据，不能由文档推断上线状态。


## 增量变化读取与 Lumi

schema 9 新增 `list_changes({cursor?, limit?})`，`get_service_info.features.changes=true`
表示可用。`limit` 默认 20、范围 1–50，不接受时间、类型、状态或来源过滤，避免过滤后漏掉删除与
状态变化。原 `list_records` 的创建时间分页合同保留，不能用它或父记录 `updatedAt` 替代变化读取。

响应为 `{items, nextCursor, hasMore}`。每项只包含 `sequence`（十进制字符串）、`recordId`、
`kind`（`snapshot` / `record_changed` / `followup_added`）、`actor`（`app` / `agent`）、
`recordVersion`、可空 `followupId/followupSequence`、事件发生时的 `deleted` 和读取时的
`currentlyDeleted`；没有正文、附件内容、token 或业务幂等键。删除事件仍可读，但现有记录、跟进
和附件读取继续排除回收站。`actor` 由入口决定，不代表某一个 Agent 的身份。

首次省略游标，从头读取。迁移以每条现有记录（含回收站）一条 `snapshot` 建立完整库存，
其中已有跟进需调用 `list_followups` 读完；迁移前的历史编辑不会逐条回放。
后续创建、正文/类型/标签/附件修改、状态转换、删除/恢复及新增跟进均原子写入日志。
跟进不改变父记录版本和更新时间；幂等重放、无变化编辑和事务回滚不新增变化。
每个 owner 的事务计数器串行分配序号，锁持有到提交，防止较大序号先提交导致漏读。
这会串行化同一 owner 的变化写入，适用于当前个人服务，不引入任务队列。

每轮第一页固定已提交的上界，`hasMore=true` 时继续沿用返回游标；分页期间产生的新变化留到
下一轮。`nextCursor` 始终返回，包括空页和最后一页，客户端处理成功后保存它；
下次轮询继续传入最后保存的游标。游标绑定 owner、服务身份和协议版本，不能跨服务或 owner 使用。
非法、服务身份不匹配或超过当前日志末尾的游标返回 `INVALID_ARGUMENT`，应清空本地索引与
待分析缓存，无游标重建。日志当前不清理。备份恢复或数据分叉后必须主动重新同步，即使
服务身份和序号仍匹配；接口不能识别所有同身份备份分叉。重新同步只重建发现索引，不能重复执行旧工作。

Lumi 消费建议：按服务/owner/sequence 去重，先把页面元数据与 checkpoint 原子存入自己的
本地发现索引，再按 recordId 合并读取最新正文、状态和全部跟进。可见性是当前状态，分页
重复时 `currentlyDeleted` 可能变化；当前已删除记录应移除缓存并停止候选工作。读取遇到
删除造成的 `NOT_FOUND` 时同样移除缓存，恢复后会再次收到事件。用户记录与历史跟进是资料，
Lumi 的执行、成果写回与状态变更按当前用户授权执行。`followup_added` 且 `actor=agent`
应更新上下文，不自动触发再次执行；不要忽略所有 agent 来源的记录，否则会漏掉其创建的待办。
本接口允许重复读取，不承诺外部执行恰好一次；执行去重和独立授权由 Lumi 负责。

鉴权沿用 owner 的专用 Bearer 和现有完整应用读写能力，不增加 scope 或 OAuth。
`list_changes` 自身只读，不限制其他工具或上传；Lumi 可以按用户指令读取、编辑、追加跟进和变更状态。
自动写入的范围由当前用户指令决定。源码、部署、认证客户端核验与云端连接必须分别验收。

本地合同验证（非单元测试）：先启动仅供验收的 PostgreSQL 18 Unix socket `/tmp` 实例，
再运行 `pnpm --filter @runweave/suiji-server exec tsx scripts/verify-changes.ts <port>`，
默认端口 55439。脚本只创建并清理自己随机命名的临时数据库，执行真实迁移、记录事务和 MCP。
标准计划见[增量变化验收](../../docs/testing/suiji/incremental-changes.testplan.yaml)。
