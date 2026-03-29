# Remote Terminal Design

## 背景

`browser-viewer` 当前已经具备完整的远程浏览器会话能力：

- 前端通过 HTTP 调用后端完成登录和会话管理。
- 前端通过 `/ws` 与后端建立 Viewer 实时控制通道。
- 后端通过 Playwright / CDP 维护浏览器会话。

本需求希望在同一个系统中新增“远程终端”能力，让用户可以直接在浏览器中运行交互式命令，例如 `codex`、`claude`、shell 命令和项目脚本，而不需要再本地打开终端去连接远端环境。

## 目标

新增一个独立的 Remote Terminal 子系统，满足以下目标：

1. 终端会话独立存在，不依附于 Browser Session。
2. 终端支持交互式 TTY，而不是一次性命令执行。
3. 前端先支持独立 Terminal 页面，后续可以嵌入 Viewer 或工作台布局。
4. 终端能力和现有 Viewer 架构并行接入，尽量复用现有认证、HTTP、WebSocket 和 shared type 模式。

## 非目标

当前阶段不包含以下内容：

- 不要求在第一期实现多 terminal tab。
- 不要求在第一期实现 scrollback 持久化。
- 不要求在第一期实现复杂权限分级、审计中心或共享只读模式。
- 不要求在第一期把 terminal 完整嵌进 viewer 页面。

## 核心设计

### 1. 独立的 Terminal Session

新增 `Terminal Session` 作为与 `Browser Session` 平行的资源。

关键属性：

- `terminalSessionId`
- `name`
- `command`
- `args`
- `cwd`
- `linkedBrowserSessionId?`
- `status`
- `createdAt`
- `lastActivityAt`
- `exitCode?`

`linkedBrowserSessionId` 为可选字段，仅用于前端体验上的跳转和关联展示，不作为生命周期绑定关系。

### 2. 独立的 Terminal WebSocket

终端不复用现有 `/ws`，而是新增专用实时链路，例如：

- HTTP: `/api/terminal/session`
- WebSocket: `/ws/terminal`

原因：

- Viewer 通道是结构化控制消息 + 画面流。
- Terminal 通道是高频输入输出流 + resize + signal。
- 两者协议、状态机和错误模型都明显不同。

### 3. 后端采用 PTY 模型

为了支持 `codex`、`claude`、shell、`vim` 风格交互，终端后端必须基于真正的 PTY。

需要具备的运行时能力：

- 实时 stdin / stdout
- terminal resize
- ANSI / VT100 控制序列
- alternate screen
- UTF-8 和宽字符处理
- 控制字符与信号，如 `Ctrl+C`
- 长时间会话运行

这类能力不应建立在普通 `spawn + pipe` 上。

### 4. 终端运行时所有权与回收

Terminal Session 的元数据和 PTY 运行时不能完全分离，否则会出现以下问题：

- 无法维护 `terminalSessionId -> PTY` 的稳定映射
- 前端断线后无法重新 attach 到原进程
- 后端退出时无法统一 dispose 所有终端进程
- 已删除 session 可能遗留孤儿 PTY

因此第一期需要明确两层职责：

- `TerminalSessionManager`
  - 管理持久化 metadata
  - 提供 session 的创建、查询、列表、状态变更和删除
- `TerminalRuntimeRegistry` 或等价组件
  - 维护内存中的 `terminalSessionId -> PTY runtime` 映射
  - 负责 attach、detach、write、resize、signal、exit 监听
  - 负责服务退出时的统一回收

设计原则：

- HTTP 创建 terminal session 时，同时创建对应 runtime 并注册到 runtime registry。
- WebSocket 连接只 attach 到已存在的 terminal runtime，不直接拥有 PTY 生命周期。
- 前端断线不会默认销毁 PTY，只改变 attach 状态。
- session 删除、进程退出、服务关闭时，runtime registry 负责最终 dispose。

### 5. 第一阶段直接支持任意命令

第一期终端创建不引入 profile 机制，直接允许前端提交任意命令、参数和工作目录。

建议请求模型直接包含：

- `command`
- `args`
- `cwd`
- `linkedBrowserSessionId?`

这样可以先快速打通远程终端的主链路，避免在第一阶段把交互模型绑定到预设 profile 上。

## 与现有代码的衔接

### 后端

现有后端装配入口为 [`backend/src/index.ts`](/Users/bytedance/Desktop/vscode/browser-hub/browser-viewer/backend/src/index.ts)，已具备：

- `Express` HTTP 服务
- `/ws` Viewer WebSocket
- 鉴权中间件
- Session Manager
- SQLite 持久化

Remote Terminal 采用同样的组织方式，新增独立模块：

- `backend/src/routes/terminal.ts`
- `backend/src/ws/terminal-server.ts`
- `backend/src/ws/terminal-handshake.ts`
- `backend/src/terminal/manager.ts`
- `backend/src/terminal/runtime-registry.ts`
- `backend/src/terminal/pty-service.ts`
- `backend/src/terminal/store.ts`
- `backend/src/terminal/sqlite-store.ts`

### Shared

现有协议定义在 [`packages/shared/src/protocol.ts`](/Users/bytedance/Desktop/vscode/browser-hub/browser-viewer/packages/shared/src/protocol.ts)。

Remote Terminal 建议新增独立协议文件：

- `packages/shared/src/terminal-protocol.ts`

这样可以避免把 terminal 的高频字符流消息混入 Viewer 协议。

### 前端

现有前端已具备：

- Home 页会话创建和列表
- Viewer 页面与 WebSocket 连接
- 统一的 service 层和鉴权处理

Remote Terminal 第一阶段新增：

- 独立 Terminal 页面
- terminal service
- terminal websocket hook
- 从 Home 或 Viewer 打开 terminal 的入口

建议模块：

- `frontend/src/pages/terminal-page.tsx`
- `frontend/src/features/terminal/use-terminal-connection.ts`
- `frontend/src/services/terminal.ts`
- `frontend/src/components/terminal/*`

## 用户体验

第一阶段建议采用最小可用体验：

1. 用户在前端创建 terminal session。
2. 进入独立 Terminal 页面。
3. 页面通过 `/ws/terminal` 连接并展示实时终端。
4. 用户可以输入命令、调整窗口大小、结束会话。
5. 如果 terminal 与某个 browser session 关联，前端提供跳转入口，但两者不强绑定。

后续可扩展为：

- Viewer 内嵌 terminal panel
- Browser + Terminal 双栏工作台
- 最近 terminal 列表
- 终端重连和恢复

## 安全与边界

第一阶段建议控制在以下边界：

- 终端创建接口必须走现有 Bearer Token 鉴权。
- terminal websocket 握手复用现有 query token 模式。
- 第一阶段允许任意命令，优先保证能力可用；命令治理与模板能力留到后续阶段处理。
- terminal 和 browser session 分离，避免现有 viewer 逻辑被终端能力侵入。
- PTY runtime 必须由统一 registry 持有并在服务关闭时集中回收。

## 分阶段落地

### 第一阶段

- Terminal Session 资源模型
- `/api/terminal/session`
- `/ws/terminal`
- PTY 驱动交互式终端
- runtime registry 与 attach/detach 语义
- 任意命令、参数和工作目录
- 独立 Terminal 页面

### 第二阶段

- 与 Browser Session 的弱关联入口
- 终端重连
- 终端列表和最近会话
- Viewer 内嵌 terminal panel
- profile、模板与命令预设

### 第三阶段

- 工作台布局
- 多 terminal tab
- 输出持久化和搜索
- 更细粒度的权限与治理能力

## 结论

Remote Terminal 最合适的实现方式是：

- 独立 Terminal Session
- 独立 `/ws/terminal`
- 独立 terminal 协议
- 后端采用 PTY 模型
- 与现有 Browser Session 保持弱关联

这条路线与当前 `browser-viewer` 的架构风格一致，能在不污染现有 Viewer 通道的前提下，为交互式 CLI 提供稳定的扩展基础。
