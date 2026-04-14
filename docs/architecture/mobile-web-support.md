# 移动端 Web 支持

本文描述 Web 端面向手机与触摸屏场景的产品边界、当前实现和后续演进约束。移动端不是把桌面端界面缩小成 H5，而是一条以观察和轻量恢复为主的体验分支。

## 背景

桌面 Web 端是完整控制台形态：

1. Home 负责会话创建、会话列表、默认 AI Viewer、Terminal 入口等管理能力。
2. Viewer 通过 `/ws` 接收浏览器 screencast，并可把鼠标、滚轮、键盘、剪贴板、tab、navigation、DevTools 等输入转发给后端。
3. Terminal 提供完整 xterm 工作台，包括项目、会话、搜索、设置、输入、历史等能力。

这些能力适合桌面端，但直接下放到手机端会带来屏幕空间不足、触摸误操作、复杂配置难以输入等问题。因此移动端默认定位为“口袋里的观察窗口”，只保留安全且高频的查看、打开和恢复入口。

## 当前实现

### Client Mode

前端新增 `ClientMode`：

```ts
type ClientMode = "desktop" | "mobile";
```

模式由 `resolveClientMode` 和 `useClientMode` 统一判断：

- Electron 客户端始终使用 `desktop`。
- `viewportWidth <= 767` 使用 `mobile`。
- `pointer: coarse` 且 `viewportWidth <= 1024` 使用 `mobile`。
- `?clientMode=desktop` / `?clientMode=mobile` 可用于开发调试覆盖。

`ClientMode` 是体验分支开关，不应演变成散落在各处的按钮级临时判断。新增移动端能力时，优先让页面或 chrome 层根据模式切换，核心连接、状态和服务逻辑保持复用。

### Home

Home 在 `mobile` 模式下展示 Mobile Dashboard：

- 顶部展示产品名和当前连接名。
- 保留 Terminal 快捷入口与 Logout。
- 会话列表复用现有 session 数据、排序和卡片组件。
- Session action 使用 `open-only`，只展示 Open，不展示 Rename、Remove、Set Default AI Viewer 等管理动作。
- 不展示桌面端的 CDP endpoint、proxy、headers、browser profile 等创建配置。

桌面端 Home 保持完整控制台能力。

### Viewer

Viewer 在 `mobile` 模式下进入 observe chrome：

- 展示 Home 返回入口、当前 tab 标题、当前 URL 或连接状态。
- 在断线或重连状态下展示 Reconnect。
- 继续复用现有 HTTP ticket、WebSocket、screencast canvas、tabs、navigation、collaboration 状态接收链路。
- 不挂载桌面输入桥接 textarea。
- 不展示 DevTools / Inspect、New tab、Close tab、More actions、完整地址栏导航、AI Assist、AI Bridge URL 等桌面控制入口。
- canvas 不绑定鼠标、滚轮、context menu 等桌面输入事件，触摸滚动也不会转发为远端浏览器输入。

桌面端 Viewer 保留原有控制能力。

### Terminal

Terminal 在 `mobile` 模式下是轻量 monitor，而不是完整 workspace：

- 项目与 terminal tab 列表可查看、切换。
- 不展示 New Project、Delete Project、New Terminal、Close Terminal、桌面快捷键提示、renderer / font 等复杂设置入口。
- 仍复用 `TerminalWorkspace`、`TerminalSurface`、terminal session 状态、xterm 输出渲染、scrollback 恢复和 metadata 更新链路。
- 移动端会关闭桌面搜索与设置浮层。

当前 v1 已提供受限输入能力，用于处理手机键盘输入和常用终端控制键：

- xterm helper textarea 的 `beforeinput` 会映射文本输入、回车、退格、Delete。
- 顶部 `Keys` 开关可打开移动端快捷键条，提供 Up、Down、Tab、Esc、Ctrl-C。
- 快捷键条只发送明确的终端序列，不开放完整桌面工作台管理能力。

这不是浏览器 Viewer 的远端控制模式，也不代表移动端 Terminal 拥有完整桌面管理能力。后续如果扩展为更强的手机端终端操作，应继续限制在 Terminal 语义内，并保持管理动作与危险动作显式可见。

### Terminal 重连与待发送输入

Terminal WebSocket 重连策略收紧为确定性规则：

- 正常关闭、鉴权关闭、服务端内部关闭不自动重连。
- `Terminal runtime not found`、terminal 已退出不自动重连。
- 连接存活至少 `MIN_TERMINAL_RECONNECT_LIFETIME_MS` 后才参与自动重连判断。
- 最多连续自动重连 `MAX_TERMINAL_RECONNECT_ATTEMPTS` 次。
- 稳定连接一段时间后重置连续重连计数。

输入发送支持短暂断线窗口：

- socket 未打开时，输入会进入待发送队列。
- 待发送输入总量上限为 8 KiB，超出后丢弃最旧输入。
- 如果连接已经关闭，新的待发送输入会触发一次手动重连 nonce。
- WebSocket 重新打开后先发送 pending resize，再 flush pending input。

这可以减少移动网络抖动或页面刚恢复时的输入丢失，但不改变 terminal 已退出、鉴权失败等不可恢复状态的处理。

### Viewer URL 基准地址

`toHttpBase` / `toWebSocketBase` 对空 `apiBase` 使用当前页面 origin：

- HTTP 使用 `window.location.origin`。
- WebSocket 使用当前 origin 的 `ws` / `wss` 版本。

前端不再从 `VITE_PROXY_TARGET` 兜底推导运行时 API 地址。部署时应通过同源入口或显式 `apiBase` 提供后端地址，避免构建期代理配置泄漏到运行时行为。

### 移动端 viewport

全局样式为 `html`、`body`、`#root` 增加 `-webkit-fill-available`，用于缓解 iOS Safari 动态地址栏导致的高度计算问题。移动端页面优先使用 `dvh` / `-webkit-fill-available` 组合，避免首屏布局被浏览器 chrome 挤压。

## 设计原则

### 产品分层优先于响应式布局

响应式布局只能解决元素排列问题，不能解决“手机端应该做什么”的问题。

桌面端是操作台，适合放置：

- 创建浏览器
- Attach CDP
- proxy、headers、browser profile 配置
- tab 管理
- DevTools
- AI Assist / AI Bridge
- 完整 Terminal 工作台

移动端是观察台，适合放置：

- session 状态
- 当前页面画面
- 页面加载、错误、重连状态
- AI 协作状态摘要
- Terminal 输出与状态
- 少量安全的恢复动作，例如返回、打开、重连

### 控制能力必须显式进入新模式

手机端 Viewer 不默认把 tap、scroll、keyboard 转成远端浏览器输入。默认观察模式下，画面就是画面，不是远端页面的控制面板。

如果后续确实需要手机端操作浏览器，应引入独立的“接管控制”模式：

- 用户显式进入。
- UI 明确提示当前会影响远端浏览器。
- 只开放少量高价值操作。
- 可以随时退出回到观察模式。
- 后端最好能识别 observe / control，避免只靠前端约束。

当前 v1 不实现 Viewer 接管控制模式。

### 不泄露桌面-only 能力

移动端 Viewer v1 不只是隐藏按钮，而是不挂载相关入口和交互。

移动端 Viewer 不展示：

- DevTools / Inspect
- New tab
- Close tab
- tab 管理菜单
- 完整地址栏导航
- AI Assist
- Copy AI Bridge URL
- 页面输入桥接入口
- 鼠标、键盘、滚轮控制提示

移动端可展示：

- 返回入口
- 当前页面画面
- 连接状态
- 加载状态
- 错误状态
- 重连入口
- 只读的 AI 协作状态摘要

### 核心组件复用优先

移动端和桌面端不应各自复制一套业务组件。适配时优先保留同一个核心组件、同一个状态 hook、同一个服务调用，只在外层布局、chrome、能力开关上做差异化。

推荐分层：

- Core：连接、数据、画面绘制、状态推导、基础展示组件。
- Chrome：桌面端和移动端不同的工具栏、菜单、入口组织方式。
- Layout：不同屏幕尺寸下的排列、密度、显隐。

只有在交互语义确实不同的地方，才拆移动端专用组件。例如 Terminal Mobile Keybar 可以独立存在，因为它的职责是发送少量手机端快捷键；但它仍通过 `TerminalSurface` 复用终端连接与输入发送链路。

禁止的方向：

- 复制一份 `ViewerPage` 再删按钮。
- 复制一份 `TerminalWorkspace` 再删管理能力。
- 为移动端重写一套 session service 或 WebSocket 状态管理。
- 在多个分支里维护同一份 tab、navigation、collaboration 状态展示逻辑。

## 后端与协议演进

当前 v1 主要在前端完成，不强制改后端协议。

后续为了把观察模式从 UI 约定升级为协议约束，可以引入：

- Viewer WebSocket ticket 支持 `observe` / `control` 模式。
- observe 模式下，后端拒绝 input、tab、navigation、devtools 等变更消息。
- screencast 支持移动端画质参数，例如最大宽高、quality、帧率提示。
- browser profile 支持更完整的 mobile emulation 语义，例如 touch、device scale factor、mobile UA 策略。
- Terminal ticket 可携带 client capability，便于后端区分 monitor、limited input、full control。

这些增强不阻塞 v1，但应作为后续架构方向保留。

## 验收标准

移动端 Home：

- 首屏聚焦 session 查看和打开。
- 高级创建配置不占据主路径。
- 会话卡片只提供 Open。

移动端 Viewer：

- 看不到 Inspect / DevTools。
- 看不到 New tab / Close tab。
- 看不到 AI Assist。
- 看不到 Copy AI Bridge URL。
- 看不到完整地址栏导航。
- 看不到桌面 More actions 菜单。
- 不挂载桌面输入桥接 textarea。
- 点击或滑动画面不会向后端发送浏览器输入控制。
- 能看到实时画面、连接状态、加载状态和错误 / 重连状态。

桌面端 Viewer：

- 原有控制能力保持可见、可用。
- tab、navigation、DevTools、AI Assist 不受移动端改造影响。

移动端 Terminal：

- 首要目标是输出查看和状态确认。
- 管理类能力不进入移动端主路径。
- `Keys` 快捷键条只提供少量明确终端序列。
- 普通手机键盘输入可以进入 terminal，但 terminal 已退出、鉴权失败、运行时缺失时不应被自动重连掩盖。

桌面端 Terminal：

- 项目、会话、搜索、设置、关闭、新建等完整工作台能力保持可见、可用。

## 默认决策

- 移动端 Viewer v1 是严格观察模式。
- 移动端 Terminal v1 是轻量 monitor 加受限输入。
- 不通过 CSS-only 隐藏桌面功能。
- 不在 v1 提供浏览器操作接管。
- 不在 v1 强制改后端协议。
- 桌面端行为保持兼容。
