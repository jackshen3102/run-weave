# 知乎本机采集

私有 JSON 配置字段（只存凭据文件引用，不存 Cookie 或 CDP endpoint）：

- `schemaVersion:1`、`timeZone:"Asia/Shanghai"`、`serverId`、`ownerId`、`connectionId`；
- `externalAccountId`：在已登录 Profile 内只读 `/api/v4/me` 返回的稳定 `id`，不使用昵称；
- `machine`：本机 hostname；`profile`：已授权 `profile-1|2|3`；`group`：resolver 核实的 browserGroupId；
- 可选 `scheduledGroup:true`：仅在用户确认的后台任务配置中启用；有真实 scheduled run ID 时使用该运行自己的 `browser-group-scheduled-<runId>`，不能借用交互终端组。仍核对同一 Mac、Profile 和稳定知乎账号，每批持久化实际组引用；没有授权则停止。
- `stateDir`、`suijiConfig`、`tokenFile`：私有绝对路径。suijiConfig 沿用随记身份配置并指定 `mcpPath:"/mcp/browse"`，tokenFile 使用独立 browse 领域 MCP 凭据。
- 推荐 `transport:"http"` 并设置 `sessionFile` 私有绝对路径；不设置 transport 的旧配置沿用浏览器。保留 machine/profile/group 作为授权来源；HTTP 运行不解析 CDP 或创建 Browser Group，不需要 scheduledGroup。切换传输时新建配置文件，保留已有冻结批次引用的旧配置。
- 可选 `effectiveFrom:"YYYY-MM-DD"` 明确接入日期。默认范围不早于该日；显式 from 可历史补采，但接入前覆盖仍为 unknown。未设置时接入日期未知，不自动倒推。

管理员先通过随记服务的 browse connections HTTP 建立绑定；变更外部账号新建连接。服务不接收 Cookie、密码或 CDP token。采集器配置必须与服务连接、Mac 和浏览器绑定一致。

HTTP 入口为 `scripts/zhihu_http.py`，使用 Python 标准库、已有本机会话、域名与路径匹配的 Cookie 直接 GET；不依赖浏览器、外部签名库或第三方凭据服务。2026-11-07 实测身份、10 页个人历史及回答/文章接口可直接读取，16 条内容与浏览器结果一致；这不保证知乎未来不要求签名。所有跳转均拒绝，不向跳转目标发送凭据；响应上限 10 MiB。HTML 只解析文字，不执行或加载内容。

sessionFile 仅在用户明确授权后由 `authorize-http` 从原 Profile 获取，必须为本机私有普通文件，包含账号/机器/Profile 绑定与登录 Cookie。每轮前后通过 `/api/v4/me` 校验账号。Cookie 过期或身份/历史接口 401/403 返回 needs-login，由用户在原 Profile 检查登录并再次授权；验证页或未知结构按失败/缺口报告。正文接口 403 单独记录覆盖缺口，不触发重新授权，也不清空已有正文。不自动复制新登录态、不自动切换浏览器，不把失败当空历史。该命令禁止在定时运行中执行。会话不进入批次、随记服务或 Git。

旧浏览器入口 `scripts/zhihu-read.js` 由 prepare 注入范围，交给仓库固定 Playwright CLI 的 run-code 执行。只创建和关闭本轮临时 API 标签，结束 detach，保留用户页面。历史在 api.zhihu.com 同源页面读取，回答在 www.zhihu.com，文章在 zhuanlan.zhihu.com；不放宽跨域安全设置。

允许路径仅为 `/unify-consumption/read_history`、`/api/v4/me`、数字 ID 的 `/api/v4/answers/:id`、
`/api/articles/:id`。这些是重新验证的站内接口，不保证长期稳定。解析 single_card 的 data.extra
content_type/content_token/read_time 和 header.title；未知结构返回 partial，未知内容类型仅保留元数据。

每轮至多100页、每页20条；只按接口 is_end 结束，不凭未经证明的时间排序提前结束。首页变化最多重扫3轮。
每请求15秒硬截止（含连接、响应头和正文），且受整轮20分钟预算约束；仅在 macOS/POSIX 的采集主线程运行，并在请求结束恢复原计时器。网络/429/5xx最多3次尝试。正文不打开阅读详情页，HTML 提取安全文字，
不执行脚本，不读取受限图片/视频或绕过付费/403。开始与结束核对账号及历史首页签名；变化保留边界。

原批次状态与 lease 先落盘，OS 文件锁防并发；进程退出后接管 prepared/pending 必须复用原批次。
checkpoint 仅在回执独立读回后推进；它是补采线索，不替代重叠读取和内容身份去重。
休眠、离线、登录失效期间不保证覆盖，恢复只补仍可见历史。

新批次同时输出 adapter-receipt.json；字段、工作/浏览的统一语义及失败隔离见[来源适配器合同](../../suiji/references/source-adapter.md)。服务原导入 payload 和旧冻结批次保持原格式。
