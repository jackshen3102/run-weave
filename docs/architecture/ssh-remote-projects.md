# SSH 隧道、远端终端与本机 Browser

## 配置和生命周期

桌面右上角「更多 → 端口与隧道」管理 SSH 主机、开发端口转发与 Browser 回连。
配置属于桌面用户，不属于连接或项目。关闭抽屉、切换/删除连接、重载 renderer 不停止隧道；
显式断开主机或退出 Electron 才回收本实例的 SSH 子进程，不结束远端终端。

Electron main 是唯一写入者，在当前 userData 下维护：

- `tunnels/config.json`：主机、同号转发、Browser 配置、可选 Backend endpoint、revision。
- `tunnels/credentials.enc`：系统 safeStorage 加密的独立 Browser 登录；加密不可用时仅本次运行保留。
- `tunnels/runtime.json` 和 `desktop-network.json`：脱敏运行快照，不是配置源。
- `terminal-browser-profiles.json`：Profile 的代理模式、开发端口和项目首选 Browser。
- `terminal-browser-whistle/`：Whistle 自己维护的规则、Values 和证书。

配置原子落盘后应用，陈旧 revision 被拒绝，失败不覆盖最后有效配置。
Stable 沿用原用户目录，Beta/Dev Session 使用独立 userData、认证目录与 Whistle 端口租约；
同目录正常重启恢复已保存意图。默认 Direct 只作用于尚无显式设置的测试 Profile。

## 同号开发端口与 Backend 连接

系统 SSH 使用现有 SSH 配置和主机密钥；普通转发只要求 SSH 可达，不检查或安装 Agent、
不要求 Runweave Backend。用户端口严格 `127.0.0.1:P → 远端 127.0.0.1:P`，支持 HTTP/WebSocket。
受管连接沿用别名中的主机、用户、密钥和跳板设置，但不重复建立别名自带的端口转发；
只有本面板显式配置的转发由 Runweave 管理。
占用即报错，不随机换端口、不抢占其他进程。路径与端口随主机配置保存。
转发 SSH 子进程意外中断或连接超时时，在主机仍保持连接意图期间按退避节奏重试；
本机端口占用等确定性错误等待用户处理后显式重试。远端服务暂时不可用不会改变固定端口配置，
也不要求服务启动后才建立转发。编辑已连接主机的 SSH target 会停止旧连接并按新配置重新连接；
用户显式断开的主机仍保持断开。

可选 Backend endpoint 为仅 SSH 可达的 Backend 提供内部动态入口。连接记录仅引用 endpoint，
连接页既不启动隧道也不持有 SSH 配置；主机离线时等待通道。普通 URL 连接可完全独立使用。
受管 Workspace Service 先经所属 Backend 验证服务/项目和 `.localhost` 身份，再使用该 Backend 的内部入口并保留服务主机名。

一次性导入先保存受限加密备份，main 按 migrationId 幂等落盘、读回确认后删除旧运行字段。
旧转发草稿默认关闭。只有认证后确认同 installationId 才合并重复 SSH/URL 入口并保留普通 URL 名称；
无法确认则保留入口。旧 SSH 执行器和旧转发 IPC 已移除，不运行两套实现。

后台连接观察器等待认证/续期完成后请求数据；当前连接复用主页面认证，不并行刷新同一会话。
连接切换菜单只显示名称与选中标记。Attention 仍分别订阅连接的终端元数据；
点击提醒跳转到所属连接/项目/终端，不需要将项目统计放回连接菜单。

## Browser 通道和并发

### 桌面打开远端本地页面

从远端连接的终端点击 HTTP(S) 本地链接，或在该终端的 Browser 地址栏输入本地地址时，
桌面通过所属 Backend 的认证 WebSocket 访问其回环端口；不将 URL 主机简单替换为 Backend IP。
内置本地 Backend、SSH 面板已转发端口和 Workspace Service 专用入口继续使用原路径。
页面显示连接名称和“电脑本地预览”，保留原链接用于地址显示与复制，提供显式“在本机打开”。
已打开的预览绑定原连接与终端，切换当前连接不会改变目标；新目标需重新获得授权。

Backend 对 Electron 登录签发绑定终端、预览身份、目标地址/端口的一次性 60 秒凭证，
只由 Electron main 在 WebSocket Authorization header 使用。普通 Web 会话、带 Origin 的请求、
重复凭证和其他目标被拒绝；原生 iOS 通道保持原 App 会话校验。活跃流持续验证会话与终端存活。
桌面只在内存保留凭据，同一来源的登录续期会更新凭据；后台来源凭据到期后可能需要回原终端重新打开。

每个预览使用独立临时 Electron Session 和动态回环 HTTP 入口。预览入口直接访问；公网资源
使用选定 Profile 的 Direct/Whistle 出口，Whistle CA 校验也只安装到相应 Session。
Profile 自定义请求头按原始目标 URL 匹配；外部资源按其自身 URL 匹配，内部入口凭据不允许被规则覆盖。
创建、关闭预览不修改 Profile 的代理模式、规则、Values 或已有同号 SSH 转发；切换代理模式
会同步临时 Session 的出口，但不自动刷新预览或重放表单。转发只接受该 Session 注入的临时入口凭据，
凭据不会转发到开发服务。

支持相对资源、接口、上传和按页面地址连接的 WebSocket/HMR。页面使用临时预览 origin；
写死 localhost 的绝对资源、其他本地端口和绝对本地重定向被阻止，不能据此证明原 origin、
OAuth 或 Secure Cookie 等价。HTTPS 上游由 Backend 正常校验证书。预览不共享 Profile 登录态，
不参与闲置休眠或重启恢复；关闭页面释放自有资源与临时数据。删除/修改连接会停止对应预览。

入口：[桌面预览](../../electron/src/browser/local-preview/session.ts)、
[Backend 授权路由](../../backend/src/routes/browser-local.ts)、
[共享合同](../../packages/shared/src/browser/local-tunnel.ts)。

### Agent Browser 回连

Browser 回连链路是远端 Backend → SSH `-R` → 本机认证网关 → 获准 Profile/Group。
Browser 单独登录、刷新认证；失败只影响此子通道，不影响普通端口转发。
桌面、远端 Backend 与 CLI 需支持协议 2。身份由 desktopId、hostId、generation 和登录会话共同约束，
Backend 心跳过期后不再选择此 binding。

终端必须显式选择有效 binding；桌面根据认证后的 Backend 安装身份匹配本机通道，唯一候选可由
桌面自动选择，多个候选由用户选择。Backend 不按最后注册顺序猜测，未选择返回
`BROWSER_BINDING_REQUIRED`；覆盖仍活跃的其他桌面归属返回 `BROWSER_BINDING_CONFLICT`。
同一逻辑所有者重建通道后可以重新解析，其他登录不能用相同 ID 接管。

CLI 通过有效终端身份取得 capability，再申请一次性 60 秒 CDP 票据。网关验证项目、终端、
Profile、获准 Group 与代际。旧 capability/票据在通道重建后失效，Agent 必须重新 resolve/观察，
不会重放未知结果的操作。没有获准的 Group 不能由远端指定。

通道不是互斥锁。本地用户仍可操作同一个 Browser；不同标签可并行，同一标签的导航/输入可能互相
覆盖。同 Profile 共享 Cookie、登录态与代理配置；不同 Profile 保持隔离。

## 代理意图与运行状态

代理目标归 Profile。切换连接/项目或远端 Agent resolve 只读取设置，不改写开发端口。
项目首选 Browser 只影响选择哪个 Profile。旧项目端口通过明确的迁移选择写入 Profile，不取最后一项。

先保存代理意图再应用。启动失败保留 Whistle 选择并显示错误，不静默改 Direct；业务页导航前准备代理。
正式版三个监听端口为 8081/8082/8083；受管测试实例使用 manifest 中的独立集合，不漂移到正式端口。
`ready` 只说明代理进程状态，命中规则需通过实际请求与服务标识验证。

## 可选的远程访问本机

主机编辑表单中的「远程访问本机」默认关闭。用户选择自己的 SSH 主机、服务器内网 IPv4
和手机访问端口；首版支持 RFC1918 内网/VPN，不提供公网明文入口。服务器需有可由 SSH
执行的 Node.js，且允许反向端口转发。手机使用生成的地址和本机 Runweave 账号登录。
Beta 桌面端的 Backend 使用固定登录凭据，因此拒绝启动此通道；远程访问仅由正式桌面端提供。

Electron 复用主机连接意图，管理本机回环网关、SSH 反向通道及远端临时 TCP 中转进程；
不安装远端常驻服务、不修改 sshd 配置。关闭功能或断开主机时清理自有资源。
远端进程通过 stdin 接收心跳，超过 45 秒未收到心跳后在下一次 5 秒检查时退出；
反向监听端口每次重新分配，不要求清理其他 SSH 会话。

网关保留 Backend 鉴权，只转发 `/health`、`/api/` 与指定 WebSocket 路由，拒绝内部路由，
并标记转发头，使 Backend 的本机直连保护继续生效。每轮检查核验通道随机探针以及中转
入口和本机 Backend 的 serviceInstanceId；SSH 进程运行不等于入口可用，Mac 检查通过
也不代表手机已接入 VPN。

已验证通道的单次健康探测超时保留 SSH 与现有 socket，并显示探测失败；连续三次超时才关闭并重建。
新通道尚未验证、SSH 进程退出、探针或 Backend 实例身份不一致时立即关闭，不应用超时容忍。
通道创建、探测失败/恢复、SSH 退出与 WebSocket 连接/关闭写入 Desktop incident 日志，使用 channelId
串联，并保留客户端 connectionId/attemptId（不记录 ticket、完整 URL 或消息内容）。

状态进入右上角运行状态和隧道面板，未启用不告警；认证失效需用户恢复凭据并重试。
开启「启动桌面端时自动连接」只保存连接意图，仍需登录 Mac、启动桌面端和恢复网络。
本机离线时不能自行发送手机告警。旧私有 POC 的 LaunchAgent 不自动迁移或删除，避免
覆盖用户配置；迁移时应选不同端口验证后停用旧入口。

实现入口：[远程访问通道](../../electron/src/tunnels/remote-access.ts)、
[配置与状态](../../frontend/src/features/tunnels/remote-access.tsx)。

## 手机角色的只读范围

受认证的 `GET /api/tunnels` 与 `GET /api/desktop-network` 只读取当前 Backend 被明确授予的同机
`RUNWEAVE_DESKTOP_STATE_DIR`，无该根返回 `DESKTOP_STATE_UNAVAILABLE`。不接受查询参数指定其他路径，
不提供 HTTP 写配置接口，不通过数据库同步。手机连到哪个 Backend，就读取哪个节点可见的桌面状态。

快照超过 15 秒或执行器退出显示 offline，不把历史 ready 当当前事实。代理摘要仅包含模式、是否有规则、
状态和错误，不返回规则正文、刷新令牌或 gateway key。读取不会启动 SSH 或 Whistle。

远端终端/Agent 仍由远端 Backend 执行，可运行任意命令。tmux 存活取决于远端 socket/数据目录；
Backend 启动的 Workspace Service 生命周期不同，不能按 tmux 的保活合同推断。
部署见 [独立 Backend 部署](../deployment/backend-standalone.md#通过-agent-维护远端环境)。

实现入口：[共享隧道合同](../../packages/shared/src/tunnels/index.ts)、
[Electron 执行器](../../electron/src/tunnels/manager.ts)、
[Backend Browser 绑定](../../backend/src/remote/browser-bindings.ts)、
[本机只读模型](../../backend/src/tunnels/read-model.ts)。

### RemoteDesk 独立中转

同一 SSH 主机可单独启用 RemoteDesk；它使用另一个内网 TCP 入口，将原始 TLS 转发到当前
Mac 的 Host，不经过上述 Backend HTTP 白名单网关，也不要求 Backend 在线。隧道随 Runweave
桌面执行器与该 SSH 主机退出，不能自动启动 Host 共享或授予远控权限。配置、手机连接方式与
证据边界见 [RemoteDesk](remote-desktop.md#devbox-内网vpn-隧道)。
