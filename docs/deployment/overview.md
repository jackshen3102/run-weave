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
- macOS 打包当前使用 ad-hoc codesign hook 清理隔离属性并对 `.app` bundle 做本地签名；这只保证本地可运行，不等同于 Developer ID 公证发布
- Electron 客户端支持多后端连接管理，用户可在连接页面添加、切换不同后端地址
- 打包后的 Electron 客户端会拉起内置后端；内置后端绑定 `0.0.0.0`，同一内网可通过 `http://<本机内网 IP>:<端口>/` 访问同一套 Web 前端
- 内置后端通过 `FRONTEND_DIST_DIR` 指向当前 runtime 的 `frontend/dist`，因此后端地址既提供 API / WebSocket，也提供前端静态页面
- 内网访问仍会暴露登录、Viewer、Terminal 等能力，不应在不可信网络中运行；发布包应确保默认账号密码已按环境要求修改

### 本地 Runtime 更新

Electron 桌面客户端分为稳定 shell 和可替换 runtime 包。shell 负责窗口、菜单、tray、preload、Terminal Browser/CDP Proxy、后端进程管理和回滚；runtime 包只包含前端 `dist`、后端 bundle、manifest 与文件校验信息。

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
