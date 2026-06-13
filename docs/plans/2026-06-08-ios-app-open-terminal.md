# iOS App 打开远程终端一期实施计划

> **给 agent 执行者：**先阅读本计划的“代码事实”和“复用结论”，再实施。前端 `app/src/` 下不新增单测；验证以类型检查、构建、后端既有测试和手工回归为主。

**目标：**在 iOS App 中实现“打开一个终端”的详情页，页面由头部信息、实时终端内容区和底部固定输入框三部分组成；终端渲染复用同一个纯 renderer，WebSocket 建联与输入发送使用同一套后端协议，但不进入 renderer。

**架构：**后端不重写终端能力，继续使用现有 `/api/terminal/session/:id/ws-ticket`、`/ws/terminal`、`/api/terminal/session/:id/input`、`GET /api/terminal/session/:id`。前端只抽出可被 `frontend/` 与 `app/` 同时消费的纯终端 renderer；Web/App 各自实现 connection adapter 和页面壳，App 只实现 Ionic 手机壳和底部 composer，不直接复用 Web 桌面 `TerminalWorkspace`。

**草图：**`docs/plans/assets/2026-06-08-ios-app-terminal-open-image2.png`

---

## 当前代码事实

- `app/` 当前是独立 Ionic React + Capacitor 应用，`app/package.json` 已依赖 `@runweave/shared`，但还没有 xterm 和共享终端 core 依赖。
- `app/src/App.tsx` 已经不是 Hello 占位页：它有登录/刷新 token/校验 session/加载首页 overview 的状态机，登录后渲染 `HomePage`，未登录渲染 `LoginPage`。
- `app/src/services/terminal.ts` 已经通过 `GET /api/terminal/mobile/overview?includeTail=false` 读取 `TerminalMobileOverviewResponse`，首页不再需要新增 overview 接线。
- `app/src/pages/HomePage.tsx` 已基于 `TerminalMobileOverviewResponse` 渲染项目与终端列表，组件链路是 `HomePage -> ProjectGroup -> TerminalRow`；当前缺口是终端 row 还没有打开详情页的 navigation 回调。
- `packages/shared/src/terminal-protocol.ts` 当前的 `TerminalSessionListItem` 已包含 `lastActivityAt`，`TerminalMobileOverviewSession` 已包含 `title`、`subtitle`、`displayStatus`、`displayStatusLabel`；App 详情页 header 可以优先复用首页选中的 session 作为初始展示数据。
- `frontend/src/components/terminal/terminal-workspace.tsx` 是 Web 桌面终端 workspace，包含项目、session tab、Preview、History、连接切换、completion marker 等桌面壳状态，不适合作为 App 详情页直接复用对象。
- 真正可复用的 Web 终端核心集中在：
  - `frontend/src/features/terminal/use-terminal-connection.ts`：通过 `createTerminalWsTicket()` 换取临时 ticket，连接 `/ws/terminal`，处理 snapshot/output/metadata/status/exit/error，暴露 `sendInput()`、`sendResize()`、`sendSignal()`。
  - `frontend/src/components/terminal/terminal-surface.tsx`：把 `useTerminalConnection` 接入 xterm，处理 snapshot、增量输出、IME 去重、后台输出缓存和 metadata 回调。
  - `frontend/src/components/terminal/use-terminal-emulator.ts`：初始化 xterm、Fit/Search/Unicode/WebLinks/Canvas/WebGL addon，处理 resize、粘贴、移动端快捷键、wheel 与 tmux scroll。
  - `frontend/src/services/terminal.ts`：已有 `getTerminalSession()`、`sendTerminalInput()`、`createTerminalWsTicket()` 等 HTTP service。
- 后端已有 App 打开终端需要的核心能力：
  - `GET /api/terminal/session/:id` 返回单个终端状态和 scrollback。
  - `POST /api/terminal/session/:id/ws-ticket` 颁发 `terminal-ws` 临时 ticket。
  - `/ws/terminal` 校验 ticket 后发送 `connected`、`snapshot`、`output`、`metadata`、`status`、`exit`。
  - `POST /api/terminal/session/:id/input` 接收 `{ data, operationId? }`，对 tmux session 走 `tmuxService.sendInput()`，否则写入 PTY runtime。
- Web 前端已经有 `frontend/src/features/terminal/mobile/MobileTerminalPage.tsx`，但它是移动端终端概览/tail 预览，不是 App 内的实时终端详情页。它点击“打开终端”会跳到 Web `/terminal/:id`。
- `packages/shared/src/terminal-protocol.ts` 已定义 `TerminalClientMessage`、`TerminalServerMessage`、`SendTerminalInputRequest`、`TerminalSessionStatusResponse` 等协议类型，适合作为 App 与共享终端核心的类型来源。

## 复用结论

代码级复用可行，但本期只复用“纯终端渲染器”，不要把 WebSocket、HTTP service、clipboard、search、link provider 或 Web 桌面 workspace 抽进共享 emulator。

推荐路径：

1. 把 Web 当前 xterm 初始化、snapshot/output 写入、resize 计算、基础输入捕获抽到一个无网络依赖的 workspace package，例如 `packages/terminal-renderer`。
2. `packages/terminal-renderer` 只提供纯渲染能力：调用方传入 `snapshot/output` 字符串，renderer 通过回调抛出 `onInput(data)`、`onResize(cols, rows)`、`onBell()`；Web 需要的 search/link/paste/tmux wheel 等扩展通过 `onTerminalReady()` 拿到 xterm 实例后在 adapter 注册。
3. Web 端保留现有 `useTerminalConnection`、Preview、History、Search toolbar、browser link 行为，只把收到的 terminal output 喂给共享 renderer。
4. App 端保留现有登录和 overview 流程，新增 App 专用 terminal connection adapter 接入当前后端 `/ws/terminal`；中间终端区只使用共享 renderer，头部和底部 composer 使用 Ionic/普通 CSS。

明确分层：

| 层          | 文件/模块                                                  | 允许依赖                                                                                     | 禁止依赖                                                                                                                                     |
| ----------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 纯渲染层    | `packages/terminal-renderer`                               | React、`@xterm/xterm`、`@xterm/addon-fit`、`@xterm/addon-unicode11`、可选 Canvas/WebGL addon | WebSocket、HTTP、`@runweave/shared` 协议、`frontend/src/features/*`、`frontend/src/services/*`、Preview store、Electron API、Tailwind、Ionic |
| Web adapter | `frontend/src/components/terminal/terminal-surface.tsx` 等 | 现有 Web service、`useTerminalConnection`、Preview store、search/link/paste 相关能力         | 被 App 直接 import                                                                                                                           |
| App adapter | `app/src/pages/AppTerminalPage.tsx` 和 App 内 hook/service | App auth token、`@runweave/shared` 协议类型、后端 terminal ws ticket/API                     | `frontend/src/*`、Web Preview、Web link provider、clipboard image API                                                                        |

样式边界：

- 共享 package 不导出带 Tailwind class 的页面组件，不依赖 shadcn/Radix/next-themes，也不要求 App 安装 Tailwind。
- 共享 package 只允许提供 xterm 运行必需的 CSS 文件、容器 ref 绑定、resize 逻辑和可配置 theme tokens，例如 background、foreground、cursor、fontFamily、fontSize。CSS 由调用方全局入口显式 import，renderer 组件 TSX 不做隐式 CSS import。
- Web 和 App 各自实现自己的 wrapper：Web wrapper 继续用 Tailwind；App wrapper 使用 Ionic 组件和 `app/src/main.css`。
- 如果某段 UI 需要 className，必须通过调用方传入 `className` 或 style props，不在共享核心里写 Web 专属 class。

备选方案：App 接入 Tailwind。

- 技术上可行。`app/` 是 Vite React 应用，可以新增 `tailwindcss`、`postcss`、`autoprefixer`、`app/tailwind.config.ts`、`app/postcss.config.cjs`，并在 `app/src/main.css` 中引入 Tailwind utilities。
- 为降低 Ionic 冲突，App Tailwind 配置应优先关闭 preflight：`corePlugins: { preflight: false }`。否则 Tailwind base reset 可能影响 Ionic 的按钮、输入框、字体和滚动基础样式。
- App Tailwind content 必须覆盖 `./src/**/*.{ts,tsx}`，如果未来共享 package 内存在 Tailwind class，还要覆盖对应 package 路径。按本计划，`packages/terminal-renderer` 不写 Tailwind class。
- 即使 App 支持 Tailwind，也不代表可以直接复用 `frontend/src/components/terminal/terminal-workspace.tsx`。Tailwind 只解决样式编译，不解决 Web 组件依赖的 Preview store、Electron API、next-themes、Radix/shadcn 和桌面 workspace 状态。
- 只有当一期明确要复用 Web terminal surface 的 Tailwind 布局片段，而不是只复用核心行为时，才采用此方案。否则优先保持 App 无 Tailwind，用 Ionic/CSS 实现手机壳，降低 App 样式栈复杂度。

不推荐路径：

- 不建议 `app/` 直接从 `frontend/src/...` import。原因是 `app/tsconfig.json` 只 include `app/src` 与 `capacitor.config.ts`，`frontend/src` 又依赖 Tailwind、shadcn/Radix、next-themes、Electron bridge、Preview store 等 Web 上下文，直接跨包 import 会把不必要依赖和样式体系拖进 App。
- 不建议复制整份 `TerminalWorkspace`。它会把桌面 tab、Preview、History、连接切换等一期不需要的复杂状态带进 App，后续维护成本高。
- 不建议在 App 里重写 xterm renderer。App 需要的 WebSocket 逻辑只做薄 adapter：复用后端协议和 `@runweave/shared` 消息类型，把 snapshot/output 转发给 renderer。

## 一期用户可见行为

- 用户从当前 App 首页的某个 `TerminalRow` 点击进入终端详情页。
- 顶部固定区域显示返回按钮、终端标题、cwd 短路径、连接状态、最近活动时间和刷新/更多按钮。
- 中间是实时终端内容区：打开时请求 terminal ws ticket，连接 `/ws/terminal`，先渲染 snapshot，再持续渲染 output。
- 底部固定输入框用于发送命令：用户输入一段文本，点击发送时向当前终端发送 `text + "\n"`；输入框清空。
- 底部保留少量快捷键入口：`Ctrl-C`、`Tab`、`Esc`、方向上/下。快捷键直接通过共享 `sendInput()` 发送控制序列。
- WebSocket 未连接时输入可以复用现有 pending input 队列；连接恢复后自动 flush。
- 登录失效或 ticket 401 时回到登录页，保持与 App 登录态处理一致。

## 草图说明

参考图保留三段式结构，不表达后端尚未提供的字段。草图文件：

```text
docs/plans/assets/2026-06-08-ios-app-terminal-open-image2.png
```

设计约束：

- 头部使用 `activeCommand ?? basename(command)` 作为主标题，副标题使用 `cwd` 的 basename 或短路径。
- 中间终端区不放在装饰性卡片里，直接作为主工作区，占据除头部和输入框外的剩余高度。
- 底部 composer 固定在安全区上方，输入内容只代表“发送到终端”，不描述 AI 能力。
- 如草图或参考图里出现 `main`、`codex/main` 这类后端无字段来源内容，实现时不得展示；只有后端提供字段后再加。

## 文件范围

预计新增：

- `packages/terminal-renderer/package.json`：新共享终端 renderer package，依赖 React、xterm 与必要 addon；不依赖 `@runweave/shared`、WebSocket、HTTP、Tailwind、Ionic、shadcn、Radix 或 next-themes。
- `packages/terminal-renderer/src/index.ts`：导出 renderer 组件、handle、props 和 theme 类型。
- `packages/terminal-renderer/src/TerminalRenderer.tsx`：封装 xterm 初始化、snapshot/output 渲染、resize、基础键盘输入、`TerminalRendererHandle` 和 `onTerminalReady()` extension hook；不依赖 Web Preview store，不写 Tailwind class。
- `packages/terminal-renderer/src/terminal-renderer.css`：唯一承载 `@xterm/xterm/css/xterm.css` import 和必要的低层容器规则，避免定义 App/Web 页面级布局。
- `packages/terminal-renderer/src/terminal-renderer-types.ts`：定义纯渲染 props/handle，不引用后端协议类型。
- `app/src/pages/AppTerminalPage.tsx`：App 终端详情页，负责头部、终端区域、底部输入框和快捷键。
- `app/src/hooks/use-app-terminal-connection.ts`：App 专用 terminal connection adapter，负责 ticket、WebSocket、snapshot/output/status/metadata 处理，并把输出写入 `TerminalRendererHandle`。
- `app/src/components/TerminalCommandComposer.tsx`：底部固定输入框，调用共享终端核心暴露的 `sendInput(text + "\n")`。
- `app/src/components/TerminalShortcutBar.tsx`：移动快捷键条。

预计修改：

- `frontend/src/components/terminal/terminal-surface.tsx`、`frontend/src/components/terminal/use-terminal-emulator.ts`：把纯 xterm 初始化/写入/resize 逻辑迁移到 `packages/terminal-renderer` 后，Web 侧通过 `onTerminalReady()` 注册 search、link、paste image、tmux wheel scroll、preview/browser adapter 等 Web 专属行为，并删除当前 `import "@xterm/xterm/css/xterm.css";`。
- `frontend/src/index.css`：全局 import `@runweave/terminal-renderer/terminal-renderer.css`，作为 Web 端唯一 xterm CSS 入口。
- `frontend/src/features/terminal/use-terminal-connection.ts`：本计划不移动到 renderer package；继续作为 Web adapter 的连接层，避免 renderer 依赖 WebSocket。
- `frontend/src/services/terminal.ts`：本计划不移动到 renderer package；保留 Web 专属 API 与连接 API。
- `app/package.json`：保留现有 `@runweave/shared: workspace:*`，添加 `@runweave/terminal-renderer: workspace:*`，以及 xterm 相关依赖如果 package peer dependency 需要。
- `app/src/services/terminal.ts`：在现有 `getTerminalMobileOverview()` 基础上新增 App 详情页需要的 `getTerminalSession()`、`createTerminalWsTicket()`；不要从 `frontend/src/services/terminal.ts` import。
- `app/src/App.tsx`：在现有登录/首页/overview 状态机基础上增加 `selectedTerminalSessionId` 或等价 navigation 状态，已登录且选中终端时渲染 `AppTerminalPage`，返回时恢复 `HomePage`。
- `app/src/pages/HomePage.tsx`：新增 `onOpenTerminal(terminalSessionId: string)` prop，并传给 `ProjectGroup`。
- `app/src/components/ProjectGroup.tsx`：新增 `onOpenTerminal` prop，并传给每个 `TerminalRow`。
- `app/src/components/TerminalRow.tsx`：把 row 改为可点击控件或按钮语义元素，点击时调用 `onOpenTerminal(session.terminalSessionId)`。
- `app/src/main.css`：全局 import `@runweave/terminal-renderer/terminal-renderer.css`，作为 App 端唯一 xterm CSS 入口；同时添加终端详情页三段式布局、黑底终端区、底部安全区 composer 样式。

## 后端范围

一期原则上不新增后端终端控制能力。

只在以下情况新增后端字段或接口：

- App 头部的 `lastActivityAt`、初始标题和状态优先使用首页传入的 `TerminalMobileOverviewSession`；详情页连接后再用 `GET /api/terminal/session/:id` 与 WebSocket `metadata` 更新 `cwd`、`activeCommand` 和连接状态，不在 App 侧伪造后端没有返回的字段。
- 如果 App 需要从首页直接创建终端再打开，才接入现有 `POST /api/terminal/session`；本计划默认只打开已有终端。
- 如果真实 iOS WebView 对 WebSocket 认证、代理或 mixed content 有限制，优先调整 App 端 `apiBase` 和 HTTPS 配置；不要新增第二套 terminal ws 协议。

## Web 终端扩展回归清单

拆 `use-terminal-emulator.ts` 后，Web 端必须逐项回归这些既有能力：

- **基础渲染**：打开 Web 终端，确认 initial snapshot、增量 output、输入、resize 都正常。
- **搜索**：在终端输出中制造可搜索文本，打开 Web terminal search，确认 next/previous、结果数量和 active result 高亮仍可用。
- **URL link**：输出一个 URL，例如 `https://example.com`，确认 hover/click 行为仍由 Web adapter 处理；Electron/browser preview 行为保持现状。
- **图片粘贴**：在支持剪贴板图片的环境中向 Web 终端粘贴图片，确认仍会调用 Web 侧 clipboard image API、插入文件路径并显示 pasted image chip 或既有反馈。
- **tmux wheel scroll**：在 tmux-backed terminal 中用触控板/鼠标滚轮滚动，确认仍会通过 Web adapter 发送 tmux scroll 输入，不退化成浏览器外层滚动。
- **mobile keybar**：用 Web 移动视口打开终端，确认移动快捷键条可打开，`Tab`、`Esc`、`Ctrl-C`、上下箭头仍发送对应控制序列。

## 实施任务

### 任务 1：定义纯终端 renderer package

**修改/创建文件：**

- 创建 `packages/terminal-renderer/package.json`
- 创建 `packages/terminal-renderer/src/index.ts`
- 创建 `packages/terminal-renderer/src/terminal-renderer-types.ts`
- 创建 `packages/terminal-renderer/src/terminal-renderer.css`
- 创建 `packages/terminal-renderer/tsconfig.json`

**要求：**

- package 名称使用 `@runweave/terminal-renderer`。
- package 不依赖 `@runweave/shared`，因为 renderer 不理解 terminal protocol，只理解字符串输入输出和尺寸。
- package 不包含 `services/http.ts`、`services/terminal.ts`、`useTerminalConnection.ts` 或任何 WebSocket/ticket 代码。
- `terminal-renderer-types.ts` 定义以下纯 UI 合同：

```ts
import type { Terminal } from "@xterm/xterm";

export type TerminalRendererPreference = "dom" | "canvas" | "webgl" | "auto";

export interface TerminalRendererTheme {
  background: string;
  foreground: string;
  cursor: string;
  selectionBackground?: string;
}

export interface TerminalRendererHandle {
  focus(): void;
  fit(): void;
  refresh(): void;
  resetAndWrite(data: string): void;
  write(data: string): void;
  clear(): void;
  getTerminal(): Terminal | null;
}

export interface TerminalRendererExtensionContext {
  terminal: Terminal;
  container: HTMLDivElement;
  fit: () => void;
  refresh: () => void;
}

export type TerminalRendererDisposable = { dispose(): void } | (() => void);

export interface TerminalRendererProps {
  active: boolean;
  className?: string;
  fontFamily?: string;
  fontSize?: number;
  lineHeight?: number;
  renderer?: TerminalRendererPreference;
  scrollbackLines?: number;
  theme?: TerminalRendererTheme;
  onBell?: () => void;
  onInput?: (data: string) => void;
  onResize?: (cols: number, rows: number) => void;
  onTerminalReady?: (
    context: TerminalRendererExtensionContext,
  ) => void | TerminalRendererDisposable | TerminalRendererDisposable[];
}
```

- `terminal-renderer.css` 只 import xterm css，并提供最小容器规则；不得定义页面背景、header、composer、card、spacing。
- `TerminalRenderer.tsx` 不 import `@xterm/xterm/css/xterm.css`，也不 import `terminal-renderer.css`；CSS 入口必须是调用方全局 CSS。
- Web 端删除 `frontend/src/components/terminal/terminal-surface.tsx` 现有的 `import "@xterm/xterm/css/xterm.css";`，改由 `frontend/src/index.css` 统一导入 renderer CSS。
- App 端不得直接 import `@xterm/xterm/css/xterm.css`，只在 `app/src/main.css` 导入 renderer CSS。
- App 一期默认 `renderer="dom"`；Web 可以继续按现有偏好选择 renderer。

**验证：**

- `pnpm --filter @runweave/terminal-renderer typecheck`
- `pnpm --filter @runweave/app typecheck`

预期：renderer package 单独 typecheck 通过；App 能解析 renderer package 类型。

### 任务 2：迁移最小 xterm 渲染能力

**修改/创建文件：**

- 创建 `packages/terminal-renderer/src/TerminalRenderer.tsx`
- 必要时创建 `packages/terminal-renderer/src/terminal-input-utils.ts`
- 修改 `frontend/src/components/terminal/terminal-surface.tsx`

**要求：**

- `TerminalRenderer` 允许从现有 `use-terminal-emulator.ts` 迁移的能力：
  - `Terminal` 初始化。
  - `FitAddon` 与 `ResizeObserver` resize。
  - `Unicode11Addon`。
  - renderer 选择与 fallback：App 默认 DOM；Web 可用 `auto` 触发 WebGL -> Canvas fallback。
  - `terminal.write()`、`terminal.reset()`、`terminal.refresh()`、`terminal.focus()`。
  - `terminal.onData()` 基础输入回调，并过滤终端自动响应。
  - `terminal.attachCustomKeyEventHandler()` 的 Shift+Enter -> `"\n"`。
  - `terminal.onBell()`。
- `TerminalRenderer` 暴露 `onTerminalReady()` extension hook。renderer 调用该 hook 时传入 `terminal`、`container`、`fit()`、`refresh()`；调用方返回的 disposable 或 disposable 数组必须在 renderer unmount 或 terminal 重建时统一清理。
- `TerminalRenderer` 明确不直接实现以下 Web 功能；这些能力如果 Web 仍需要，必须在 Web adapter 的 `onTerminalReady()` 中注册：
  - `SearchAddon`、搜索 toolbar 和搜索结果状态。
  - `WebLinksAddon`、`createTerminalWrappedWebLinkProvider()`、浏览器/Preview 打开链接。
  - clipboard image paste、`createTerminalSessionClipboardImage()`、`fileToBase64()`、`shellQuote()`。
  - `HttpError`、`apiBase`、`token`、`terminalSessionId`、`onAuthExpired`。
  - tmux wheel scroll 的 `buildTmuxScrollInput()`、`shouldThrottleTmuxScroll()`。
  - `DEFAULT_TERMINAL_PREFERENCES`、`createResizeScheduler()` 等 `frontend/src/features/*` 直接 import；需要的偏好值改为 renderer props，resize debounce 在 renderer package 内用局部常量实现。
- `TerminalRenderer` 的实现不得出现这些 import 前缀：

```ts
import ... from "../../features/";
import ... from "../../services/";
import ... from "../../../frontend/";
```

- Web 端需要 search/link/paste/tmux wheel 时，在 Web adapter 的 `onTerminalReady()` 里继续保留或重新接回；App 一期不传 `onTerminalReady()`，不支持这些功能。

**验证：**

- `rg -n 'features/|services/|useTerminalConnection|WebSocket|createTerminalWsTicket|createTerminalSessionClipboardImage|WebLinksAddon|SearchAddon' packages/terminal-renderer/src` 无命中，除非命中的是文档注释中的禁止清单。
- 按“Web 终端扩展回归清单”逐项验证，确认迁移到 `onTerminalReady()` 后没有回退。
- `pnpm --filter @runweave/terminal-renderer typecheck`
- `pnpm --filter @runweave/frontend typecheck`
- `pnpm --filter @runweave/app build`

### 任务 3：实现 App 终端详情页三段式壳

**修改/创建文件：**

- 创建 `app/src/pages/AppTerminalPage.tsx`
- 创建 `app/src/hooks/use-app-terminal-connection.ts`
- 创建 `app/src/components/TerminalCommandComposer.tsx`
- 创建 `app/src/components/TerminalShortcutBar.tsx`
- 修改 `app/src/services/terminal.ts`
- 修改 `app/src/App.tsx`
- 修改 `app/src/main.css`

**要求：**

- 页面结构固定为 header、terminal body、composer 三块。
- Header 主标题来自终端 metadata：优先 `activeCommand`，否则 `command` basename；副标题显示 cwd 短路径。
- Terminal body 使用共享 `TerminalRenderer`，不额外套卡片。
- `use-app-terminal-connection.ts` 负责 App 专用连接 adapter：调用 `createTerminalWsTicket()`，连接 `/ws/terminal`，把 `snapshot` 交给 `rendererRef.current.resetAndWrite(data)`，把 `output` 交给 `rendererRef.current.write(data)`。
- `TerminalRenderer` 的 `onInput(data)` 和底部 composer 都只调用 App adapter 暴露的 `sendInput(data)`；renderer 本身不知道 WebSocket。
- Composer 发送规则：非空文本点击发送时发送 `${text}\n`；快捷键发送对应控制序列；发送后清空文本。
- App 一期不支持图片粘贴、链接跳转、搜索、tmux wheel scroll；这些功能不得为了复用 Web 代码而进入 App 或 renderer。
- iOS 安全区：header 顶部和 composer 底部使用 `env(safe-area-inset-top)`、`env(safe-area-inset-bottom)`。
- 键盘弹起时 composer 保持可见，终端区高度收缩，不遮挡输入框。
- 不重写现有登录、refresh token 和 overview 加载流程；只在现有已登录分支增加终端详情页状态。

**验证：**

- `pnpm --filter @runweave/app typecheck`
- `pnpm --filter @runweave/app build`
- 手工用移动视口验证：header 不溢出，终端区能滚动/显示输出，composer 固定在底部。

### 任务 4：接通现有 App 首页到终端详情页

**修改文件：**

- `app/src/App.tsx`
- `app/src/pages/HomePage.tsx`
- `app/src/components/ProjectGroup.tsx`
- `app/src/components/TerminalRow.tsx`

**要求：**

- `App.tsx` 增加 `selectedTerminalSessionId` 或等价 navigation 状态；登录态有效且有选中终端时渲染 `AppTerminalPage`，否则继续渲染当前 `HomePage`。
- `HomePage` 增加 `onOpenTerminal` prop，传给 `ProjectGroup`；`ProjectGroup` 传给 `TerminalRow`。
- 点击一个 `TerminalRow` 后进入 `AppTerminalPage`，传入真实 `session.terminalSessionId`。
- 返回按钮回到首页，保留首页项目展开/搜索状态。
- 如果 terminalSessionId 不存在或 `GET /api/terminal/session/:id` 返回 404，显示错误页并允许返回首页。
- 如果认证 401，清理登录态并回到登录页。
- 刷新首页 overview 后，如果当前详情页终端仍存在，不强制退出详情页；如果后端详情接口返回 404，再由详情页处理错误。

**验证：**

- `pnpm --filter @runweave/app build`
- 手工流程：登录 -> 首页 -> 点击终端 -> 看到实时输出 -> 输入 `pwd` 发送 -> 输出区出现执行结果 -> 返回首页。

### 任务 5：后端与 Web 回归

**修改文件：**

- 后端原则上无修改；如共享类型移动导致 import 变化，只做最小路径修正。

**验证：**

- `pnpm --filter ./backend typecheck`
- `pnpm --filter @runweave/frontend typecheck`
- `pnpm --filter @runweave/app build`
- Web 端手工回归：先输入 `echo runweave-terminal-reuse` 确认基础输出正常，再按“Web 终端扩展回归清单”覆盖搜索、URL link、图片粘贴、tmux wheel scroll、mobile keybar。
- App 端手工回归：连接同一个 backend，打开已有终端，输入 `echo app-terminal-open`，确认输出正常。

## 验收标准

- App 能从首页打开一个真实已有终端。
- App 终端详情页符合三段式布局：头部信息、中间实时终端、底部固定输入框。
- 共享 renderer 是纯渲染能力：不依赖 WebSocket、HTTP、后端协议、Web service、Preview、Search、Link 或 Clipboard Image。
- App adapter 与 Web adapter 使用同一套后端 `/ws/terminal` 协议和 `@runweave/shared` 消息类型，但 renderer 不感知协议。
- App 输入框发送的内容能进入同一个终端 runtime；换行提交命令。
- Web 现有终端能力不回退：snapshot、output、resize、输入、搜索、URL link、图片粘贴、tmux wheel scroll、mobile keybar、重连仍可用。
- 没有在 `packages/terminal-renderer` 中复制或引入任何 WebSocket terminal 协议实现。
- App 一期不实现图片粘贴、链接跳转和搜索。
- 没有在 App 终端页展示后端无字段来源的 branch、AI 状态或伪造活动信息。
- 不新增 `app/src/**/*.test.ts`、`*.test.tsx`、`*.spec.tsx` 或前端 Vitest 覆盖。

## 风险与处理

- **抽共享 package 影响 Web 终端：**只迁移纯 xterm renderer，不迁移 `useTerminalConnection`；迁移后每一步跑 Web typecheck，并做 Web 终端手工回归。
- **App 引入 Web 样式体系：**共享 package 不允许依赖 Tailwind/shadcn；App 只在 `app/src/main.css` import renderer CSS 和自身页面样式。
- **iOS WebView 下 WebGL 不稳定：**App 默认使用 DOM renderer；Web 可继续使用 WebGL -> Canvas fallback。如真机出现黑屏，App 强制保持 DOM 或 Canvas renderer。
- **键盘遮挡底部 composer：**App CSS 使用 dvh 和 safe-area；必要时监听 `visualViewport` 只调整 composer 容器，不改终端协议。
- **App 与 Web 链接行为不同：**renderer 一期不做链接识别；Web 保留自己的 link provider，App 后续需要时再单独设计。
