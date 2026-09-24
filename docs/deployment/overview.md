# 部署与环境概览

本文仅保留 Runweave 的高层原则与入口说明，不包含本地路径或一步步命令。

## 原则

- 公网入口统一收口（HTTPS/WSS）。
- 后端服务不直接暴露公网端口。
- DevTools 通过同源代理访问服务端本机调试端口。
- 生产环境避免暴露远端调试端口。
- 登录接口默认有内存态限流与失败锁定，代理部署时只在 tunnel auth 开启后信任转发 IP 头。
- 生产、Electron packaged 和 runtime release 模式下，后端进程必须收到非默认认证配置；缺少 `AUTH_USERNAME`、`AUTH_PASSWORD` 或 `AUTH_JWT_SECRET` 会拒绝启动。
- `/test/*` 只在 `RUNWEAVE_E2E_TEST_ROUTES=true` 时启用；生产和普通开发环境返回 404。
- 打包后端服务前端静态资源时，hash asset 使用长期 immutable cache；`index.html`、manifest 和 service worker 使用重新验证缓存，避免 runtime 更新后继续加载旧入口。

## 对外入口（概览）

- HTTPS：登录、会话管理、Terminal API、completion event ticket
- WSS：Runweave Viewer、Terminal IO、Terminal completion events 与 DevTools 代理
- 前端 `apiBase` 为空时，HTTP / WebSocket 默认使用当前页面同源入口

## 运行位置

- 后端应用与调试端口仅在服务端内部可达。
- 浏览器仅访问公网入口与同源 WebSocket。
- 运行时 API 地址不依赖 `VITE_PROXY_TARGET` 兜底；需要跨源后端时应显式传入连接地址或通过入口代理收口。
- Terminal 内执行的用户命令运行在用户项目 `cwd` 下；提交类提示通过快捷指令或用户输入发送给当前 terminal 中已运行的 agent 处理，不新增后端 Git executor，也不要求 `rw` 在用户项目 `PATH` 中可用。

## 后端重启与终端保活

长期运行的服务器应显式设置 `TERMINAL_TMUX_SHUTDOWN_POLICY=preserve`。策略与 Desktop channel
独立；可销毁的环境可以配置 `cleanup`。完整默认值、校验与 socket 合同见
[tmux 生命周期](../architecture/terminal-tmux-recovery.md#连接与恢复)。systemd 部署还应保留
`KillMode=process`，避免服务管理器停止整个进程组；该设置本身不能阻止旧 Backend 主动清理 tmux。

首次升级时，旧 Backend 内存中仍是旧策略，修改配置后普通 restart 仍可能终止活动任务。
应先备份配置，在任务结束后的维护窗口切换；保持原 Profile、terminal store 与 socket 路径。
新策略生效后的重启，应验证 Backend PID 改变，而 tmux server、pane 和任务 PID 不变，输出仍继续。
需要无中断首次迁移时，必须另行验证旧进程切换、数据库恢复与 Profile 锁接管，不能直接强杀整个服务组。
回滚时同样不得在活动任务期间恢复旧清理策略；不删除 socket 或数据文件来绕过启动失败。

## Activity 正文密钥

Activity 正文与外部引用使用 AES-256-GCM 加密。macOS 沿用 Keychain；Linux 正常运行时在
Activity 数据目录首次创建 `.activity-content-key`，目录权限为 `0700`，密钥必须属于运行
Backend 的系统用户且权限为 `0600`。同一数据目录的 Backend 共用密钥，重启不会更换。
备份和迁移必须同时保存数据库与密钥，并保持运行用户和权限。不要在实际服务中开启
`RUNWEAVE_ACTIVITY_TEST_MODE` 来代替正式存储。

已有正文、引用或审计数据但密钥缺失时拒绝自动生成；密钥格式、权限或已有密文校验失败也会
停止 Activity 初始化，其他 Backend 功能继续运行。应恢复对应的原密钥，而不是删除数据或
生成新密钥。`GET /api/activity/policy` 的 `available` 表示事件存储，`contentStorage` 另行
表示正文能力；旧 Backend 省略后者时不能推断正文可用。初始化失败包含脱敏原因码。
容量不足等正文降级会保留事件，但写入回执带原因码，同时记录 `activity.content.omitted`。
过去 Linux 未保存的正文不会随升级自动恢复；Experience 将无正文与合法空输出区分处理。

Linux 正常密钥路径、跨 worker 共用、重启读取、密钥损坏/缺失与恢复的隔离验收包含在
`pnpm activity:verify`；该验收只使用临时目录，不修改当前服务数据。

## 鉴权与内部接口

- `/api/auth/login` 对同一 IP、同一用户名和 IP+用户名组合做内存态频率限制；超过阈值时返回 `429` 和 `Retry-After`。
- Web 客户端 refresh token 使用 `HttpOnly`、`SameSite=Lax` cookie；Electron 客户端继续通过 `x-auth-client: electron` 获取 JSON refresh token。
- Electron packaged 模式不再使用内置 `admin/admin` 默认账号。若启动环境没有完整认证变量，Electron shell 会在 `userData` 下生成 `backend-auth.json`，保存随机用户名、密码和 JWT secret，并以文件权限 `0600` 写入，再把这些值传给内置后端。生产服务端仍应显式配置认证变量。
- tunnel auth 开启时，`/health`、`/api/*`、`/internal/terminal-completion` 等入口先经过 tunnel auth；这时登录限流才会信任 `CF-Connecting-IP` / `X-Forwarded-For` 等代理头。
- `/internal/cdp-endpoint` 只接受本机直连请求，用于开发态同步本机 CDP endpoint。
- `/internal/terminal-completion` 还需要 `X-Runweave-Hook-Token`，用于 tmux pane 内 AI CLI hook 写入完成事件。

如需部署模板与配置示例，参考 `deploy/` 目录：

- `deploy/nginx/nginx.conf.example`
- `deploy/nginx/openssl-san.cnf.example`
- `deploy/whistle/proxy.md`
  飞书企业自建应用的通知、引用回复、Linux systemd 与 macOS LaunchAgent 配置见
  [`feishu-app-integration.md`](./feishu-app-integration.md)。

## Electron 桌面客户端

- 开发：`pnpm dev:electron`（启动后端 + 前端 + Electron 窗口）
- 带浏览器界面开发：`pnpm dev:electron:headed`
- 默认监听 `0.0.0.0`，可通过 `DEV_HOST` 环境变量覆盖
- 构建配置：`electron/electron-builder.yml`
- 桌面内置 Backend 与 Electron ABI 的 SQLite 模块同放在 App 的 `Contents/Resources/backend`；独立虚拟机 Backend 使用[自己的发布包](./backend-standalone.md)。
- 完整 Electron 构建会把固定版本 `whistle@2.10.9` 及其生产依赖、Web UI assets 和 LICENSE staged 到 `resources/whistle-runtime`；运行时不依赖系统或全局 `w2`。
- Terminal Browser 的三个 Profile 在 Whistle 模式下分别懒启动 loopback Whistle `8081/8082/8083`，应用退出时只停止自己启动的子进程。普通安装态默认使用 Whistle；带独立 userData 的受管 Dev Session 默认 Direct，可从 Profile 设置临时开启代理。三者使用独立 storage、共享 certDir，不修改系统代理或系统钥匙串。
- `deploy/whistle/proxy.md` 仍是人工部署示例。桌面运行时不会读取或导入该文件，也不会覆盖用户在 Whistle 控制台维护的 Rules；Runweave 只更新保留 Value `runweave-dev-server`。
- 升级时旧 Browser partition、workspace v1/v2 和旧 Header 规则进入 Profile 1；旧 `terminal-browser-proxy.json` 保留但不再读取。回滚或卸载不得自动删除新 Profile partition、三份 Whistle storage、共享 certDir 或 `terminal-browser-profiles.json`，旧版本会忽略这些新增数据。
- macOS 打包当前使用 ad-hoc codesign hook 清理隔离属性并对 `.app` bundle 做本地签名；这只保证本地可运行，不等同于 Developer ID 公证发布
- Electron 客户端支持多后端连接管理，用户可在连接页面添加、切换不同后端地址
- 打包后的 Electron 客户端会拉起内置后端；内置后端绑定 `0.0.0.0`，同一内网可通过 `http://<本机内网 IP>:<端口>/` 访问同一套 Web 前端
- 内置后端通过 `FRONTEND_DIST_DIR` 指向当前 runtime 的 `frontend/dist`，因此后端地址既提供 API / WebSocket，也提供前端静态页面
- 内网访问仍会暴露登录、Viewer、Terminal 等能力，不应在不可信网络中运行；发布包应确保默认账号密码已按环境要求修改

### 本地 Runtime 更新

Electron 桌面客户端分为稳定 shell 和可替换 runtime 包。shell 负责窗口、菜单、tray、preload、Terminal Browser/CDP Proxy、后端进程管理和回滚；runtime 包包含前端 `dist`、后端 bundle、Electron ABI 的 SQLite 模块、manifest 与文件校验信息。

本地更新入口：

```bash
pnpm runtime:build
pnpm runtime:install -- --latest
# 或一次完成
pnpm runtime:pack-and-install
```

默认 runtime 目录位于 Electron `userData` 下的 `runtime/`，包含 `current.json` 和 `releases/<releaseId>/manifest.json`。外部 runtime 仅在 manifest 有效且 shell 版本与当前客户端版本一致时优先加载；客户端版本升级后会优先使用新客户端自带的打包内置 runtime。没有外部 runtime、manifest 无效、版本不匹配、关键文件缺失或后端 `/health` 失败时，回退到最近可用 release 或打包内置 runtime。

边界：

- runtime 包必须同时包含前端和后端，禁止只替换其中一半。
- Electron shell、preload API、菜单、CDP Proxy、原生模块、权限模型变化仍需完整客户端更新。
- `node-pty` 等原生模块继续使用打包内置资源；runtime 包不承诺携带新的原生 ABI。
- manifest 路径、zip 解压和 sha256 校验是安全边界；坏包应失败并回滚，而不是部分加载。

## 定时任务运行

定时任务由 Backend 持有，关闭页面不停止调度；未打开运行记录时不创建终端。
管理与恢复合同见 [定时任务接入](../../frontend/docs/scheduled-tasks.md)，HTTP/DTO 分别以
[路由](../../backend/src/routes/scheduled-tasks.ts)与 [共享合同](../../packages/shared/src/scheduled-tasks/index.ts)为准。
任务、运行配置快照、幂等记录和输出存于独立 `scheduled-tasks.sqlite`，默认目录为
`<browserProfileDir>/scheduled-tasks`，可用 `RUNWEAVE_SCHEDULED_TASKS_HOME` 指定。

| 配置                                       | 默认值与用途                                    |
| ------------------------------------------ | ----------------------------------------------- |
| `RUNWEAVE_SCHEDULED_TASKS_ENABLED`         | 默认启用；`false` 禁用后台调度                  |
| `RUNWEAVE_SCHEDULED_TASK_TIMEOUT_MS`       | 7200000（2 小时），单次后台执行上限             |
| `RUNWEAVE_SCHEDULED_TASK_MAX_OUTPUT_BYTES` | 16777216（16 MiB），单次输出上限                |
| `RUNWEAVE_CODEX_BIN`                       | `codex`；启动时检查 CLI、登录状态及 tmux 可用性 |

Backend 每 5 秒检查到期任务，最多同时执行一个后台任务；同任务未结束时不重叠。
迟到超过 60 秒记录 missed 并跳到未来安排，不回放休眠或停机期间的历史执行。
暂停只影响后续安排；停止运行等待自有进程退出，不回滚已发生的文件或外部操作。
重启后对旧 owner 的判断保持保守，无法确认退出时返回 `owner_unresolved`，不靠租约超时重放提示词。
关闭 Backend 时先停止调度并排空执行，再关闭存储；存储初始化失败时接口报告调度不可用。

当前只启用通过可用性检查的 Codex，TraeX/Pi 不可用；结构化权限等待和人工接管尚未实现。
后台运行过滤父终端身份，以独立 run ID 记录，不应借用交互式终端的 Session/Panel 身份。
普通终端恢复必须确认原 thread 与 cwd，命令已提交不等于 attachment ready；后续自由追问不改已完成运行结果。

Electron 与 runtime 发布产物必须包含 `scheduled-tasks-sqlite-worker.cjs`；实际 worker 由
`RUNWEAVE_SCHEDULED_TASKS_WORKER_ENTRY` 指向当前产物。只替换页面或 Backend 主 bundle 不足以交付该能力。
验证入口为 `pnpm scheduled-tasks:verify-runtime`、[Backend 合同](../testing/scheduled-tasks/runtime.testplan.yaml)
和 [Web 合同](../testing/scheduled-tasks/web.testplan.yaml)。既有记录的 SRT-008 权限等待/接管仍未通过，
其他历史通过记录不代表本轮重跑；本次文档维护不启动任务或恢复真实对话。
