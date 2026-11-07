# 知乎本机采集

私有 JSON 配置字段（不允许会话凭据或 CDP endpoint）：

- `schemaVersion:1`、`timeZone:"Asia/Shanghai"`、`serverId`、`ownerId`、`connectionId`；
- `externalAccountId`：在已登录 Profile 内只读 `/api/v4/me` 返回的稳定 `id`，不使用昵称；
- `machine`：本机 hostname；`profile`：已授权 `profile-1|2|3`；`group`：resolver 核实的 browserGroupId；
- 可选 `scheduledGroup:true`：仅在用户确认的后台任务配置中启用；有真实 scheduled run ID 时使用该运行自己的 `browser-group-scheduled-<runId>`，不能借用交互终端组。仍核对同一 Mac、Profile 和稳定知乎账号，每批持久化实际组引用；没有授权则停止。
- `stateDir`、`suijiConfig`、`tokenFile`：私有绝对路径。suijiConfig 沿用随记身份配置并指定 `mcpPath:"/mcp/browse"`，tokenFile 使用独立 browse 领域 MCP 凭据。

管理员先通过随记服务的 browse connections HTTP 建立绑定；变更外部账号新建连接。服务不接收 Cookie、密码或 CDP token。采集器配置必须与服务连接、Mac 和浏览器绑定一致。

实际入口为 `scripts/zhihu-read.js`，由 prepare 注入范围，交给仓库固定 Playwright CLI 的 run-code 执行。
只创建和关闭本轮临时 API 标签，结束 detach，保留用户页面。历史在 api.zhihu.com 同源页面读取，
回答在 www.zhihu.com，文章在 zhuanlan.zhihu.com；不放宽跨域安全设置。

允许路径仅为 `/unify-consumption/read_history`、`/api/v4/me`、数字 ID 的 `/api/v4/answers/:id`、
`/api/articles/:id`。这些是重新验证的站内接口，不保证长期稳定。解析 single_card 的 data.extra
content_type/content_token/read_time 和 header.title；未知结构返回 partial，未知内容类型仅保留元数据。

每轮至多100页、每页20条；只按接口 is_end 结束，不凭未经证明的时间排序提前结束。首页变化最多重扫3轮。
每请求15秒，网络/429/5xx最多3次尝试。正文不打开阅读详情页，HTML 在惰性文档中提取安全文字，
不执行脚本，不读取受限图片/视频或绕过付费/403。开始与结束核对账号及历史首页签名；变化保留边界。

原批次状态与 lease 先落盘，OS 文件锁防并发；进程退出后接管 prepared/pending 必须复用原批次。
checkpoint 仅在回执独立读回后推进；它是补采线索，不替代重叠读取和内容身份去重。
休眠、离线、登录失效期间不保证覆盖，恢复只补仍可见历史。
