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
- 内置后端通过 `FRONTEND_DIST_DIR` 指向打包资源中的 `frontend/dist`，因此后端地址既提供 API / WebSocket，也提供前端静态页面
- 内网访问仍会暴露登录、Viewer、Terminal 等能力，不应在不可信网络中运行；发布包应确保默认账号密码已按环境要求修改
