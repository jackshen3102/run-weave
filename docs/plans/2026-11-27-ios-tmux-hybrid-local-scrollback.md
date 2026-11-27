# 原生 iOS 终端 TMUX 本地历史滚动层（Hybrid Local Scrollback）实施计划

当用户在手机（原生 iOS）上连接运行 Codex、Claude Code 或普通 Shell 的 `tmux` 终端并在高延迟或不稳定网络下向上滑动回看历史时，手势在本地零网络往返（0 RTT）切入原生 `UIScrollView` 像素级顺滑滚动与系统惯性减速，滑回底部或提交输入时无缝回到实时 `tmux` 画面，同时完整保留远端 `tmux` 保活、桌面与手机独立列宽以及现有 Agent 辅助能力。

## 1. 目标与非目标

### 目标

- **消除手机回看 `tmux` 历史的网络 RTT 与进程串行阻塞**：在保留服务端 `tmux` 运行时的前提下，为原生 iOS 客户端引入与实时层同视口对齐的「本地历史滚动层（Local History Surface）」，使向上回看历史直接走本地 `SwiftTerm` 普通缓冲区与 `UIScrollView` 像素级滚动。
- **保留 ANSI 样式并支持手机窄屏自动重排（Reflow）**：Backend 提供带 ANSI 转义与软换行合并（`tmux capture-pane -e -J -p`）的受控历史快照接口，使桌面宽屏（如 140 列）输出的 Codex / Claude Code 内容在手机窄屏（如 46 列）本地缓冲区中自动按手机列宽自然折行，同时保留颜色、粗体与链接文本。
- **首滑零断触接力（Seamless Pan Handoff）**：用户在实时层第一下向上拖动即在同一手势内完成本地历史层显出、像素级 `contentOffset` 跟手与松手系统减速率惯性滑行；后续滑动、轻触急停、橡皮筋回弹、长按选词复制及点击文件/网页链接直接由本地 `NativeTerminalView`（`UIScrollView`）原生承载。
- **弱网/断网可读与可退回**：只要本地历史快照已预热就绪，即使网络高延迟、抖动或临时离线，用户仍可随时上滑顺畅阅读历史，并可通过滑到底部或点击「回到底部」立即退回实时层。
- **严格守住应用鼠标模式与多分屏隔离边界**：当远端 pane 处于全屏应用鼠标接管状态（`owner === "application"`，如开启鼠标追踪的全屏 TUI）时，不劫持手势，继续走现有 `normalized-v1` 远端滚轮协议；多分屏切换时严格按 `paneId` 隔离缓存，绝不串屏。

### 非目标（不做什么）

- 不替换或改动 Backend 的 `tmux` 会话保活架构，不在本计划中启用 macOS / Linux `pty-host`。
- 不改变桌面端（Web / Electron）与普通 `pty` 运行时终端的现有滚动路径。
- 不接管全屏 Alternate Screen 鼠标应用（如 `vim`、`htop`）的内部滚动；应用内部滚动仍由远端应用自身响应。
- 不把全量彩色历史塞入实时终端 WebSocket 流，避免挤占实时 WS 的 4 MiB 待发送队列上限而误触发 `1013` 慢客户端断连。

## 2. 用户可见行为与状态机规则

1. **连接预热与静默增量刷新**：
   - 原生 iOS 打开 `runtimeKind == "tmux"` 的终端并在收到首屏 `snapshot` 后，后台发起独立的 HTTP 彩色历史快照请求（最多保留最近 5,000 行、硬上限 1 MiB UTF-8），按 16 KiB 分片异步喂入待命的本地历史 `SwiftTermSurface`（每次分片 `Task.yield()`，不阻塞主线程渲染），就绪后滚至底部待命。
   - 处于实时层底部期间，每当收到新的 `output` 帧，将本地历史标记为 `dirty`；在输出静默 `600 ms`（或持续输出期间距上次同步满 `3 s` 且页面处于前台可见、未被 Composer/阅读器遮挡）时，后台单飞（singleflight）拉取最新快照更新待命缓冲区。
2. **向上滑动切入本地历史层**：
   - 触发条件：`runtimeKind == "tmux"`、最新已知 `scrollState.owner == "history"`、远端未处于外部遗留的 `copyMode == true`，且本地已持有匹配当前 `paneId` 的就绪历史缓冲区。
   - 手势接力：实时层手势识别到向上垂直滑动时，**不向服务端发送 `scroll` 或进入远端 `tmux copy-mode`**，立即在同一视口框内显出本地历史层（起始位于最底部），并将本次手势的实时垂直位移按 1:1 像素驱动本地历史 `UIScrollView.contentOffset.y`，松手后按手势速度与 `UIScrollView.DecelerationRate.normal` 执行像素级惯性减速。
   - 若起滑瞬间 `dirty == true`（如 Agent 正在流式输出），**立即使用已就绪的本地快照 0ms 响应起滑**，绝不等待网络请求；同时后台可补抓一次最新尾部快照，但**在用户停留在历史层期间绝不覆盖或重置当前阅读视口与文字选区**。
   - 降级条件：若连接的是不支持新接口的旧版 Backend（HTTP `404`）、首屏后尚未完成首次预热、远端已处于外部触发的 `copyMode == true`、或当前 `owner == "application"`，手势无缝沿用现有的 `TerminalScrollTransport` 远端滚动逻辑。
3. **在本地历史层中的交互**：
   - 后续上下滑动、快速甩动、轻触停止惯性、顶部回弹均由本地 `NativeTerminalView` 的原生 `UIScrollView` 直接处理。
   - 保留长按选词/全选/复制菜单，保留单击文件引用打开 `TerminalFilePreview` 与单击链接打开内置浏览器。
   - 本地历史层只读，不弹出系统键盘，不向远端发送任何终端查询应答（`acceptsTerminalResponses = false`）或按键输入。
   - 阅读期间底层实时 `surface` 继续在后台正常消费 WebSocket `output` 与维护恢复游标（`committedCursor`），不受历史层遮挡影响，也**不抢夺用户当前的阅读位置**。
4. **退回实时层与状态联动**：
   - 触发退回的任一动作：
     1. 用户将本地历史 `UIScrollView` 向下滑到底部（`contentOffset.y >= maxOffset - 2` 且手势结束或继续下推）；
     2. 用户点击右下角「回到底部」按钮（`terminal-return-to-bottom`）；
     3. 用户通过 Composer、一键回复、快捷指令或快捷键栏成功发起终端输入。
   - 退回行为：立即隐藏本地历史层、恢复展示实时 `surface` 最新画面；若此时 `dirty == true`，后台安排一次静默历史刷新供下次滑动使用。
   - **离线可退回修正**：当 `isShowingLocalHistory == true` 且远端未处于 `copyMode == true` 时，即使手机当前离线或 `canSend == false`，「回到底部」按钮仍保持可点击，点击后立即在本地退回实时层；仅当远端同时处于 `copyMode == true` 且在线可写时才额外调用 `tmux_exit_copy_mode`。
   - **未读完成通知保护**：`isShowingLocalHistory == true` 时，`SessionController.scrolledBack` 必须为 `true`，确保 `TerminalScreen` 的 `canReportCompletionViewed` 在用户半途回看历史时不会将新到达的完成通知误标为已读；退回实时层底部后自动恢复正常已读上报。

## 3. API 合约与协议扩展

### 3.1 共享 DTO（`packages/shared/src/terminal/runtime/`）

1. 在 `packages/shared/src/terminal/runtime/session.ts` 新增彩色历史快照响应类型：

```ts
export interface TerminalAnsiScrollbackResponse {
  terminalSessionId: string;
  /** 当前抓取对应的真实 tmux pane 标识（如 "%0"），用于客户端防串屏校验。 */
  paneId: string;
  /** 服务端抓取时的 pane 列宽，供诊断记录。 */
  sourceCols: number;
  /** 实际返回的逻辑行数（上限 5000）。 */
  lineCount: number;
  /** 经 capture-pane -e -J -p 抓取并按完整行裁剪至 <= 1 MiB UTF-8 的带 ANSI 样式文本。 */
  data: string;
}
```

2. 在 `packages/shared/src/terminal/runtime/websocket.ts` 的 `TerminalScrollState` 中增加可选 `paneId?: string` 字段（向后兼容旧客户端与旧服务端）：

```ts
export interface TerminalScrollState {
  type: "scroll-state";
  owner: "history" | "application";
  copyMode: boolean;
  offsetRows: number | null;
  /** 当前滚动归属对应的 tmux paneId；分屏切换时客户端据此立即作废旧 pane 本地历史。 */
  paneId?: string;
  gestureId?: string;
  sequence?: number;
  status: "state" | "applied" | "cancelled";
}
```

### 3.2 Backend 路由与服务边界

- **路由**：`GET /api/terminal/session/:id/scrollback/ansi`（复用现有终端会话鉴权中间件，不接受未认证访问；会话不存在返回 `404`；非运行中或非 `tmux` 会话返回 `409 { code: "SCROLLBACK_ANSI_UNSUPPORTED" }`）。
- **查询参数**：可选 `panelId?: string`（省略时解析当前活跃 panel 对应的 `paneTarget`）。
- **抓取与裁剪规则（`TmuxPaneService.capturePaneAnsiHistory`）**：
  - 调用 `tmux capture-pane -e -J -p -S -5000 -t <paneId>`（必须校验 `paneId` 符合 `/^%\d+$/`）；
  - **并发收敛**：同一 `(socketPath, paneId)` 的并发请求在服务端共享同一个 in-flight Promise（singleflight），避免高频重复 fork `tmux` 子进程；
  - **硬上限裁剪**：设定 `MAX_ANSI_SCROLLBACK_BYTES = 1024 * 1024`（1 MiB UTF-8）。若结果超过 1 MiB，按 `\n` 边界从最旧的头部整行丢弃（绝不截断半条 ANSI 转义序列），并在裁剪后若首行缺少重置序列则前置 `\x1b[0m` 防止残留样式污染后续行；若单行极端超长仍超 1 MiB，保留末尾安全切片并前置 `\x1b[0m`。
- **滚动归属状态同步增强**：
  - 在 `backend/src/terminal/runtime/scroll-service.ts` 的 `read()` 中填入 `paneId: pane.paneId`；
  - 在 `backend/src/ws/terminal-metadata-sync.ts` 执行 tmux pane 元数据同步时，若 `activeCommand`、活跃 `paneId` 或 alternate/mouse 模式发生变化，联动触发当前连接的 `scrollController.sync()`，确保手机在未发起远端滚动前也能及时获知远端进入了全屏鼠标应用（`owner: "application"`）或切换了分屏。

## 4. 修改与新增文件清单

| 文件路径                                                                                                                                   | 操作      | 职责说明                                                                                                                                                                      |
| :----------------------------------------------------------------------------------------------------------------------------------------- | :-------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared/src/terminal/runtime/session.ts`                                                                                          | 修改      | 新增 `TerminalAnsiScrollbackResponse` 接口导出                                                                                                                                |
| `packages/shared/src/terminal/runtime/websocket.ts`                                                                                        | 修改      | 在 `TerminalScrollState` 新增可选 `paneId?: string` 字段                                                                                                                      |
| `backend/src/terminal/tmux/pane-service.ts`                                                                                                | 修改      | 新增 `capturePaneAnsiHistory(target, historyLines)`：带 `-e -J -p` 抓取、同 pane singleflight 与 1 MiB 整行边界安全裁剪                                                       |
| `backend/src/routes/terminal/scrollback.ts` 与 `backend/src/routes/terminal/index.ts`                                                      | 新建/修改 | 注册 `GET /session/:id/scrollback/ansi` 路由，完成鉴权、panel 解析与响应映射                                                                                                  |
| `backend/src/terminal/runtime/scroll-service.ts` 与 `backend/src/ws/terminal-input-handler.ts`、`backend/src/ws/terminal-metadata-sync.ts` | 修改      | 在 `scroll-state` 附带 `paneId`，并在 pane 切换或应用模式变化时主动同步最新 `scroll-state`                                                                                    |
| `packages/app-ios/Sources/RunweaveIOS/Contracts/TerminalMessage.swift` 与 `Services/APIClient.swift`                                       | 修改      | 解析 `TerminalScrollState.paneId`；新增 `APIClient.terminalAnsiScrollback(id:panelID:)` 请求方法                                                                              |
| `packages/app-ios/Sources/RunweaveIOS/Features/Terminal/LocalHistoryScrollController.swift`                                                | 新建      | 管理待命/显示的本地只读 `SwiftTermSurface`、16 KiB 分片异步喂入、600 ms 防抖同步、`paneId`/generation 隔离、首滑像素跟手与惯性减速接力                                        |
| `packages/app-ios/Sources/RunweaveIOS/Features/Terminal/Input/TerminalGestures.swift` 与 `Rendering/SwiftTermSurface.swift`                | 修改      | 在 `owner == "history"` 且本地历史就绪时将实时层上滑手势零延迟转交 `LocalHistoryScrollController`，不发远端滚动包                                                             |
| `packages/app-ios/Sources/RunweaveIOS/Features/Terminal/SessionController.swift`                                                           | 修改      | 组合 `LocalHistoryScrollController`，统一聚合 `scrolledBack`、输入提交自动退出历史层、`returnToBottom()` 本地/远端协同与诊断埋点（`scroll.local_enter`、`scroll.local_exit`） |
| `packages/app-ios/Sources/RunweaveIOS/Features/Terminal/TerminalScreen.swift` 与 `Input/TerminalQuickActionBar.swift`                      | 修改      | 在同一 `ViewportHost` 尺寸内叠放实时层与本地历史层；允许纯本地历史回看状态在离线时点击「回到底部」退回实时层                                                                  |
| `docs/architecture/terminal-tmux-recovery.md` 与 `packages/app-ios/docs/architecture.md`                                                   | 修改      | 更新原生 iOS `tmux` 本地历史滚动层、应用鼠标模式分流及与远端 copy-mode 的边界说明                                                                                             |
| `docs/testing/app/ios-tmux-local-scrollback.testplan.yaml`                                                                                 | 新建      | 覆盖本地零 RTT 滚动、ANSI/窄屏重排、断网可读可退、流式输出不抢视口、全屏鼠标应用直通与分屏隔离验收                                                                            |

## 5. 高风险点与安全/兼容回滚

- **主线程卡顿与内存峰值风险**：
  - 5,000 行彩色文本一次性同步 `feed` 会阻塞 UI 主线程导致掉帧。实现必须沿用 `HistoryView` 验证过的 `16 KiB + Task.yield()` 异步分块写入，并在预热期间通过后台待命 buffer 吸收写入，写完并定位到底部后才标记 `isReady = true`；单终端仅维护活跃态历史 buffer，页面退出或 `dispose()` 时立即释放 `SwiftTermSurface`。
- **实时层与历史层切换瞬间的视觉跳动**：
  - 本地历史层必须挂载在与实时层完全相同的容器内边距和字体配置下（复用 `TerminalHostView` 相同的视口尺寸与 `TerminalAppearance` 主题色），确保两层 `cols`、`rows`、字号、行高严格一致；切入瞬间历史层起始 `contentOffset` 锚定最底部，随后叠加当帧手指位移，避免切屏跳行。
- **全屏 TUI 误拦截风险**：
  - 若用户在 shell 中启动 `vim`、`less` 或带鼠标追踪的全屏 TUI，此时上滑本意是滚编辑器而非看历史。客户端必须以 `scrollState.owner == "history"` 且实时 `surface.terminalView.getTerminal()` 未收到应用鼠标阻塞为前提；一旦 `owner == "application"`，若当前正处于本地历史层则不在后台静默乱切，但实时层新发起的手势一律直通远端 `normalized-v1`。
- **前向/后向兼容与回滚**：
  - 新版 iOS 连接旧版 Backend 时，`GET /scrollback/ansi` 返回 `404` 会将该连接标记为 `ansiScrollbackUnsupported = true`，当前会话内不再重试该接口，100% 自动回退至现有远端 `normalized-v1` 滚动，无错误弹窗。
  - 旧版 iOS 或 Web 客户端连接新版 Backend 时，忽略 `scroll-state.paneId` 新增字段且不调用新路由，现有行为零变化。

## 6. 验收标准与验证方式

配套新增测试计划：[docs/testing/app/ios-tmux-local-scrollback.testplan.yaml](../testing/app/ios-tmux-local-scrollback.testplan.yaml)（同时保留回归 [docs/testing/app/ios-native-terminal.testplan.yaml](../testing/app/ios-native-terminal.testplan.yaml) 中的 `IOSTERM-003`、`IOSTERM-005`）。

### 静态与构建门禁

- [ ] `pnpm testplan:validate docs/testing/app/ios-tmux-local-scrollback.testplan.yaml` 与 `pnpm docs:check` 通过。
- [ ] `pnpm --filter @runweave/shared typecheck`、`pnpm --filter @runweave/backend typecheck`、`pnpm --filter @runweave/backend lint`、`pnpm architecture:check` 全部通过。
- [ ] 在 `packages/app-ios` 执行 `node scripts/ios.mjs build --simulator <共享池分配 UDID>` 构建成功。

### 真实环境交互验收标准

- [ ] **零网络往返跟手滚动（`IOSHIST-001`）**：在 `tmux` 终端输出 3,000+ 行带 ANSI 颜色与超宽长行的内容（模拟桌面宽屏下的 Codex / Claude Code 输出），在 iOS 端向上滑动并甩动；通过诊断事件与后端日志确认滑动全程未发送 WS `scroll` 消息、远端 `#{pane_in_mode}` 保持 `0`（未进 tmux copy-mode），画面保留颜色且长行按手机窄屏自然重排，第一下起滑即跟手并带原生惯性减速。
- [ ] **高延迟/断网下顺畅回看与本地退回（`IOSHIST-002`）**：预热完成后注入高延迟或临时断开网络，向上滑动仍可零卡顿浏览已缓存历史；离线状态下点击右下角「回到底部」按钮或手动滑到底部，立即退回实时层视图，按钮不因离线死锁。
- [ ] **持续输出不抢视口与输入自动归位（`IOSHIST-003`）**：向上滑至历史中部停留，同时远端每秒持续输出新行；确认手机阅读视口稳定不动且 `scrolledBack == true`（不误触发完成通知已读），点击「回到底部」或通过 Composer 发送一条新指令后立即切回实时层底部并展示最新输出。
- [ ] **全屏鼠标应用直通与多分屏隔离（`IOSHIST-004`、`IOSHIST-005`）**：在 `tmux` 内打开启用鼠标追踪的全屏应用（`owner == "application"`），确认上滑不切入本地历史层而是正常驱动应用内滚动；在含两个分屏的终端切换活跃分屏后上滑，确认只展示当前分屏自己的历史，绝不残留上一分屏内容。
