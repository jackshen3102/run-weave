# 部署与环境概览

本文仅保留 Runweave 的高层原则与入口说明，不包含本地路径或一步步命令。

## 原则

- 公网入口统一收口（HTTPS/WSS）。
- 后端服务不直接暴露公网端口。
- DevTools 通过同源代理访问服务端本机调试端口。
- 生产环境避免暴露远端调试端口。

## 对外入口（概览）

- HTTPS：登录与会话管理
- WSS：Runweave Viewer 与 DevTools 代理
- 前端 `apiBase` 为空时，HTTP / WebSocket 默认使用当前页面同源入口

## 运行位置

- 后端应用与调试端口仅在服务端内部可达。
- 浏览器仅访问公网入口与同源 WebSocket。
- 运行时 API 地址不依赖 `VITE_PROXY_TARGET` 兜底；需要跨源后端时应显式传入连接地址或通过入口代理收口。

如需部署模板与配置示例，参考 `deploy/` 目录：

- `deploy/nginx/nginx.conf.example`
- `deploy/nginx/openssl-san.cnf.example`
- `deploy/whistle/proxy.md`

## Electron 桌面客户端

- 开发：`pnpm dev:electron`（启动后端 + 前端 + Electron 窗口）
- 带浏览器界面开发：`pnpm dev:electron:headed`
- 默认监听 `0.0.0.0`，可通过 `DEV_HOST` 环境变量覆盖
- 构建配置：`electron/electron-builder.yml`
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

默认 runtime 目录位于 Electron `userData` 下的 `runtime/`，包含 `current.json` 和 `releases/<releaseId>/manifest.json`。外部 runtime 有效时优先加载外部前端和后端；没有外部 runtime、manifest 无效、关键文件缺失或后端 `/health` 失败时，回退到最近可用 release 或打包内置 runtime。

边界：

- runtime 包必须同时包含前端和后端，禁止只替换其中一半。
- Electron shell、preload API、菜单、CDP Proxy、原生模块、权限模型变化仍需完整客户端更新。
- `node-pty` 等原生模块继续使用打包内置资源；runtime 包不承诺携带新的原生 ABI。
- manifest 路径、zip 解压和 sha256 校验是安全边界；坏包应失败并回滚，而不是部分加载。
