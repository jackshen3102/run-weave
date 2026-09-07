# iOS Swift 原生迁移可行性评估

评估日期：2026-09-05。代码基线：`26a3d821`。状态：保留实施前评估与方案演进；用户已授权按独立 package 计划实施。当前事实以 [执行记录](./2026-09-06-ios-native-p0-p1-execution.md) 为准，本文下列“本轮”指评估阶段。

## 结论与范围

当前 App 迁移为 Swift 原生客户端可行。推荐 SwiftUI/UIKit 承载界面与客户端状态，第一阶段通过局部 WKWebView 复用终端渲染。没有发现必须依赖桌面 Web 页面才能运作的核心业务链路。

同日补充业界调研后，验证顺序进一步明确：先用 SwiftTerm 与现有 xterm 做小范围比较，再决定首版终端是否保留 WebView；不能仅凭“原生终端复杂”提前排除成熟原生库。详见文末补充。

本评估按替换 `app/` 移动客户端、保留电脑上的 Backend/PTY/tmux/Agent 执行方式理解需求。不包括将电脑运行时移到 iPhone、桌面 Browser 工具移植、Android 重写或新增远程推送服务。若主要目标只是修复某个卡顿、键盘或录音问题，先在现有 Capacitor 架构内做定点优化会更便宜；目前尚无测量证明整体重写是解决这些问题的必要条件。

## 当前事实

- [App 路由](../../app/src/routes/AppRoutes.tsx)只有 Login、Home、Terminal 三个主入口；Terminal 内包含 Chat、Changes、Files 及弹层。
- 当前工作树 `app/src` 有 77 个 TS/TSX/CSS 文件，共 12,085 行；`app/ios/App/App` 有 3 个 Swift 文件，共 169 行；终端 renderer 的 4 个 TS/TSX/CSS 文件共 481 行。数字包括空行和注释，不包括第三方依赖，也不能直接换算工期。
- [原生入口](../../app/ios/App/App/AppViewController.swift)是 Capacitor bridge controller；[配置](../../app/capacitor.config.ts)加载随 App 打包的 `dist`。主要界面和业务状态目前在 React/Ionic 中。
- [App API](../../app/src/services/terminal.ts)直接调用 Backend 的首页聚合、项目、终端、input、interrupt、文件预览等接口。[认证客户端](../../app/src/services/auth.ts)使用 `X-Auth-Client: app` 和 Bearer token；[Backend](../../backend/src/routes/auth.ts)明确支持 body refresh token，不要求复用 Web Cookie 登录。
- [终端连接](../../app/src/hooks/use-app-terminal-connection.ts)获取临时 ticket 后连接 `/ws/terminal`。[Backend 输出](../../backend/src/ws/terminal-server.ts)发送 JSON 包裹的 snapshot/output，并非页面 HTML。[协议](../../packages/shared/src/terminal/runtime/websocket.ts)可以在 Swift 中实现。
- [全局事件连接](../../app/src/hooks/use-app-terminal-events-connection.ts)还维护 cursor、streamId、去重和重新同步。终端输出恢复与全局状态事件恢复是两个不同合同。
- [终端显示入口](../../app/src/components/terminal/panels.tsx)使用 xterm、`renderer="dom"`、5,000 行 scrollback；[renderer](../../packages/terminal-renderer/src/TerminalRenderer.tsx)不负责后端连接。这为局部嵌入提供了边界，但尚没有可直接嵌入原生的独立 HTML 入口或 Swift bridge。
- 文件和 Diff 是 App 自身的轻量实现，并未嵌入桌面 Monaco：[文件预览](../../app/src/components/preview/file-drawer.tsx)、[Diff](../../app/src/components/preview/diff.tsx)。它们可以迁到 Swift，不是必须保留 Web 的部分。
- [安全凭据插件](../../app/ios/App/App/RunweaveSecureCredentialsPlugin.swift)已经使用 Keychain；[连接列表](../../app/src/store/use-app-connection-store.ts)保存在 WebView localStorage；[原生凭据适配](../../app/src/store/app-auth-credential-store.native.ts)按 connectionId 保存认证。升级时需要显式迁移两类存储。
- [本地通知服务](../../app/src/services/notifications.ts)存在，但本次在 `app/src` 未找到其业务调用，不能把它算作已经交付的终端完成推送。

## 建议的职责分配

| 能力                                   | 目标归属                           | 迁移难度与原因                                        |
| -------------------------------------- | ---------------------------------- | ----------------------------------------------------- |
| 登录、多电脑连接、首页、导航、设置     | SwiftUI                            | 中；UI 简单，凭据隔离和异步切换语义必须保持           |
| HTTP、WebSocket、token 刷新、设备状态  | Swift                              | 中高；现有协议可复用，连接状态机要重写                |
| Composer、快捷键、图片选择、录音、分享 | SwiftUI/UIKit 与系统 API           | 中；输入体验收益明确，仍须遵循原有提交语义            |
| 终端输出、ANSI/TUI、触摸滚动           | 首阶段 WKWebView + 现有 xterm      | 高；保留终端兼容性，将原生桥接作为独立工作            |
| 文件树、搜索、Changes 列表、图片预览   | Swift                              | 中；复用 project-scoped API                           |
| Markdown、Diff 内容                    | 初期可保留局部 Web，之后按体验决定 | 中；主要是迁移成本选择，并非技术硬依赖                |
| 诊断记录与导出                         | Swift，汇集 Web renderer 错误      | 中；需要跨 Swift/JS 的连接与会话关联信息              |
| 未来网页或 HTML 预览                   | 隔离的 WKWebView                   | 当前不作为已存在能力；不得复用带终端输入权限的 bridge |

目标链路：Swift 界面 → Swift 连接/认证/会话服务 → HTTP/WebSocket → 现有 Backend。Swift 会话服务另外通过受限消息桥驱动本地 Web 终端视图。Backend 继续拥有 PTY/tmux 和 Agent 生命周期。

推荐原生统一拥有认证、连接和当前 session；Web 只保留 renderer 及必要触摸逻辑。桥接至少覆盖 ready、reset/snapshot、write、resize、input、scroll、dispose，并携带连接/session 实例标识以拒绝旧页面回调。持续输出应有有界缓冲、批量传输和渲染完成反馈；溢出后重新同步，而非无限排队或悄悄丢弃 ANSI 流。不要逐字符调用 JS，不要把终端输出拼成可执行 JavaScript。

Web 资源随 App 打包，无须打开电脑上的桌面网页。原生可以用 [URLSessionWebSocketTask](https://developer.apple.com/documentation/foundation/urlsessionwebsockettask)处理 WebSocket，Web/原生消息通信有 [WKScriptMessage](https://developer.apple.com/documentation/webkit/wkscriptmessage)等平台机制支持。具体吞吐量和键盘表现仍须实机证明。

## 主要风险，按严重程度排列

### P1：终端兼容性不能等同于文字显示

定位：[panels.tsx](../../app/src/components/terminal/panels.tsx)、[触摸行为](../../app/src/lib/app-terminal-touch-behavior.ts)、[renderer 合同](../../packages/terminal-renderer/src/terminal-renderer-types.ts)。

ANSI 控制序列、全屏 TUI、光标定位、宽字符、窗口 resize、历史滚动与 tmux copy mode 都在范围内。换原生文字列表无法保持当前能力；仅把外层界面改成 Swift 也不能保证解决 xterm 输出瓶颈。优先保留 xterm，在相同数据流与设备上比较输入延迟、输出积压、滚动及内存。

全原生终端可以单独评估 [SwiftTerm](https://github.com/migueldeicaza/SwiftTerm)，该项目提供 iOS UIKit TerminalView；应接现有 Runweave WebSocket，不因示例使用 SSH 就改后端协议。尚未验证其与当前 CLI、tmux、snapshot、Unicode 和 resize 行为的兼容性。

### P1：双份连接与状态会产生可见错误

定位：[use-app-session.ts](../../app/src/hooks/use-app-session.ts)、[终端连接](../../app/src/hooks/use-app-terminal-connection.ts)、[事件连接](../../app/src/hooks/use-app-terminal-events-connection.ts)。

若整页 AppTerminalPage 继续嵌入 Web，同时 Swift 又管理登录、socket 和输入，则会出现两份 token 刷新、重连、缓存和 session 选择逻辑。目标架构应有单一原生所有者。过渡期如果必须保留整页，则让整页独占该会话的业务控制，避免两个 owner 同时工作。

全局 terminal-events 支持游标/stream 重同步；终端字节输出采用 snapshot + 增量，当前输出协议没有可用于逐条 ACK 的持久序号，不应承诺任意断线后无损逐字节重放。foreground 恢复应重新同步状态和画面。

### P1：必须保留提交语义与多电脑隔离

定位：[输入操作](../../app/src/hooks/use-app-terminal-actions.ts)、[缓存 scope](../../app/src/features/query/app-query-provider.tsx)、[凭据存储](../../app/src/store/app-auth-credential-store.native.ts)。

普通文本走 input API，快捷键走原始 WS，Stop 以后端状态为准；图片上传返回 shell-quoted 路径，语音返回文字，二者都等待用户发送。离线输入不能恢复后自动执行；网络错误不能当作注销。连接切换必须隔离凭据、请求结果、Web 回调和缓存，不能沿用旧 terminalSessionId。非幂等输入在超时结果不明时不得盲目重试。

### P1：Swift 不解除 iOS 后台限制

定位：[设备连接生命周期](../../app/src/hooks/use-app-device-connection.ts)、[本地通知服务](../../app/src/services/notifications.ts)。

[Apple 的后台执行说明](https://developer.apple.com/forums/thread/685525)明确限制通用后台常驻。原生迁移应设计进入前台后的恢复流程。若要求 App 挂起后收到新产生的远端 Agent 完成事件，需要另建 APNs 事件投递链路；已交给系统调度的本地通知是另一回事。远程推送不属于 Swift 改写自然附带的能力，也不应承诺绝对送达。

### P2：协议、旧数据与发布将形成长期维护面

定位：[shared WS 合同](../../packages/shared/src/terminal/runtime/websocket.ts)、[认证](../../app/src/services/auth.ts)、[Keychain 插件](../../app/ios/App/App/RunweaveSecureCredentialsPlugin.swift)、[iOS 工程](../../app/ios/App/App.xcodeproj/project.pbxproj)。

Swift 不能直接复用 TS 类型与 React hooks。需要 Swift Codable DTO 和明确序列化合同；长期宜让可机读 schema 驱动两端模型，但不必为第一版全量改写 shared。必须处理未知事件、可选字段以及不同版本的电脑后端，避免依赖前后端同步发布。

保持 Bundle ID、Keychain service/account/access group 连续，并迁移旧 WebView 连接列表；移除 Capacitor 前完成过渡导入。工程当前声明 iOS 15.0，选原生 API 和最低版本需另行确认实际工具链/依赖支持。局域网权限、ATS、TLS 和真实设备连接均需验证。Swift 不解决外网到电脑的网络可达性，也不能直接搬用 Electron Browser 控制能力。

## 路线与成本估算

以下为工程判断，置信度中低，不是排期承诺。假设一位熟悉 Swift/UIKit/WebKit 和当前协议的全职工程师，功能范围保持当前 App，Backend 基本不变；不包括 APNs、联网中继、Android、完整 IDE、App Store 等待时间。

| 路线                                                             | 粗估工作量                                                | 判断                               |
| ---------------------------------------------------------------- | --------------------------------------------------------- | ---------------------------------- |
| 保留 Capacitor，优化明确的键盘/录音/滚动问题                     | 确定根因后按单点估算，通常显著少于重写                    | 若目标只是若干体验问题，先选此路线 |
| Swift 主体 + 局部 Web 终端，达到当前主要功能并完成设备稳定性验证 | 约 8–12 人周，包含下列技术验证                            | 当前推荐                           |
| Swift 主体 + 原生终端                                            | 上述基础上预留约 3–6 人周兼容性验证与适配；不兼容时需重估 | 暂不绑定为首版目标                 |

先用 1–2 人周做纵向技术验证：登录 → 首页 → 一个真实终端 → 原生输入 → 锁屏/恢复；同时测量本地 xterm 桥接吞吐和内存。通过后再做多连接隔离、文件/Changes、媒体与诊断，最后做旧版本升级迁移和设备稳定性验证。不要先迁完所有静态页面才发现终端方案不成立。

验证重点为既有真实用例：中文输入与多行/斜杠命令、Ctrl-C/Tab、图片和语音待确认输入、高输出量与长历史、pty/tmux/TUI、软硬键盘和旋转、多电脑同名项目/终端隔离、网络中断和恢复、token 过期、后端重启、Web 内容进程重建、旧安装态升级。按仓库规则使用现有验证与必要人工/实机取证，不新增单元测试。

## 本轮证据边界与待讨论项

本轮完成源码、协议链路和平台一手资料评估；没有运行 Swift 原型、iOS 构建、浏览器或真机验收，不作性能提升承诺。历史模拟器构建问题不作为本次可行性阻断，因为未在当前环境复核。

后续最有价值的范围确认是：原生化首先要改善输入/导航/系统集成，还是核心诉求在终端渲染性能？前者支持推荐混合路线；后者应先对比 xterm 与原生终端实测，再决定全量迁移。iOS 是否成为唯一移动平台会影响长期维护成本。

## 同日补充：业界终端方案调研

本节查阅项目官网、官方仓库、实际源文件和 release；没有安装或实测第三方 App。产品宣称的流畅程度不作为 Runweave 性能证明。

### 路线一：SwiftTerm 原生组件，首选验证

[SwiftTerm](https://github.com/migueldeicaza/SwiftTerm)提供终端模拟内核和 iOS UIKit TerminalView，采用 MIT 许可证。项目列出 Secure ShellFish、La Terminal 等使用者；[La Terminal 官网](https://la-terminal.net/)也直接确认基于 SwiftTerm。已有商业产品采用，比只有演示项目更有参考价值。

查阅 [v1.19.0 iOSTerminalView.swift](https://github.com/migueldeicaza/SwiftTerm/blob/v1.19.0/Sources/SwiftTerm/iOS/iOSTerminalView.swift)，可以确认原生滚动视图、输入法相关处理，以及通过 `setUseMetal` 显式开启的 Metal renderer；不能把 SwiftTerm 简化成仅有 CPU 绘制的方案。[delegate](https://github.com/migueldeicaza/SwiftTerm/blob/v1.19.0/Sources/SwiftTerm/Apple/TerminalViewDelegate.swift)提供输入发送和尺寸变化回调，传输方式由宿主决定。

对 Runweave 的接入判断：保持现有 ticket + WebSocket，把 output 交给终端，snapshot 到达时重置并恢复画面；delegate 输出转换为既有 input/resize 消息。Composer 的 HTTP 提交语义保持独立。示例使用 SSH 不代表库要求 SSH，没必要更换 Backend。

[发布页](https://github.com/migueldeicaza/SwiftTerm/releases)在本次查询时将 v1.19.0 标为 Latest、v1.20.0 标为预发布，并提及随后会有破坏性变更；版本应固定，不能把 main 与稳定版本能力混为一谈。近期 release 包含 iOS 选择 API、VoiceOver、输入与渲染修复，说明维护持续进行，但不能据此保证零兼容性问题。

例如 [issue #494](https://github.com/migueldeicaza/SwiftTerm/issues/494)仍显示 Open，报告缩窄终端时重排出现重复行；报告环境是 macOS。这是应加入验证的场景，并非本轮已复现的 iOS 缺陷。

### 路线二：原生宿主 + Web 终端，成熟的备选

[Blink 官方仓库](https://github.com/blinksh/blink)说明采用 hterm；实际 [TermView.m](https://github.com/blinksh/blink/blob/raw/Blink/Terminal/TermView.m)创建 WKWebView、加载本地 HTML，并通过消息和 JavaScript 调用连接原生能力，包含输出缓冲和队列处理。

这证明局部 Web 终端是已有产品采用的路线。对 Runweave 的合理借鉴是保留现有 xterm、改善宿主输入/键盘/生命周期和桥接批处理；不因 Blink 使用 hterm 就新增一次终端引擎迁移。Blink 产品代码与独立终端库的许可证不同，不能将“借鉴架构”等同于“直接复制整套产品”。

### 路线三：Ghostty 内核 + 原生 Metal，值得保留的第二原生候选

[Rootshell](https://github.com/kitknox/rootshell)是面向 iPhone/iPad 等 Apple 平台的开源终端，使用 libghostty 和 Metal。其 [GhosttySurface.swift](https://github.com/kitknox/rootshell/blob/main/rootshell/Core/Ghostty/GhosttySurface.swift)封装 C surface API，UI 目录另有输入法、滚动、手势和会话适配。这是可查源码的实现参考，不只是概念演示。

需要区分上游和下游：[Ghostty 官方 README](https://github.com/ghostty-org/ghostty#cross-platform-libghostty-for-embeddable-terminals)说明 `libghostty-vt`负责解析控制序列和维护终端状态，API 仍在变化；它不等于现成的完整 iOS TerminalView。Rootshell 使用 [ghostty-rootshell](https://github.com/kitknox/ghostty-rootshell)，该 fork 明确包含尚未进入上游的 iOS、渲染和专有 API 适配。

其 [GhosttyKit 包](https://github.com/kitknox/ghosttykit-rootshell)提供二进制 Swift package 和公开源码构建入口；[Package.swift](https://github.com/kitknox/ghosttykit-rootshell/blob/main/Package.swift)当前声明 iOS 17，与 Runweave 工程声明的 iOS 15 不同。这是该分发包的门槛，不能泛化成所有 Ghostty 路线的最低版本。

此路线可以做原生应用，但终端核心是 Zig/C ABI，不符合“所有依赖都必须是 Swift”的额外要求。我的判断是其下游适配、二进制构建和版本跟进工作高于直接接 SwiftTerm，应在 SwiftTerm 实测不能满足要求时进一步投入。

### 传输与渲染必须分开选型

[Mosh](https://mosh.org/)处理移动网络漫游和状态同步，属于连接协议；tmux 则承担远端会话持久化/复用。它们不替代终端 renderer，也不天然解除 iOS 的进程挂起限制。Runweave 已有电脑端会话与 WebSocket，首轮更换 renderer 不应顺带引入 SSH/Mosh。

### 下一步建议

先制作仅承载单个现有终端的 SwiftTerm 验证页面，与当前 xterm 使用相同输出负载和同型号设备比较。可回放固定输出比较渲染；真实交互分别验证，避免两个视图同时 resize 同一 PTY 干扰结果。

优先覆盖中文/emoji、Codex 等真实 TUI、tmux copy mode、软硬键盘、横竖屏重排、长历史选择复制、高输出持续运行、snapshot 恢复和锁屏返回。记录丢字/错位、输入到显示延迟分位数、帧耗时、内存与输出积压。SwiftTerm 满足要求则采用原生；不满足时保留 xterm，Ghostty 为进一步候选。当前不建议自写 ANSI 解析器和终端绘制系统，也没有证据给三条路线做可靠的性能排名。
