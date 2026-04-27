# Terminal Browser CDP Proxy + Playwright CLI Plan

## 结论

方案可行，但原计划中“给 Electron 打开全局 `remote-debugging-port`，再让 Playwright CLI / MCP 连接这个端口”的实现必须废弃。

致命问题是：Electron 的全局 remote debugging port 会暴露整个 Electron Chromium 实例。Playwright / MCP 连接后可以枚举主窗口 renderer、DevTools、Terminal Browser `WebContentsView` 等所有 target；AI 一旦选择或新建了错误 target，就可能把 Runweave 当前 Electron 主窗口整体替换掉，而不是只操作右侧 Browser 工具。

新的实现方向：

```text
Runweave terminal process
  -> playwright-cli / @playwright/mcp
  -> PLAYWRIGHT_MCP_CDP_ENDPOINT=http://127.0.0.1:<proxyPort>
  -> Electron main CDP Proxy
  -> terminal-browser tab whitelist
  -> WebContentsView.webContents.debugger
```

关键改变：

- 不使用 `app.commandLine.appendSwitch("remote-debugging-port", ...)`。
- 不暴露 Electron 原生 CDP endpoint。
- 只暴露自研 CDP Proxy endpoint。
- Proxy 的 Target discovery 只返回 Terminal Browser 允许 AI 操作的 tab。
- Proxy 的 WebSocket 只把 CDP 命令转发到对应 `WebContentsView.webContents.debugger`。
- 主窗口 renderer 对 AI 不存在，不能被 target selection 选中。

这个方案和 `docs/superpowers/plans/electron-ai-browser.md` 的核心思路一致：中间加一层 CDP 代理，把 Playwright MCP/CLI 当作普通 CDP 消费方，而不是让它直接连接 Electron 原始调试端口。

## 目标

让 Runweave 桌面端 Terminal Workspace 右侧的 Browser 工具提供一个本机 CDP-compatible endpoint，使从 Runweave terminal 启动的 Playwright CLI / MCP 可以操作同一个 Electron 内嵌 Browser 页面，并且操作范围限制在 Terminal Browser 的 `WebContentsView` 内。

这个能力服务的是 Terminal Browser sidecar，不是后端 viewer session，也不是 `/ws/ai-bridge`。

## 非目标

- 不重新引入 Electron 全局 `remote-debugging-port`。
- 不让 AI 直接连接 Electron 原始 CDP。
- 不新增 backend Playwright/browser automation API。
- 不让 Web/PWA 模式伪装支持本地 CDP。
- 不把 Browser tabs 改成 project-scoped。
- 不自动写 `~/.codex/config.toml`、`.playwright/cli.config.json` 或其他用户工具配置。
- 不把 CDP endpoint 持久化到项目存储。
- 不把 Terminal Browser CDP Proxy 当作远端协作能力暴露。
- 不新增前端 `src/**/*.test.ts(x)` 单测；前端交互使用 E2E 或桌面手工验证。

## 可行性判断

### 可行

当前代码已经满足方案的关键前提：

- Terminal Browser 由 `electron/src/terminal-browser-view.ts` 在主进程中管理。
- 每个 tab 对应一个 `WebContentsView`。
- `WebContentsView` 的页面内容和 Runweave 主窗口 renderer 是不同的 `webContents`。
- Electron 的 `webContents.debugger` 是 per-webContents API，可以 attach 到指定 `WebContentsView.webContents`，并用 `sendCommand(method, params, sessionId?)` 发送 CDP 命令。
- `webContents.debugger` 会通过 `message` 事件回传 CDP event，可以由 Proxy 包装后发给 Playwright CLI / MCP。

因此，用自研 HTTP + WebSocket CDP Proxy 模拟 Chrome DevTools Protocol 的入口，并把真实执行落到指定 `WebContentsView.webContents.debugger`，在架构上可行。

### 风险

Playwright CLI / `@playwright/mcp` 不是只发 `Page.navigate`、`Input.dispatchMouseEvent` 这类 page-level 命令。它连接 CDP endpoint 时通常还会使用 browser/target/session 相关命令，例如：

- `/json/version`
- `Browser.getVersion`
- `Target.getTargets`
- `Target.setDiscoverTargets`
- `Target.setAutoAttach`
- `Target.attachToTarget`
- `Target.activateTarget`
- `Target.createTarget`
- 带 `sessionId` 的 page/runtime/input/network 命令

所以 Proxy 不能只是把 WebSocket 消息原样转发给 `webContents.debugger`。它必须实现一层 target/session 仿真：

- browser-level 命令由 Proxy 自己回答。
- target discovery 只返回 Terminal Browser 白名单 tab。
- attach 后生成 Proxy 自己的 `sessionId`。
- 带 `sessionId` 的命令根据映射转发到对应 `webContents.debugger`。
- 从 Electron debugger 收到的事件再补回对应 `sessionId` 给 Playwright。

### 需要验证的假设

实现前必须先做一个最小兼容性 spike。这个 spike 是整个方案的生死线，必须使用真实 Playwright CDP client 打通 browser-level endpoint，不实现 `/json/list` 或 page-level WebSocket。

1. 用 Proxy 暴露 `/json/version`，其中 `webSocketDebuggerUrl` 指向 `ws://127.0.0.1:<port>/devtools/browser/<id>`。
2. Playwright 通过 `chromium.connectOverCDP("http://127.0.0.1:<port>")` 连接 Proxy。
3. browser-level WebSocket 支持 `Browser.getVersion`、`Target.setDiscoverTargets`、`Target.setAutoAttach`、`Target.getTargets`、`Target.attachToTarget`。
4. Proxy 支持 Playwright 的 flat session 模式：Target attach 后用 `sessionId` 多路复用 page/runtime/input/network 命令。
5. 确认 Playwright 看到的 page 只有 Terminal Browser 白名单 tab。
6. 确认连接过程需要的完整 CDP method 清单。

只有这个 spike 通过后，才进入完整 UI/IPC/文档实现。

## 用户工作流

1. 用户打开 Runweave 桌面端。
2. 在 Terminal Workspace 的 Preview 菜单里打开 `Browser`。
3. 在 Browser tab 里访问本地页面，例如 `http://127.0.0.1:5173`。
4. 打开 Browser 工具栏里的 CDP/AI 面板。
5. 面板展示 Proxy endpoint，例如 `http://127.0.0.1:9224`。
6. 用户在 Runweave terminal 里启动 `playwright-cli`、Playwright MCP 或 Codex wrapper。
7. 这些进程从 Runweave terminal 的 PTY 继承 `PLAYWRIGHT_MCP_CDP_ENDPOINT`。
8. 外部工具连接的是 Runweave CDP Proxy，不是 Electron 原始 CDP。
9. AI 的点击、输入、截图、导航只作用于 Terminal Browser 当前允许的 tab。

## 核心链路

```text
Electron app ready
  -> register Terminal Browser IPC handlers
  -> start Terminal Browser CDP Proxy on 127.0.0.1:<port>
  -> set PLAYWRIGHT_MCP_CDP_ENDPOINT=http://127.0.0.1:<port>
  -> start packaged backend with inherited env
  -> backend terminal PTY inherits PLAYWRIGHT_MCP_CDP_ENDPOINT
  -> terminal process launches playwright-cli / MCP
  -> chromium.connectOverCDP("http://127.0.0.1:<port>")
  -> tool requests /json/version from Proxy
  -> tool connects ws://127.0.0.1:<port>/devtools/browser/<id>
  -> tool sends Target.setAutoAttach / Target.getTargets / Target.attachToTarget
  -> Proxy only returns Terminal Browser whitelist targets
  -> Proxy maps flat sessionId to WebContentsView.webContents.debugger
  -> Proxy forwards page/runtime/input/network commands for that session
```

关键点：

- CDP Proxy 可以在 `app.whenReady()` 后启动，因为它不是 Chromium 全局 remote debugging switch。
- 端口探测不需要发生在 Electron ready 前。
- packaged main 入口不需要因为这个能力改成 bootstrap。
- backend 只负责把 env 传给 terminal PTY，不参与 CDP 转发。

## 端口策略

默认策略：

- host: `127.0.0.1`
- start port: `9224`
- endpoint: `http://127.0.0.1:<port>`
- exported env: `PLAYWRIGHT_MCP_CDP_ENDPOINT`
- configured port env: `BROWSER_VIEWER_TERMINAL_BROWSER_CDP_PROXY_PORT`

端口选择规则：

- 未显式配置时，从 `9224` 开始探测，端口不可用则递增。
- 显式传入 `BROWSER_VIEWER_TERMINAL_BROWSER_CDP_PROXY_PORT` 时，只校验该端口，不自动漂移到下一个端口。
- 端口只监听 `127.0.0.1`。

## CDP Proxy 设计

### HTTP 端点

Proxy 暴露 Playwright `connectOverCDP` 所需的最小 discovery 端点：

```text
GET /json/version
GET /json/protocol
```

`/json/version` 是 Playwright CDP attach 的主入口，必须返回 browser-level websocket：

```json
{
  "Browser": "Runweave/CDP-Proxy",
  "Protocol-Version": "1.3",
  "webSocketDebuggerUrl": "ws://127.0.0.1:9224/devtools/browser/runweave-terminal-browser"
}
```

`/json`、`/json/list` 和 page-level `webSocketDebuggerUrl` 不进入当前范围。它们不是 Playwright CLI / MCP 主路径，且会扩大 target 白名单泄露面。将来如果外部工具明确需要，再单独评估和设计。

通过 `Target.getTargets`、`Target.setDiscoverTargets` 等 browser-level CDP 命令也不返回：

- Runweave 主窗口 renderer。
- DevTools target。
- backend viewer session。
- 其他 Electron webContents。
- 已关闭或未授权的 Terminal Browser tab。

### WebSocket 端点

```text
WS /devtools/browser/:browserId
```

`/devtools/browser/:browserId` 是必选主路径。Playwright CLI / MCP 会在这个 browser-level WebSocket 上跑完整 Target 流程，并通过 flat `sessionId` 多路复用后续 page 命令。

`/devtools/page/:targetId` 不进入当前范围，Phase 0 和 Phase 1 都不实现。这样可以收窄 spike 工作量，并减少额外 WebSocket target 暴露面。

### Target/session 仿真

Proxy 内部维护：

```text
targetId -> TerminalBrowserEntry
proxySessionId -> targetId
proxySessionId -> electronSessionId | null
electronSessionId -> proxySessionId
debuggerAttachment -> webContents.debugger
```

命令处理原则：

- `Browser.*`：只允许只读命令，例如 `Browser.getVersion`。
- `Target.getTargets`：只返回允许的 Terminal Browser target。
- `Target.setDiscoverTargets`：由 Proxy 自己回答 `{}`，不透传给 Electron debugger，也不能 block；开启 discovery 时只向当前 browser-level WebSocket 推送 Terminal Browser whitelist 内的 `Target.targetCreated` / `Target.targetInfoChanged` / `Target.targetDestroyed`。
- `Target.setAutoAttach`：由 Proxy 自己实现，不能透传也不能 block；Playwright 通常会发送 `{ autoAttach: true, waitForDebuggerOnStart: true, flatten: true }`，Proxy 必须对 Terminal Browser whitelist page 合成 `Target.attachedToTarget` 事件，事件里使用 Proxy 自己生成的外侧 `sessionId`。
- `Target.attachedToTarget` 的 `waitingForDebugger` 字段必须按 `Target.setAutoAttach.waitForDebuggerOnStart` 的真实语义处理。不能简单“立刻合成 attachedToTarget”后忽略等待调试器状态，否则 Playwright 可能继续等待 `Runtime.runIfWaitingForDebugger` 并最终超时。
- `Runtime.runIfWaitingForDebugger` 必须显式处理：根据 Phase 0 spike 结果选择转译为 `debugger.sendCommand(...)` 或 no-op 返回 `{}`；不能默认丢弃或让请求悬挂。
- `Target.attachToTarget`：为允许的 target 创建 Proxy session。
- `Target.activateTarget`：切换 Terminal Browser active tab。
- `Target.createTarget`：Phase 1 必须实现。Playwright `browser.newPage()` 和 MCP 默认行为会依赖它。Proxy 创建新的 Terminal Browser tab 时必须强制 `aiAllowed=true`，并受最大 AI tab 数限制，建议默认 10 个；超限返回 CDP error，不能创建或导航 Runweave 主窗口。
- `Target.closeTarget`：只允许关闭由 Terminal Browser 管理的 tab；不能关闭主窗口。
- 带 `sessionId` 的 page/runtime/input/network 命令：根据 session 映射转发给对应 `webContents.debugger`。
- 未带 `sessionId` 的 page-level 命令：只允许在 WebSocket 本身绑定了单个 target 时转发。

### 双 session 域

必须明确区分两套 `sessionId`：

```text
Proxy <-> Playwright:
  proxySessionId 由 CDP Proxy 生成并返回给 Playwright

Proxy <-> Electron debugger:
  electronSessionId 来自 webContents.debugger 的 Target.attachedToTarget 事件
```

`webContents.debugger.sendCommand(method, params, sessionId?)` 的第三个参数不是 Playwright 发来的 `sessionId`。它属于 Electron debugger 内部 CDP session，例如 iframe、worker、OOPIF 等子 target attach 后产生的 session。

Proxy 内部至少维护：

```text
targetId -> TerminalBrowserEntry
proxySessionId -> targetId
proxySessionId -> electronSessionId | null
electronSessionId -> proxySessionId
webSocketConnection -> autoAttach/discovery state
debuggerAttachment -> webContents.debugger
```

转发规则：

- 对 Playwright 收到的 `Target.attachedToTarget`，事件里的 `sessionId` 必须是 `proxySessionId`。
- 对 Playwright 带 `sessionId: proxySessionId` 发来的 page/runtime/input/network 命令，Proxy 必须先查表，再转成 `debugger.sendCommand(method, params, electronSessionId?)`。
- 如果当前目标是 root page 且还没有 Electron 内侧 `electronSessionId`，最小 spike 可以暂时不传第三个参数；生产实现不能把这个简化当作通用模型。
- Electron debugger 收到带 `electronSessionId` 的事件后，Proxy 必须反查 `proxySessionId`，再把事件包装成 Playwright flat-session 事件返回。
- Playwright 的 `proxySessionId` 不能原样传给 `webContents.debugger.sendCommand`。

### 命令过滤

永久阻断：

```text
Browser.close
Browser.crash
Target.setRemoteLocations
SystemInfo.getProcessInfo
Security.setIgnoreCertificateErrors
Network.clearBrowserCookies
Network.clearBrowserCache
Storage.clearDataForOrigin
```

参数过滤：

- `Page.navigate` 只允许 `http:` 和 `https:`。
- `Page.setContent` 不允许 `file:`、`chrome:`、`devtools:`、`javascript:` 跳转。
- `Input.dispatchKeyEvent` 过滤关闭窗口/退出应用类快捷键。
- `Runtime.evaluate` 和 `Runtime.callFunctionOn` 不是安全边界，不能依赖字符串黑名单当沙箱；只把它们限定在目标 page 的 renderer 内，并记录轻量审计事件。

Runtime 审计日志口径：

- 默认只走 Electron main 的 `console.info`，记录 method、targetId、proxySessionId、URL、表达式长度和时间戳。
- 可选接入现有 `packages/shared/src/diagnostic-logs.ts` 体系，但默认不落盘。
- 默认不记录完整 `expression` / `functionDeclaration`，因为页面脚本里可能包含 secret、token 或用户输入。
- 如果未来要落盘保存 Runtime 表达式，Phase 5 必须同步补充隐私说明、脱敏规则和关闭开关。

注意：此 Proxy 的安全目标是“限制到 Terminal Browser WebContentsView”，不是“让任意网页 JS 执行变成可信”。AI 仍然可以读取和操作当前页面内容。

### DevTools 互斥

Electron 的 `webContents.debugger.attach()` 和同一个 `webContents` 的 DevTools 是硬性互斥关系，不是普通 UI 冲突。

实际约束：

- 同一个 `webContents` 已被 Proxy attach debugger 后，再调用 `openDevTools()` 可能抛出 `Another debugger is already attached`，也可能导致当前 debugger session 被强制 detach。
- 用户已经通过 `terminal-browser:open-devtools` 打开 DevTools 后，Proxy 再 attach 同一个 `WebContentsView.webContents.debugger` 会失败。
- 当前代码已经有 `electron/src/terminal-browser-view.ts` 里的 `terminal-browser:open-devtools` IPC，因此互斥必须落在现有按钮和 IPC 路径上，不能只靠 toast 或文案提醒。

因此：

- 同一个 Terminal Browser tab 上，CDP Proxy attach 和 `Open browser DevTools` 不允许并发。
- Proxy attach 期间，前端必须直接禁用当前 tab 的 DevTools 按钮，不能只弹 toast。
- `terminal-browser:open-devtools` IPC 也要做主进程兜底：如果该 tab 正在被 CDP Proxy attach，直接拒绝打开 DevTools 并返回明确错误。
- 如果用户已经打开 DevTools，Proxy attach 必须失败并返回明确错误，例如 `DevTools is already open for this browser tab`。
- 如果用户绕过 UI 打开 DevTools 导致 debugger detach，Proxy 必须感知 `debugger.detach`，关闭对应 CDP WebSocket session，并把状态同步回 UI。
- UI 需要同时覆盖两个方向：`Proxy active -> DevTools disabled`，以及 `DevTools open -> CDP attach unavailable`。

## IPC 和 UI

IPC 合同由 `@browser-viewer/shared` 统一定义，避免 Electron main、preload、frontend 平行复制类型。

`TerminalBrowserCdpProxyInfo` 核心字段：

```ts
interface TerminalBrowserCdpProxyInfo {
  available: boolean;
  endpoint: string | null;
  port: number | null;
  host: "127.0.0.1";
  tabId: string;
  targetId: string | null;
  url: string;
  title: string;
  attached: boolean;
  devtoolsOpen: boolean;
  env: { PLAYWRIGHT_MCP_CDP_ENDPOINT: string } | null;
  error?: string;
}
```

UI 行为：

- Electron 桌面端显示 CDP/AI endpoint 按钮。
- 非 Electron 环境禁用或隐藏该按钮。
- 打开面板时通过 `terminalBrowserGetCdpProxyInfo(tabId)` 读取当前 tab 的 Proxy 信息。
- 有 endpoint 时展示并允许复制。
- 无 endpoint 时展示简短错误。
- 当前 tab `attached: true` 时，DevTools 按钮必须 disabled，并通过 tooltip/aria-label 说明正在被 CDP Proxy 控制。
- 当前 tab `devtoolsOpen: true` 时，CDP/AI 面板必须展示不可 attach 状态，不能给出可用 endpoint。
- UI 文案必须说明这是 Proxy endpoint，不是 Electron 原始 CDP endpoint。
- UI 不展示复杂 MCP 配置教程；Playwright CLI / MCP / Codex wrapper 如何消费该 endpoint，由 terminal 里的工具链决定。

## 当前代码路径

需要保留并扩展：

- `electron/src/terminal-browser-view.ts`
  - 继续作为 Terminal Browser tab 和 `WebContentsView` 生命周期的唯一入口。
  - 给 Proxy 提供只读查询方法：按 `windowId + tabId` 获取 entry、URL、title、active 状态。
  - 提供受控动作：activate tab、create Terminal Browser tab、close Terminal Browser tab。

- `electron/src/preload.ts`
  - 暴露 `terminalBrowserGetCdpProxyInfo(tabId)`。

- `frontend/src/components/terminal/terminal-browser-tool.tsx`
  - 增加 endpoint 按钮、hover/popover 面板和复制能力。
  - DevTools 按钮需要处理 debugger attach 互斥状态：Proxy attach 期间直接 disabled；DevTools 已开时 CDP/AI endpoint 显示不可用。

新增：

- `electron/src/terminal-browser-cdp-proxy.ts`
  - HTTP discovery 端点。
  - WebSocket CDP dispatcher。
  - target/session 映射。
  - 命令过滤。
  - debugger attach/detach 生命周期。

- `electron/src/terminal-browser-cdp-proxy-port.ts`
  - 解析/探测 `BROWSER_VIEWER_TERMINAL_BROWSER_CDP_PROXY_PORT`。
  - 只监听 `127.0.0.1`。

- `packages/shared/src/terminal-browser-cdp-proxy.ts`
  - IPC 类型定义。

- `electron/src/terminal-browser-cdp-proxy.test.ts`
  - Electron 主进程侧单元测试，覆盖 target filtering、blocked commands、session 映射和端口策略。

如果需要 `ws`：

- `backend` 已经使用 `ws`，但 `electron/package.json` 当前没有直接依赖。
- Electron 侧新增 WebSocket server 时，应给 `@browser-viewer/electron` 显式添加 `ws` 运行依赖和类型依赖，不要依赖后端 package 的传递依赖。

必须删除或避免恢复：

- `electron/src/main-bootstrap.ts`
- `electron/src/terminal-browser-cdp-port.ts`
- 在 Electron ready 前 append `remote-debugging-port` 的逻辑。
- 将 `PLAYWRIGHT_MCP_CDP_ENDPOINT` 指向 Electron 原始 CDP 的逻辑。

## 实施步骤

### Phase 0: 兼容性 spike

目标：验证 Playwright CLI / MCP 能通过 browser-level endpoint 连接 Proxy，并确认完整 CDP method 集合。这个阶段不实现 `/json/list` 或 `/devtools/page/:targetId`。

实现一个临时/最小 Proxy：

- `/json/version`
- `/devtools/browser/:browserId`
- `Browser.getVersion`
- `Target.setDiscoverTargets`
- `Target.setAutoAttach`
- `Target.getTargets`
- `Target.attachToTarget`
- `Target.createTarget`
- synthesize `Target.attachedToTarget` with Proxy-generated `sessionId`
- correct `Target.attachedToTarget.waitingForDebugger` semantics
- `Runtime.runIfWaitingForDebugger`
- flat `sessionId` 命令分发
- Proxy sessionId ↔ Electron debugger sessionId 映射表
- page-level `Page.navigate`、`Runtime.evaluate`、`Page.captureScreenshot`

验证：

```bash
pnpm --filter electron typecheck
pnpm dev:electron
```

桌面手工验证：

1. 打开 Terminal Browser tab。
2. 用真实 Playwright CDP client 连接 Proxy，而不是手写静态 HTTP 探测：

```ts
import { chromium } from "playwright";

const browser = await chromium.connectOverCDP("http://127.0.0.1:<proxyPort>");
const contexts = browser.contexts();
const pages = contexts.flatMap((context) => context.pages());
console.log(pages.map((page) => page.url()));
```

3. 确认 Proxy 日志里入口顺序是 `/json/version` -> `/devtools/browser/:browserId` -> `Target.setAutoAttach` / `Target.getTargets` / `Target.attachToTarget`。
4. 确认 Playwright 看到的 page 只有 Terminal Browser tab。
5. 确认 `Target.setAutoAttach` 后 Proxy 合成了 `Target.attachedToTarget`，并且事件里的 `sessionId` 是 Proxy 外侧 session，不是 Electron debugger 内侧 session。
6. 确认 `Target.attachedToTarget.waitingForDebugger` 与 Playwright 发送的 `waitForDebuggerOnStart` 语义匹配。
7. 确认如果 Playwright 随后发送 `Runtime.runIfWaitingForDebugger`，Proxy 会返回结果，不会丢弃、悬挂或导致 connect 超时。
8. 用 Playwright 导航该 page。
9. 确认 Runweave 主窗口没有被导航、刷新或替换。

如果 spike 发现 `@playwright/mcp` 必须依赖额外 Target 命令，把命令清单补进 Phase 1，不要猜。

### Phase 1: 正式 CDP Proxy

实现 `terminal-browser-cdp-proxy.ts`：

- 启动/停止本机 HTTP server。
- 绑定 `127.0.0.1`。
- 支持端口探测。
- 支持 `/json/version`、`/json/protocol`。
- 支持 browser-level `/devtools/browser/:browserId` WebSocket CDP dispatcher。
- 支持 target/session 映射。
- 支持 `Target.setDiscoverTargets` / `Target.setAutoAttach` 的受控仿真。
- 支持 `Target.createTarget` 创建新的 Terminal Browser AI tab，强制 `aiAllowed=true`，并执行最大 tab 数限制。
- 支持 `Runtime.runIfWaitingForDebugger`，并通过 spike 确定 no-op 还是转发到 Electron debugger。
- 支持 Playwright flat session mode。
- 支持 Proxy sessionId 和 Electron debugger sessionId 的双向翻译。
- 只允许访问 Terminal Browser whitelist target。
- attach 前检测同 tab DevTools 是否已打开；DevTools 已打开时拒绝 attach。
- 实现 blocker 和参数校验。
- 处理 `debugger.detach`、WebSocket close、tab close、window close 的清理。

验证：

```bash
pnpm --filter electron test -- terminal-browser-cdp-proxy
pnpm --filter electron typecheck
```

### Phase 2: Terminal Browser 集成

扩展 `terminal-browser-view.ts`：

- 为每个 Terminal Browser entry 提供稳定 `targetId`。
- 提供 `getTerminalBrowserCdpTargets()` 之类的只读查询。
- 提供 `activateTerminalBrowserTab()` 给 `Target.activateTarget` 使用。
- 在 tab/window close 时通知 Proxy 清理 session。
- 扩展现有 `terminal-browser:open-devtools` IPC：当 tab 正在被 Proxy attach 时，主进程直接拒绝打开 DevTools。
- 暴露 tab 级状态：`cdpProxyAttached`、`devtoolsOpen`，供 UI 禁用按钮和显示不可 attach 状态。
- 在 active tab 切换时保证 bounds/visibility 仍由现有 UI 驱动，不让 Proxy 绕过布局。

验证：

```bash
pnpm --filter electron test -- terminal-browser
pnpm --filter electron typecheck
```

### Phase 3: Env 传播

启动时注入：

```bash
PLAYWRIGHT_MCP_CDP_ENDPOINT=http://127.0.0.1:<proxyPort>
```

传播链路：

```text
Electron main
  -> process.env
  -> packaged backend env
  -> backend process.env
  -> terminal PTY env
  -> command launched inside Runweave terminal
```

注意事项：

- 只保证从 Runweave terminal 新启动的进程能读取这个 env。
- 已经在其他系统 terminal 或外部 Codex 进程里运行的工具不会被动态注入。
- `PLAYWRIGHT_MCP_CDP_ENDPOINT` 指向 Runweave CDP Proxy，不指向 Electron 原始 CDP。
- 不为了这个功能覆盖用户全局 MCP/CLI 配置。

验证：

```bash
pnpm --filter electron test -- terminal-browser-cdp-proxy
pnpm typecheck
```

桌面手工验证：

```bash
echo "$PLAYWRIGHT_MCP_CDP_ENDPOINT"
```

### Phase 4: UI

更新 `terminal-browser-tool.tsx`：

- 增加 Proxy endpoint 按钮。
- hover/click 面板显示 endpoint、当前 tab URL/title、复制按钮。
- endpoint 不可用时显示短错误。
- DevTools 与 AI/CDP attach 互斥时给出明确状态。

不新增前端单测。

验证：

```bash
pnpm --filter frontend e2e -- terminal
pnpm typecheck
```

### Phase 5: 文档

更新：

- `docs/architecture/network-topology.md`
  - 增加 Electron Terminal Browser CDP Proxy 作为独立本机链路。
  - 明确它不同于 backend viewer session 的 `/ws/ai-bridge`。

- `docs/architecture/default-ai-viewer-workflow.md`
  - 明确 default AI viewer / ai-bridge 仍属于 backend viewer session。
  - Terminal Browser CDP Proxy 不复用 `/ws/ai-bridge` 生命周期。

如果 Runtime 审计日志未来落盘：

- 文档必须说明可能涉及页面 secret/token。
- 文档必须定义脱敏规则、保留期限和关闭开关。
- 当前计划默认不落盘，避免把 `Runtime.evaluate` 表达式写入本地文件。

## 验证

核心自动化：

```bash
pnpm --filter electron test -- terminal-browser-cdp-proxy
pnpm --filter electron test -- terminal-browser
pnpm --filter electron typecheck
pnpm typecheck
```

桌面手工验证：

1. 启动 `pnpm dev:electron`。
2. 打开 Terminal Workspace 右侧 Browser。
3. 访问一个本地页面，例如 `http://127.0.0.1:5173`。
4. 打开 CDP/AI 面板，确认展示 `http://127.0.0.1:<proxyPort>`。
5. 在 Runweave terminal 中确认：

```bash
echo "$PLAYWRIGHT_MCP_CDP_ENDPOINT"
```

6. 用 `chromium.connectOverCDP("http://127.0.0.1:<proxyPort>")` 连接该 endpoint。
7. 确认连接使用的是 `/json/version` 返回的 `/devtools/browser/:browserId`。
8. 确认 target/page 列表中没有 Runweave 主窗口 renderer。
9. 对 page 执行导航、点击、输入、截图。
10. 确认变化只发生在右侧 Browser 工具内。
11. 确认 Runweave 主窗口没有被替换、刷新或跳转。
12. 打开/关闭 Browser tab 后，确认 Proxy target list 同步变化。
13. 验证 `Proxy active -> DevTools disabled`：AI/CDP attach 当前 tab 后，前端 DevTools 按钮 disabled，主进程 `terminal-browser:open-devtools` IPC 也拒绝打开。
14. 验证 `DevTools open -> Proxy attach rejected`：先打开当前 tab DevTools，再用 `chromium.connectOverCDP(...)` attach，确认 Proxy 返回明确错误且不会残留 session。

回归关注点：

- 不出现任何 Electron 全局 `remote-debugging-port`。
- Proxy 只监听 `127.0.0.1`。
- `PLAYWRIGHT_MCP_CDP_ENDPOINT` 指向 Proxy endpoint。
- 主窗口 renderer 不会出现在 `Target.getTargets` 或 discovery 事件中。
- `/json/version` 返回 browser-level `webSocketDebuggerUrl`。
- `Target.setDiscoverTargets` 自答 `{}`，不透传、不 block。
- `Target.setAutoAttach` 受控仿真，并合成带 Proxy `sessionId` 的 `Target.attachedToTarget`。
- `Target.attachedToTarget.waitingForDebugger` 不会让 Playwright 等待到超时。
- `Runtime.runIfWaitingForDebugger` 有显式返回路径。
- Playwright 外侧 `sessionId` 和 Electron debugger 内侧 `sessionId` 不混用。
- `Target.createTarget` 必须创建 Terminal Browser AI tab，强制 `aiAllowed=true`，超过最大 tab 数时返回 CDP error，不能创建或导航 Runweave 主窗口。
- Runtime 审计日志默认不落盘，不记录完整 expression/functionDeclaration。
- `Browser.close`、`Browser.crash`、全局 cookie/cache 清理类命令被拒绝。
- `webContents.debugger.attach()` 与同 tab `openDevTools()` 按硬性互斥处理，UI 和主进程 IPC 都不能只做软提示。
- backend viewer session、AI bridge、Terminal Browser CDP Proxy 三者不共享生命周期。

## 后续可选项

这些不是当前实现的一部分：

- 为 Playwright CLI / MCP 提供更明确的 wrapper。
- 在文档中给 Codex MCP wrapper 示例，但不要写入 Browser UI。
- 做完整桌面端 E2E，覆盖 endpoint 面板、env 继承和真实 CDP attach。
- 增加按 tab 的 “Allow AI control” 开关，而不是默认允许所有 Terminal Browser tab。
- 如果将来有外部工具明确需要，再单独评估 `/json/list` 和 `/devtools/page/:targetId` 兼容端点。
