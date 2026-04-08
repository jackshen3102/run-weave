# 架构与网络拓扑

本文从架构沟通视角描述系统边界、入口与核心链路，避免部署细节与本地路径。

## 总体形态

系统由五条并行链路组成：

1. 前端 SPA 通过 HTTP 管理会话与登录。
2. 前端通过 `/ws` 建立实时控制与画面通道。
3. DevTools 通过 `/devtools` 生成入口页，再由 `/ws/devtools-proxy` 同源代理到服务端本机调试端口。
4. AI/自动化工具通过 `ai-default -> ai-bridge -> /ws/ai-bridge` 复用 viewer 创建的浏览器。
5. Electron 桌面客户端通过自定义协议（`browser-viewer://`）加载前端，直连用户配置的远程后端。

## 对外入口（高层）

- HTTP：登录、会话管理、默认 AI viewer 管理、AI bridge/DevTools 入口页
- WebSocket：`/ws`（Viewer 交互）、`/ws/ai-bridge`（AI/CDP 附着）、`/ws/devtools-proxy`（DevTools 代理）
- Electron：通过连接管理器选择后端地址，所有 HTTP/WebSocket 请求直达远程后端

## 核心链路（概念级）

- **登录与会话**：HTTP 登录 -> 创建/查询/删除会话。
- **Viewer 实时交互**：`/ws` 负责输入、状态回执与画面回传。
- **默认 AI viewer**：HTTP 查询 `GET /api/session/ai-default`，缺失时用 `POST /api/session/ai-default/ensure` 创建一个可恢复的默认 viewer 会话。
- **AI bridge**：先通过 `POST /api/session/:id/ai-bridge` 获得 session 级 bridge 信息，再通过 `/ws/ai-bridge?sessionId=...` 把外部工具附着到该浏览器。
- **DevTools**：前端先换取短时 ticket，再访问 `/devtools`，由服务端返回同源 DevTools 入口。

## 关键边界

- `/api/*` 走 Bearer Token 鉴权。
- `/ws` 在握手阶段校验 token 与 sessionId。
- `/ws/ai-bridge` 当前只校验 `sessionId` 是否存在，对应的使用授权由前置 HTTP API 控制。
- `/devtools` 使用短时 ticket，避免在 URL 暴露长期登录 token。
- DevTools 代理链路保持同源，浏览器端不直接访问服务端本机调试端口。
- “Default AI Viewer” 当前只允许持久 `launch` 会话承担；`connect-cdp` 会话不能设为默认。

## Electron 客户端网络模型

- Electron 生产模式下，前端通过 `browser-viewer://` 自定义协议加载，origin 与任何后端地址均不同源。
- 用户通过连接管理器配置多个后端地址，前端的 `apiBase` 由当前活跃连接决定。
- 跨域处理：Electron 主进程通过 `webRequest.onHeadersReceived` 拦截后端响应，在 `/api/*`、`/ws/*`、`/devtools/*`、`/health` 路径上注入 `Access-Control-Allow-Origin: *` 等 CORS 头，使渲染进程的 fetch/WebSocket 不受同源策略限制。
- 此方案完全在客户端侧解决，不依赖后端配置。
