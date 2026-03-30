# 架构与网络拓扑

本文从架构沟通视角描述系统边界、入口与核心链路，避免部署细节与本地路径。

## 总体形态

系统由三条并行链路组成：

1. 前端 SPA 通过 HTTP 管理会话与登录。
2. 前端通过 `/ws` 建立实时控制与画面通道。
3. DevTools 通过 `/devtools` 生成入口页，再由 `/ws/devtools-proxy` 同源代理到服务端本机调试端口。

## 对外入口（高层）

- HTTP：登录与会话管理、DevTools 入口页
- WebSocket：`/ws`（Viewer 交互）、`/ws/devtools-proxy`（DevTools 代理）

## 核心链路（概念级）

- **登录与会话**：HTTP 登录 -> 创建/查询/删除会话。
- **Viewer 实时交互**：`/ws` 负责输入、状态回执与画面回传。
- **DevTools**：前端先换取短时 ticket，再访问 `/devtools`，由服务端返回同源 DevTools 入口。

## 关键边界

- `/api/*` 走 Bearer Token 鉴权。
- `/ws` 在握手阶段校验 token 与 sessionId。
- `/devtools` 使用短时 ticket，避免在 URL 暴露长期登录 token。
- DevTools 代理链路保持同源，浏览器端不直接访问服务端本机调试端口。
