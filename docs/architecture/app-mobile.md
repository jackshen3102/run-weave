# Runweave App 移动端边界

Runweave 的移动端能力由专门的 App 客户端承载，不再维护旧的 Web H5 移动终端页面。App 和桌面 Web 共用登录、项目、终端 session 与输入能力，但移动端首页和终端详情有独立的轻量契约。

## App 首页

App 首页展示当前电脑连接状态（Online / Checking / Offline）并读取 App-only 聚合接口：

```http
GET /api/app/home/overview
```

这个接口面向手机列表展示，返回项目、终端摘要、最近活动和基于后端 `TerminalState` 折叠出的展示状态。它不承担桌面 Preview、文件树或完整 scrollback 读取职责。

设备在线状态表达的是 App 当前配置的本地电脑后端是否可达、进程是否响应、以及 App 是否可以继续使用该电脑上的项目和终端能力。它不是某个 terminal session 的 `running/exited`，也不是 `TerminalState` 的 `agent_running/agent_idle`。App 通过轻量 `/health` probe、terminal-events 服务端 `connected` 消息和业务 API 成功结果标记 online；电脑不可达时保留已加载的首页数据和登录态，只显示离线提示。

App 支持在客户端本地管理多个 Runweave 后端连接。连接列表、当前 active connection 和连接可用性只属于 App 本地 UI 状态，不新增后端连接管理 API。首页和登录页会显示当前连接名称与 host；用户切换连接后，后续 `/health`、认证、App overview、terminal-events ticket、terminal websocket ticket 和业务 API 都应指向新的 active connection。

旧的 `/api/terminal/mobile/overview` 和旧 Web mobile 页面已经移除。移动端列表状态不应再由前端根据 tail 文本、命令名或输出变化自行推断；需要状态时以 App overview 和终端详情页的 `/state` 接口为准。

## App 终端详情

App 终端详情页的核心能力是：

- 打开指定 terminal session，持续查看实时输出。
- 通过底部 composer 发送命令、问题、图片、语音转写结果或换行输入。
- 根据后端 `TerminalState` 决定是否展示 Stop。
- 通过底部 `Chat / Changes / Files` tabs 在移动端查看终端输出、项目变更和项目文件。
- 在手机触摸场景下避免误弹软键盘，同时保留明确的输入入口。

Stop 只是向终端/Codex/Trae CLI 发送控制输入，不直接把状态改成 idle。Stop 按钮是否消失，取决于后端状态接口后续返回的 `TerminalState`。

图片按钮复用现有 terminal clipboard image 上传接口，把图片保存到后端临时目录后，将 shell-quoted 文件路径插入 composer。选择图片不会立即写入终端；用户仍需要检查并点击发送。App 不在输入框上方维护预览 chip、缩略图或附件列表。

当设备 offline 时，详情页优先显示 `Computer Offline`，暂停 terminal websocket、terminal-events websocket 和 `/state` 轮询，并阻止发送输入、Stop、上传图片、删除终端和新建终端等写入操作。恢复 online 后再重连并刷新状态；离线期间的输入不能进入待发送队列并在恢复后自动 flush。

## App 终端语音输入

App 终端 composer 支持录音转文字：用户点击麦克风后在本机录制 WAV，再调用后端转写接口，成功后把转写文本追加到 composer，仍由用户确认后发送到 terminal。语音转写只是输入辅助，不会自动执行命令。

稳定接口：

```http
POST /api/voice/transcribe
Content-Type: application/json
```

请求体由 shared voice 协议约束，目前只接受 24 kHz WAV：

```json
{
  "mimeType": "audio/wav",
  "audioBase64": "<base64 wav>",
  "sampleRateHz": 24000,
  "durationMs": 1234
}
```

返回：

```json
{ "text": "转写后的文本" }
```

当前能力边界：

- 前端有 `starting / recording / transcribing` 状态，录音启动或权限弹窗期间会禁用麦克风按钮，避免重复创建录音流。
- 转写失败只记录 support log 并回到可输入状态，不清空 composer 中已有文本。
- 后端路由挂在正常登录态后面，但当前接口仍是全局 voice service，没有绑定 terminal session。需要审计、频控或按 session 授权时，应优先收敛到 terminal-scoped API。
- 当前后端 provider 依赖本机 Codex app-server/ChatGPT 转写能力，属于实现细节和风险边界；生产化前应替换为显式配置的转写 provider 或平台本地转写能力。

## 与桌面 Web 的边界

App 不直接复用桌面 Terminal Workspace 的布局、Preview sidecar、Monaco、拖拽排序或 Browser 工具。手机端需要文件/变更审阅时，应使用 App 专属交互和同一套 project-scoped Preview API，但不能把桌面分栏组件直接搬到 App。

当前稳定边界：

- App 首页使用 `/api/app/home/overview` 读取项目和终端摘要，并通过全局 `/ws/terminal-events` 接收 terminal state 变化；设备 online/offline 另由 App 侧设备连接状态管理，不混入 terminal display status。
- App 终端详情使用 terminal websocket、input、interrupt、clipboard image API、voice transcription API 和 `/api/terminal/session/:id/state` 兜底查询。
- `Changes` 和 `Files` tabs 复用 project-scoped Preview API，提供移动端只读审阅入口；它们不把桌面 Preview sidecar、Monaco、拖拽排序或 Browser 工具搬到 App。
- 行级编辑、文件写入、桌面级 Browser 工具和完整 IDE 交互不属于当前 App 稳定能力；落地前不要在 README 或入口文档中表述为已完成。

## 配置与安全

移动 App 需要访问后端时，仍应走正常认证 token 和明确的后端地址配置。CORS / WebView origin 应由部署或开发脚本显式配置，不应把通用移动 WebView origin 当成 App 身份边界。

连接管理的稳定边界：

- 默认连接来自 `VITE_RUNWEAVE_API_BASE`，没有显式 API base 时可回退到当前 App origin。
- 用户新增连接时，URL 必须是 `http://` 或 `https://`，并会去掉 query、hash 和末尾斜杠。
- 每个连接的认证 session 按 connectionId 隔离。切换连接不会等同于全局 logout；删除连接只清理该连接的 session。
- 目标后端网络不可达、`/health` 超时或普通 HTTP 错误只影响该连接的 online/offline 展示，不清理 token。
- 明确的 401 只清理当前连接的认证 session，不影响其他连接。
- 在 Terminal 页切换连接时，不复用旧 URL 里的 `terminalSessionId`，应回到目标连接的 Home 或 Login。

Native 平台的 refresh token 必须经 `RunweaveSecureCredentials` 原生安全存储插件保存；localStorage fallback 只用于浏览器开发环境。localStorage 里可以保存连接列表和非敏感认证索引，不应保存多个 native 后端的 refresh token 明文集合。

App 相关 native 工程设置（例如 iOS deployment target、签名 team）应保持可移植，避免把个人本机 Xcode 状态提交为项目级默认。
