# 架构与网络拓扑

本文从架构沟通视角描述 Runweave 的系统边界、入口与核心链路，避免部署细节与本地路径。

## 总体形态

Runweave 当前由三条并行链路组成：

1. 前端 SPA 通过 HTTP 管理登录、终端 session、文件预览与诊断日志。
2. 前端通过 `/ws/terminal` 与 `/ws/terminal-events` 建立终端实时通道。
3. Electron 桌面客户端通过自定义协议（`runweave://`）加载前端，直连用户配置的远程后端。

说明：`runweave://` 是当前 Electron 自定义协议名，和产品名保持一致。

## 对外入口（高层）

- HTTP：登录、终端 session、文件预览、诊断日志、健康检查
- WebSocket：`/ws/terminal`、`/ws/terminal-events`
- Electron：通过连接管理器选择后端地址，所有 HTTP/WebSocket 请求直达远程后端

## 核心链路（概念级）

- **登录与终端会话**：HTTP 登录 -> 创建/查询/删除终端 session。
- **终端实时交互**：`/ws/terminal` 负责输入、输出、状态回执与历史补齐。
- **全局终端事件**：`/ws/terminal-events` 负责跨页面同步终端状态事件。

## 关键边界

- `/api/*` 走 Bearer Token 鉴权。
- `/ws/terminal` 与 `/ws/terminal-events` 在握手阶段校验短时 ticket。
- 后端不再提供服务端浏览器 viewer 相关 HTTP、WebSocket 或 DevTools 入口。

## Electron 客户端网络模型

- Electron 生产模式下，前端通过 `runweave://` 自定义协议加载，origin 与任何后端地址均不同源。
- 用户通过连接管理器配置多个后端地址，前端的 `apiBase` 由当前活跃连接决定。
- 跨域处理：Electron 主进程通过 `webRequest.onHeadersReceived` 拦截后端响应，在 `/api/*`、`/ws/*`、`/health` 路径上补齐 `Access-Control-Allow-Origin: *` 等 CORS 头，使渲染进程的 fetch/WebSocket 不受同源策略限制。若后端响应已经带有 CORS 头，Electron 不再重复注入，避免同一响应出现重复 `Access-Control-Allow-Origin`。
- 此方案完全在客户端侧解决，不依赖后端配置。
