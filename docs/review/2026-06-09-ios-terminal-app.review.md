# iOS Terminal App 变更评审

评审日期：2026-06-09

评审范围：当前工作区未提交变更，重点覆盖 `app-dev.mjs`、App 路由/终端交互、移动端终端概览接口、tmux metadata 同步、依赖与样式接入。

验证命令：

- `git status --short`
- `git diff --stat`
- `pnpm --filter @runweave/app typecheck`
- `pnpm --filter ./backend typecheck`

类型检查结果：App 与 backend 均通过。未运行 E2E 或后端测试全量套件。

## 架构 / 策略发现

### P2 - `app:dev` 默认启动 iOS 原生链路，扩大了开发入口的环境依赖

- 当前决策：`APP_DEV_IOS_ENABLED` 默认值是 `process.env.APP_DEV_IOS !== "false"`，因此根脚本 `pnpm app:dev` 会在 Vite app ready 后默认执行 `pnpm --filter @runweave/app cap run ios --live-reload ...`。引用：`app-dev.mjs:17`、`app-dev.mjs:85`、`app-dev.mjs:267`、`package.json:16`。
- 为什么它在系统层面可能是错的：原本 `app:dev` 是 Web app + backend 的低门槛开发入口；现在默认路径要求 Capacitor iOS、Xcode、模拟器或真机链路可用。任何没有 iOS 工具链、只想调试浏览器 App、或在非 macOS 环境运行的人都会被默认路径阻断。新增 `app:dev:web` 不能完全抵消这个风险，因为已有脚本名、文档记忆和自动化习惯仍然指向 `app:dev`。
- 更好的候选方案：
  - 推荐：保留 `app:dev` 为 Web + backend 入口，新增显式 `app:dev:ios` 或 `app:ios:live` 才启动 Capacitor live reload。交付速度快，复杂度低，对已有工作流影响最小。
  - 可接受：`app:dev` 自动探测平台与 iOS 工具链，缺失时只启动 Web dev server 并给出清晰提示。兼容性更好，但探测逻辑和边缘状态更多。
  - 不推荐：继续保持 iOS 默认开启，只要求用户记住 `APP_DEV_IOS=false` 或 `app:dev:web`。这把平台能力差异暴露给所有开发者，长期会增加环境排障成本。
- 迁移/过渡风险说明：如果已有使用者已经依赖 `app:dev` 自动打开 iOS，需要公告脚本语义变化，或保留短期别名 `app:dev:ios` 并在日志中提示新入口。

### P2 - 移动概览读接口承担 tmux metadata 同步和 DB 写入，查询路径变成有副作用的控制面

- 当前决策：`buildTerminalMobileOverviewPayload()` 先对所有 running tmux session 调用 `syncTmuxSessionActivityForMobileOverview()`，每个 session 读取 tmux metadata/activity，然后调用 `updateSessionMetadata()` 和 `updateSessionActivity()` 写入 session store。引用：`backend/src/routes/terminal-mobile-overview.ts:101`、`backend/src/routes/terminal-mobile-overview.ts:110`、`backend/src/routes/terminal-mobile-overview.ts:117`、`backend/src/routes/terminal-mobile-overview.ts:128`、`backend/src/routes/terminal-mobile-overview.ts:132`、`backend/src/routes/terminal-mobile-overview.ts:155`；写入逻辑见 `backend/src/terminal/manager.ts:531`、`backend/src/terminal/manager.ts:560`。
- 为什么它在系统层面可能是错的：移动首页刷新本质上是读模型查询，但现在每次查询都可能触发大量 tmux 子进程和持久化写入。session 数增加时，请求延迟、tmux 压力、DB 写放大和故障面都会随读流量增长；同时读接口的失败语义变复杂，metadata 超时只记录 debug，用户看到的排序和状态可能是部分同步后的混合视图。
- 更好的候选方案：
  - 推荐：把 tmux metadata/activity 同步移出概览读路径，放到已有 session manager/terminal runtime 的事件路径或短周期后台刷新缓存；概览只读取缓存状态。查询稳定，写入可控，代价是需要定义缓存 TTL 和刷新节流。
  - 可接受：概览接口只做只读 tmux capture，不写 DB；排序使用内存中的 `lastActivityAt`，详情页或 WebSocket metadata 再更新精确信息。交付快，但移动首页排序可能短暂滞后。
  - 平台/工具链方案：如果需要基于 tmux activity 排序，优先使用 tmux hooks/shell integration 已有事件能力推送更新，而不是在 HTTP GET 中主动扫所有 pane。
  - 不推荐：在当前同步读路径上继续加 timeout 或日志。它缓解单次请求耗时，但不解决读流量驱动控制面写入的根因。
- 迁移/过渡风险说明：迁出后移动首页可能短时间显示旧 activity，需要产品接受 eventual consistency，或在 UI 上保留下拉刷新但不承诺强同步。

## 代码 / 实现发现

### P2 - 图片选择在客户端无大小前置校验，移动端可能在发请求前耗尽内存

- 为什么这是风险：App 选择图片后立即 `fileToBase64(file)`，当前实现用 `Array.from(new Uint8Array(buffer), ...).join("")` 再 `btoa()` 构造 base64。对大图会同时持有 ArrayBuffer、Uint8Array、字符数组、中间字符串和 base64 字符串；后端虽然有 100 MiB 限制，但限制发生在客户端读完整文件并把 JSON 发出之后。移动端内存更紧，这类路径容易在用户选中超大图片时卡死或崩溃。
- 具体位置：`app/src/pages/AppTerminalPage.tsx:102`、`app/src/pages/AppTerminalPage.tsx:106`、`app/src/pages/AppTerminalPage.tsx:108`、`app/src/lib/terminal-input-assets.ts:1`、`app/src/lib/terminal-input-assets.ts:3`、`app/src/lib/terminal-input-assets.ts:4`；后端限制在 `backend/src/terminal/clipboard-image.ts:1`、`backend/src/routes/terminal-clipboard-image-routes.ts:80`、`backend/src/routes/terminal-clipboard-image-routes.ts:81`。
- 可执行修复方向：在客户端读取前用共享常量校验 `file.size`，明显超过限制时直接展示错误；避免 `Array.from(...).join("")` 这类高倍内存实现，至少统一使用 `FileReader.readAsDataURL`，更彻底的方案是改为 multipart/stream 上传或分片上传。限制值应下沉到 shared 包，避免 App 与后端各自硬编码。

### P3 - tmux activity 读取每个 metadata 请求额外启动一次 tmux 命令，缺少并发上限

- 为什么这是风险：`readPaneMetadata()` 现在对每个 session 并行执行原 metadata 命令和 `readPaneActivityAt()`，而移动概览又对所有 running tmux session `Promise.all`。如果同时有几十个 session，单次首页刷新会瞬间启动成倍 tmux 命令，再叠加后续 tail capture。即使每个命令有 timeout，也可能造成短时进程风暴和 tmux socket 排队。
- 具体位置：`backend/src/terminal/tmux-service.ts:400`、`backend/src/terminal/tmux-service.ts:404`、`backend/src/terminal/tmux-service.ts:419`、`backend/src/terminal/tmux-service.ts:437`；调用侧在 `backend/src/routes/terminal-mobile-overview.ts:110`、`backend/src/routes/terminal-mobile-overview.ts:117`。
- 可执行修复方向：如果保留当前读时同步，应把 activity format 合并进同一次 `display-message`，并对 overview metadata/tail capture 加并发上限。更推荐按上面的架构发现迁到后台缓存，HTTP 请求只读缓存。

## 剩余风险 / 测试缺口

- 未执行 Playwright E2E，因此未验证 Ionic Router 深链、登录跳转、终端连接和图片选择在真实浏览器/移动 WebView 下的行为。
- 未执行后端单测全量套件，因此 tmux metadata 同步和 clipboard route 的回归只做了代码阅读与类型检查。
- 未验证 `pnpm app:dev` 在无 Xcode/无模拟器/非 macOS 环境下的实际失败形态。
