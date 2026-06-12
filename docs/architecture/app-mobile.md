# Runweave App 移动端边界

Runweave 的移动端能力由专门的 App 客户端承载，不再维护旧的 Web H5 移动终端页面。App 和桌面 Web 共用登录、项目、终端 session 与输入能力，但移动端首页和终端详情有独立的轻量契约。

## App 首页

App 首页读取 App-only 聚合接口：

```http
GET /api/app/home/overview
```

这个接口面向手机列表展示，返回项目、终端摘要、最近活动和基于后端 `TerminalState` 折叠出的展示状态。它不承担桌面 Preview、文件树或完整 scrollback 读取职责。

旧的 `/api/terminal/mobile/overview` 和旧 Web mobile 页面已经移除。移动端列表状态不应再由前端根据 tail 文本、命令名或输出变化自行推断；需要状态时以 App overview 和终端详情页的 `/state` 接口为准。

## App 终端详情

App 终端详情页的核心能力是：

- 打开指定 terminal session，持续查看实时输出。
- 通过底部 composer 发送命令、问题、图片或换行输入。
- 根据后端 `TerminalState` 决定是否展示 Stop。
- 通过底部 `Chat / Changes / Files` tabs 在移动端查看终端输出、项目变更和项目文件。
- 在手机触摸场景下避免误弹软键盘，同时保留明确的输入入口。

Stop 只是向终端/Codex CLI 发送控制输入，不直接把状态改成 idle。Stop 按钮是否消失，取决于后端状态接口后续返回的 `TerminalState`。

## 与桌面 Web 的边界

App 不直接复用桌面 Terminal Workspace 的布局、Preview sidecar、Monaco、拖拽排序或 Browser 工具。手机端需要文件/变更审阅时，应使用 App 专属交互和同一套 project-scoped Preview API，但不能把桌面分栏组件直接搬到 App。

当前稳定边界：

- App 首页使用 `/api/app/home/overview` 读取项目和终端摘要，并通过全局 `/ws/terminal-events` 接收 terminal state 变化。
- App 终端详情使用 terminal websocket、input、interrupt、clipboard image API 和 `/api/terminal/session/:id/state` 兜底查询。
- `Changes` 和 `Files` tabs 复用 project-scoped Preview API，提供移动端只读审阅入口；它们不把桌面 Preview sidecar、Monaco、拖拽排序或 Browser 工具搬到 App。
- 行级编辑、文件写入、桌面级 Browser 工具和完整 IDE 交互不属于当前 App 稳定能力；落地前不要在 README 或入口文档中表述为已完成。

## 配置与安全

移动 App 需要访问后端时，仍应走正常认证 token 和明确的后端地址配置。CORS / WebView origin 应由部署或开发脚本显式配置，不应把通用移动 WebView origin 当成 App 身份边界。

App 相关 native 工程设置（例如 iOS deployment target、签名 team）应保持可移植，避免把个人本机 Xcode 状态提交为项目级默认。
