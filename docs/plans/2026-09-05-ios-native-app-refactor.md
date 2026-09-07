# iOS 原生 App 独立 Package 重构计划

状态：执行中。P0 已完成，P1 已接通真实 tmux；IOSTERM-001～004 通过，真机门禁尚未通过。执行结果见 [P0/P1 记录](../review/2026-09-06-ios-native-p0-p1-execution.md)。
粒度：L3。基线：`26a3d821`，实施前记录实际 HEAD 与工作区差异。

用户推进决定（2026-09-06）：用户报告手动验证无问题，并明确要求继续按 1 比 1 功能与行为迁移。允许继续 P2～P5 实现；历史未执行用例仍保留原 verdict，用户反馈不替代未测性能、最低 OS 等证据。遇到需要改变旧行为的改进，先列具体差异与用户确认。

## 1. 目标与完成定义

新增 `packages/app-ios/`，以 SwiftUI/UIKit 重写移动客户端，优先使用 SwiftTerm 原生终端；保留 `app/` Ionic/Capacitor 客户端作为可运行对照。新旧 App 能独立构建、并行安装、分别登录同一 Backend，按功能映射定位行为差异。

本计划完成意味着：原生候选 App 覆盖下述当前移动端功能，所有 required 用例有真实证据，新旧对比可追溯，旧 App 保持可用。并行安装阶段不替换正式 App、不删除旧代码、不迁移旧凭据。后续正式 Bundle ID 切换与存量用户升级另立发布任务，不能把“卸载旧 App”当作本次收尾。

用户可见范围：登录、连接管理、Home 项目与终端列表、创建项目/终端、终端实时输出、Composer/快捷键/Stop、历史复制、图片与语音辅助输入、Chat/Changes/Files、只读文件与 Diff、图片查看、主题、诊断导出与既有诊断服务对接。

不包括：手机运行本地 PTY/tmux/Agent、SSH/Mosh 替换、Electron Browser、完整 IDE/文件写入、Android、新增 APNs 服务、自写终端模拟器、全量 TS 协议生成体系。现有本地通知服务尚未发现 App 业务调用，不将后台完成推送假定为既有功能，也不在本次接入新通知产品流程。

## 2. 已核实事实与不确定性

| 事实                                                    | 当前代码依据                                                                                                                        | 对计划的影响                                                  |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| App 是独立 API 客户端，主路由为 Login/Home/Terminal     | [路由](../../app/src/routes/AppRoutes.tsx)、[API](../../app/src/services/terminal.ts)                                               | 重写客户端，不搬桌面 Web 布局                                 |
| App 登录走 body refresh token、Bearer token             | [auth.ts](../../app/src/services/auth.ts)、[Backend auth](../../backend/src/routes/auth.ts)                                         | Swift 直接实现协议，无需复用 Web Cookie                       |
| Backend 在 PTY 内运行 tmux attach                       | [launcher.ts](../../backend/src/terminal/runtime/launcher.ts)                                                                       | 实时输出可输入原生终端模拟器                                  |
| WS 有 snapshot/output，tmux snapshot 来自近期输出缓冲   | [WS helper](../../backend/src/ws/terminal-server-connection-helpers.ts)、[registry](../../backend/src/terminal/runtime/registry.ts) | 最多 64×1024 字符的尾部不是完整状态序列化；恢复是阻断性验证点 |
| 同一 runtime 接收客户端 resize                          | [input handler](../../backend/src/ws/terminal-input-handler.ts)                                                                     | 新旧客户端不得同时争抢同一 PTY 尺寸                           |
| 全局事件有 cursor、streamId、重同步逻辑                 | [events hook](../../app/src/hooks/use-app-terminal-events-connection.ts)                                                            | 与终端输出恢复分开实现和验收                                  |
| Native 凭据在 Keychain，连接列表在 WebView localStorage | [凭据适配](../../app/src/store/app-auth-credential-store.native.ts)、[连接 store](../../app/src/store/use-app-connection-store.ts)  | 并行安装使用独立存储，禁止暗中读取/清理旧数据                 |
| 终端 renderer 与 socket 已分离                          | [renderer](../../packages/terminal-renderer/src/TerminalRenderer.tsx)                                                               | 原生失败时存在复用 xterm 的明确退路                           |

环境只读检查（2026-09-05）：`xcodebuild -version` 返回 Xcode 26.6/17F113；`xcrun simctl list runtimes` 包含 iOS 26.5、26.2 与 18.x。历史缺少 iOS 26.5 runtime 的问题不再作为当前阻断依据。这是实施前记录；2026-09-06 已完成模拟器构建/运行和真机 Profile 签名构建，真机运行尚未验收，详见执行记录。

依赖初始候选固定 SwiftTerm `1.19.0`，执行时记录 tag 对应 commit；[manifest](https://github.com/migueldeicaza/SwiftTerm/blob/v1.19.0/Package.swift)声明 Swift tools 6.0、iOS 14。新 App 暂按现有 iOS 15 最低版本设计；编译不代表低版本运行验证。不要为了匹配本机 simulator 擅自提高 deployment target。无法获取 iOS 15 设备/runtime 时保留低版本运行 gate 为 blocked，不宣称已支持验证。

## 3. 新 Package 组织与旧代码隔离

一个仓库 package：`packages/app-ios/`，工作区名称 `@runweave/app-ios`。`packages/*` 已被 pnpm workspace 覆盖，无需修改 workspace 列表。

Swift Package 承载业务库；可安装的 iOS App 必须另有 Xcode app target，不能只交付一个无法安装的 `Package.swift`。两者都放在同一目录内，不再拆新仓库或额外 workspace package。

目标结构（P0 与 P1 部分文件已创建；其余仍是实施目标，以 package 当前文件和映射状态为准）：

```text
packages/app-ios/
  AGENTS.md
  README.md
  package.json                   # private，仅暴露显式 ios:* 与 mapping:check
  Package.swift                  # RunweaveIOS library target + 固定 SwiftTerm
  Sources/RunweaveIOS/
    App/                         # RootView、AppRouter、AppEnvironment
    Contracts/                   # Auth/Home/Terminal/Event/Preview/Voice/Diagnostics DTO
    Services/                    # APIClient、AuthenticationService、DeviceHealthService
    State/                       # ConnectionStore、CredentialStore、AppSession、ScopedCache
    Features/Home/               # HomeView、ProjectActions
    Features/Terminal/           # SessionController、EventStream、InputService
    Features/Terminal/Rendering/ # TerminalSurface、SwiftTermSurface、TerminalHostView
    Features/Terminal/Input/     # ComposerView、ShortcutBar、TerminalGestures
    Features/Preview/            # FilesView、ChangesView、FilePreview、DiffView、ImagePreview
    Features/Media/              # ImageUploadService、VoiceRecorder、VoiceService
    Features/Diagnostics/        # DiagnosticRecorder、DiagnosticExport、DiagnosticService
  ios/RunweaveNative.xcodeproj/   # 提交 shared scheme: RunweaveNative
  ios/RunweaveNative/            # @main、Info.plist、Assets、可移植 xcconfig
  ios/Diagnostics/              # 仅内部 Debug/Profile 构建的重放/计量与无敏感 fixture
  scripts/ios.mjs                # doctor/build/run，调用 xcodebuild/xcrun，无业务逻辑
  scripts/check-mapping.mjs      # 仅检查映射文件、源码路径和 case 引用
  docs/legacy-map.json           # 可检查的映射真相
  docs/migration-map.md          # 按功能解释差异及定位方式
  docs/decisions.md              # 已完成技术验证的结论与取舍
```

`package.json` 不声明泛用 `build/lint/typecheck/test`，避免现有 `pnpm -r build` 在非 macOS 环境隐式触发 Xcode。显式命令为 `ios:doctor`、`ios:build`、`ios:run`、`mapping:check`；README 解释原生编译不是 TS typecheck。Xcode 提供 Debug、Profile、Release；Profile 使用 Release 优化但启用内部诊断入口，正式 Release 排除 fixture 与故障注入。新包的 AGENTS 规定不导入旧 App 实现、不引用 Backend/Electron 内部实现、不新增单元测试。

构建产物、DerivedData、SPM checkout/cache 放在 Git 忽略的 `.runweave/ios-native-build/` 下；验证输出放 `.runweave/ios-native-evidence/`。实施前核实 ignore，必要时只补这两个路径，禁止把依赖源码纳入架构扫描。

新 App 名称 `Runweave Native`，Bundle ID `com.runweave.app.native`；Keychain service、UserDefaults、文件目录与旧 App 分离。不得复用旧 refresh token 或扩大 Keychain access group。首次连接手动配置并单独登录；卸载候选 App 或退出它，不影响旧 App 的安装态。

## 4. 新旧代码映射与排障约定

`legacy-map.json` 每行至少包含稳定 `id`、`feature`、`legacyPaths`、`nativePaths`、`contractPaths`、`api`、`caseIds`、`status`、`evidencePath`、`baselineCommit`、`sourceHashes`。状态为 planned/implemented/verified/deferred；verified 必须有 case verdict 和证据路径。缺失证据的功能不得仅靠文件存在升级为 verified。

`mapping:check` 检查旧路径、合同路径、case ID 始终存在；planned native 路径允许尚未创建，implemented/verified 必须存在。旧源码或合同 hash 变化时将该行报告为 stale，要求补充差异检查后更新基线；不得自动刷新 hash 掩盖漂移。不在产品 UI 展示这些实现细节。

下表是初始映射，实施时扩展到覆盖所有范围内功能；旧路径以 `app/` 或 `packages/` 开头时相对仓库根，其余相对 `app/src/`；Native 路径相对于新包的 `Sources/RunweaveIOS/`。落盘到 JSON 时全部展开为仓库根相对路径：

| ID     | 旧代码入口                                                                                           | Native 归属                                                                          | 主要用例                                 |
| ------ | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------- |
| MAP-01 | `app/src/App.tsx`、`routes/AppRoutes.tsx`                                                            | `App/RootView.swift`、`App/AppRouter.swift`                                          | IOSSESSION-001、005                      |
| MAP-02 | `services/http.ts`、`services/api-failure.ts`                                                        | `Services/APIClient.swift`、`Contracts/APIError.swift`                               | IOSSESSION-002、003、006、007、008、015  |
| MAP-03 | `services/auth.ts`、`hooks/use-app-session.ts`                                                       | `Services/AuthenticationService.swift`、`State/AppSession.swift`                     | IOSSESSION-001、002、003                 |
| MAP-04 | `store/use-app-connection-store.ts`、`store/use-auth-store.ts`                                       | `State/ConnectionStore.swift`                                                        | IOSSESSION-004、005、014                 |
| MAP-05 | `store/app-auth-credential-store.native.ts`、`app/ios/App/App/RunweaveSecureCredentialsPlugin.swift` | `State/CredentialStore.swift`                                                        | IOSSESSION-001、004、014                 |
| MAP-06 | `hooks/use-app-device-connection.ts`、`services/device-health.ts`                                    | `Services/DeviceHealthService.swift`                                                 | IOSSESSION-006、009、010                 |
| MAP-07 | `pages/HomePage.tsx`、`lib/terminal-home-view-model.ts`                                              | `Features/Home/HomeView.swift`                                                       | IOSSESSION-010、011、012、013            |
| MAP-08 | `hooks/use-app-terminal-events-connection.ts`、`hooks/use-app-session-events.ts`                     | `Features/Terminal/EventStream.swift`                                                | IOSSESSION-011、012                      |
| MAP-09 | `hooks/use-app-terminal-connection.ts`、`features/terminal/app-terminal-runtime.tsx`                 | `Features/Terminal/SessionController.swift`                                          | IOSTERM-002、006、007、008、011          |
| MAP-10 | `packages/terminal-renderer/src/TerminalRenderer.tsx`、`app/src/components/terminal/panels.tsx`      | `Features/Terminal/Rendering/SwiftTermSurface.swift`                                 | IOSTERM-002、003、004、009、010          |
| MAP-11 | `lib/app-terminal-touch-behavior.ts`、`components/terminal/shortcut-bar.tsx`                         | `Features/Terminal/Input/TerminalGestures.swift`、`ShortcutBar.swift`                | IOSTERM-005、IOSFEATURE-002              |
| MAP-12 | `components/terminal/composer.tsx`、`hooks/use-app-terminal-actions.ts`                              | `Features/Terminal/Input/ComposerView.swift`、`Features/Terminal/InputService.swift` | IOSFEATURE-001、002、003、IOSSESSION-009 |
| MAP-13 | `components/terminal/history-modal.tsx`                                                              | `Features/Terminal/HistoryView.swift`                                                | IOSFEATURE-004                           |
| MAP-14 | `components/terminal/files-tab.tsx`、`components/preview/file-drawer.tsx`                            | `Features/Preview/FilesView.swift`、`FilePreview.swift`                              | IOSFEATURE-007、008                      |
| MAP-15 | `components/terminal/changes-tab.tsx`、`components/preview/diff.tsx`、`lib/mobile-diff.ts`           | `Features/Preview/ChangesView.swift`、`DiffView.swift`                               | IOSFEATURE-009                           |
| MAP-16 | `components/preview/zoomable-image.tsx`、`packages/common/src/terminal/`                             | `Features/Preview/ImagePreview.swift`                                                | IOSFEATURE-010                           |
| MAP-17 | `hooks/use-app-terminal-actions.ts` 图片分支                                                         | `Features/Media/ImageUploadService.swift`                                            | IOSFEATURE-005                           |
| MAP-18 | `lib/voice-recorder.ts`、`services/voice.ts`                                                         | `Features/Media/VoiceRecorder.swift`、`VoiceService.swift`                           | IOSFEATURE-006                           |
| MAP-19 | `features/query/app-query-provider.tsx`、`store/use-app-terminal-ui-store.ts`                        | `State/ScopedCache.swift`、`Features/Terminal/TerminalUIState.swift`                 | IOSSESSION-005                           |
| MAP-20 | `features/support-logs/`、`services/diagnostic-logs.ts`                                              | `Features/Diagnostics/`                                                              | IOSFEATURE-011                           |
| MAP-21 | `store/use-theme-store.ts`                                                                           | `State/ThemeStore.swift`                                                             | IOSFEATURE-012                           |

诊断事件统一包含 `client=native-ios`、appVersion、backendVersion（后端未提供时为 unknown）、renderer/version、connectionId、terminalSessionId、connectionGeneration、事件名、单调时间、requestId/operationId（可用时）。记录收包/入队/消费尺寸、resize、snapshot、切换与重连原因；默认不记录命令正文、终端内容、票据或 token。原始流仅允许在无敏感的专用 fixture 会话中显式捕获。

排障顺序：按 MAP ID 找旧逻辑 → 固定 Backend/fixture/尺寸 → 比较收到的协议与状态 → 比较 renderer。相同输入流不同画面优先定位 renderer；两端都错优先查 Backend/合同；只在恢复后错优先查 snapshot/事件游标；只在切电脑后错优先查 generation/缓存。不能通过复制旧实现绕过尚未理解的语义。

## 5. 状态、协议与安全合同

### 5.1 单一状态所有者

- Swift `AppSession` 拥有 active connection、认证、设备在线状态；每个活动终端由一个 `SessionController` 拥有 socket 和 renderer 生命周期。
- 网络服务用可取消任务/actor 管理并发，UI 更新归 MainActor。不能从后台线程直接操作 UIKit/SwiftTerm；renderer 的解析/绘制线程规则以锁定版本验证结果为准。
- `ConnectionContext` 至少为 connectionId、normalizedBaseURL、generation；终端任务另含 terminalSessionId。切换/编辑地址/注销递增 generation，取消旧任务，丢弃旧响应、过期 token 更新和 Web 回调。
- 缓存 scope 至少含 connectionId + baseURL + auth session；连接/认证切换不得展示上一身份文件。默认复用旧缓存语义：读取 15 秒 stale、30 分钟回收、mutation 不自动 retry，可因内存压力更早回收。
- terminal runtime 状态 running/exited、Agent TerminalState、设备 online/offline 三者独立。Stop 是否显示依据后端 agent_running，不因请求成功乐观改 idle。

### 5.2 HTTP 与认证

- 复用现有 `/api/auth/login|refresh|verify|logout`、`/api/app/home/overview` 和 `services/terminal.ts` 全部范围内 API；登录/刷新保留 `X-Auth-Client: app`，业务请求使用 Bearer。
- 每个连接独立 Keychain 凭据；refresh single-flight。读请求遇到 401 可在刷新成功后重发一次；明确 refresh 认证失效才清理对应连接。网络超时/5xx 保留凭据，403 显示权限错误，404 显示资源不存在，不能统统注销。
- 写请求超时结果不明时保留草稿并显示“发送结果未确认”；禁止盲目自动重发。保留已有 operationId 的关联语义；不自行宣称跨网络 exactly-once。
- URL 只接受 http/https，移除 query/hash 并保留合法路径前缀；不记录内嵌凭据。原生 TLS/ATS/局域网权限必须真实验证，不能通过全局放开 ATS、跳过证书校验取得假通过。

### 5.3 终端数据与 renderer 适配

- `TerminalSurface` 只管理显示：prepare/reset/feed/setViewport/setActive/dispose；回调 rawInput、viewportChanged、bell、scrollState。API 可微调命名，但不让 surface 持有 refresh token 或创建 Backend session。
- `connected/snapshot/output/metadata/status/exit/error` 按现有 shared 联合类型解码；输入发送 `input/resize/signal/request-status`。JSON 解码一次后保留 ESC、换行与 UTF-8 内容，不能 strip ANSI 或把分包当作完整控制序列边界。
- snapshot 重置画面后按序接增量；metadata HTTP scrollback 不能在 WS 新画面之后覆盖 renderer。未知事件可记录忽略；已知事件字段无效显示协议错误，不吞错或循环重连。id/cursor 当作不透明字符串，不转为浮点数比较。
- tmux 实时显示继续走 attach 输出，不改成轮询 capture-pane。`capture-pane` 历史文本只用于历史审阅，不能冒充完整当前状态。回到终端底部需保留退出 tmux copy mode 的后端输入语义。
- 原生输出队列设 1 MiB 高水位，按真实消费释放；无法及时消费时停止追加并标记需要重同步，禁止截断 ANSI 后继续伪装正常。G2 未证明安全重同步前，此路径只能明确报错，不能启用无限自动恢复。
- resize 去重、合并同一布局周期的更新；禁止发送 0×0。记录 rows/cols 与像素尺寸用于排查，不把字体差异误判为协议缺陷。
- Composer 普通文本为 line，Codex 且 trimStart 后以 `/` 开头时为 codex_slash_command；控制键走 raw WS。离线禁止写入，也不保存待恢复后发送的队列。图片上传只插入 shell-quoted 路径，语音只追加文字；最终由用户发送。

### 5.4 TS/Swift 合同映射

Swift Codable DTO 由 `packages/shared` 现有 exports 对应源码驱动人工实现；记录字段、null/缺省、联合类型 discriminant 与单位。不得在 shared 放 Swift 或 Backend 实现，不把 React 实现复制进 common。第一阶段通过真实 HTTP/WS fixture 及映射漂移检查证明合同一致，不搭全仓代码生成平台。

### 5.5 WebView 的使用边界

默认范围内页面和预览使用 Swift；Markdown/Diff 先保持旧 App 的轻量能力，不要求桌面级渲染。仅当技术 gate 证明原生方案不可接受时，考虑在新包内建立局部 xterm Web 入口，复用 `@runweave/terminal-renderer` 而非复制生命周期。

该条件分支须在 decisions 中记录失败 case、成本和选定方案后更新本计划与对应 YAML；不悄悄改成整页旧 App 嵌入。若采用局部 Web，Swift 仍独占认证/socket，只向受信任本地页面传显示数据；输入桥验证来源、会话与 generation，任意 HTML/外链内容不能共享终端输入权限。Ghostty 不在第一轮同时集成。

## 6. 分阶段实施与阻断门禁

顺序为 P0 → P1 → P2 → P3 → P4 → P5。前一阶段的必需 gate 失败时，只允许定位该失败和准备独立文档，不能批量推进依赖该结论的页面迁移。

### P0：独立宿主、映射与构建底座

- [x] 创建上述 package、Swift library、Xcode host、shared scheme、独立标识与存储；不写个人 signing team。
- [x] 添加显式命令，记录源码/依赖版本、可用 SDK/runtime；通过 `-showdestinations` 选择已安装 simulator，不自动安装 SDK 或改变系统 Xcode。
- [x] 初始化 legacy-map，所有行 planned；实现路径/case/hash 检查，补新包 AGENTS、README。
- [x] 建立仅内部 Debug/Profile 构建的 TerminalProbe 页面：选择固定无敏感输出 fixture、显示接收/消费指标、导出诊断；不是 XCTest 或新的测试框架。正式 Release 排除 fixture、注入开关和 Probe 路由。
- [x] G0：IOSTERM-001 通过，证明新 App 可安装启动且旧 App 仍可启动；无法签名不改旧工程，标记对应设备验证阻塞。

### P1：先验证原生终端，不先迁完整页面

- [x] 实现最小 API/Auth/SessionController 和 SwiftTermSurface，手动配置测试 Backend，连接实际 tmux 会话。
- [ ] G1：IOSTERM-002～005 通过，覆盖真实流、尺寸、Unicode 与 tmux 交互。
- [ ] G2：IOSTERM-006～008 通过，分别证明断线、锁屏、进程重启后的恢复；刻意覆盖输出超过 Backend 64K 缓冲且处于 TUI 的会话。
- [ ] G3：IOSTERM-009～010 通过，分别验证 Metal 路径和持续输出性能；默认 renderer 由同设备对照结果决定。Metal 失败可显式选择通过验证的普通原生 renderer，仍须满足性能 gate。
- [ ] G4：IOSTERM-011 验证共享会话的客户端生命周期；IOSTERM-012 验证协议兼容处理。
- [ ] 写入 decisions：锁定版本、通过/失败/blocked case、实际设备、证据、性能表、选择原生/局部 Web 的理由。只画出文本不算 P1 完成。

G2 的特殊处理：若失败来自当前 snapshot 合同，先验证客户端 reset/顺序/generation；不能用重试掩盖缺失屏幕状态。确认是服务端缺口后，单独拆出最小 Backend/shared 恢复子任务并完成方案评审，再继续本阶段。需明确重绘/状态快照来源、与增量的边界、能力协商和旧客户端兼容；禁止向共享 PTY 注入破坏性 reset 来修复某一个客户端。首版不承诺任意断线的逐字节历史无损，只要求当前可见画面正确、后续交互可用、已确认操作不自动重放。

性能初始验收预算（设计要求，尚非实测结果）：同一物理设备、同字体/行列/scrollback、Release 优化级别的 Profile 构建、相同无敏感 fixture；旧端使用 production Web bundle。256 KiB/s ASCII+ANSI 持续 60 秒，收包到提交显示 p95 ≤100 ms，结束后 ≤2 秒排空；1 MiB 队列不溢出。10 分钟运行中，预热后第 2 分钟到第 10 分钟的内存增幅 ≤20%，无崩溃/热异常导致持续积压；同时记录绝对 RSS、峰值与旧 xterm 对照。输入本地 UI 反馈 p95 ≤100 ms，端到端 PTY 回显另记，不将网络时间算作 renderer 成本。预算失败后定位和重估，不能事后放宽阈值把失败改成通过；更改预算要留下变更理由与新评审结论。

### P2：认证、多连接、Home 和事件状态

- [x] 完成 AppSession、CredentialStore、ConnectionStore、DeviceHealthService、ScopedCache、EventStream；先实现 cancellation/generation，再接页面。
- [x] 登录、Home、连接新增/编辑/删除/切换、创建项目/终端、删除终端、状态事件更新接入原生页面。
- [ ] IOSSESSION-001～015 全部通过；真实故障在专用 Backend/会话上触发，禁止停止用户正在使用的后端。
- [ ] verified 映射覆盖 MAP-01～08、19；后端网络错误和认证错误分开取证。

本轮 P3/P4 已接入 Composer、快捷键、Stop、历史、媒体、预览、主题和诊断的主体实现，
真实认证失败/草稿恢复、文件搜索/源码/Markdown/Diff、横屏键盘发送已做定向冒烟。
后续已接入手势、缓存和诊断持久化；此前误列的终端输出图片打开不属于旧端能力。
完整门禁仍未完成，以下完成项不作为阶段全部通过声明。
详情见 [P3/P4 执行记录](../review/2026-09-06-ios-native-p3-p4-execution.md)。

### P3：终端完整交互与媒体

- [x] Composer、快捷键、Stop、历史复制和 Chat/Changes/Files 切换接入同一个 SessionController。
- [x] 图片使用系统选择器，经现有 clipboard-image API 上传；文件路径正确 shell quoting。
- [x] 录音使用系统音频能力，产出后端要求的 24 kHz WAV；处理拒绝权限、取消、中断、转写错误，均不自动发送。
- [ ] IOSFEATURE-001～006 通过，连同 IOSSESSION-009 验证离线写保护；迁移完成后重跑 IOSTERM-003/004/005，覆盖真实 Composer 布局改变。

### P4：只读预览、主题和诊断

- [x] 原生文件列表/搜索、Changes 列表、文件内容/轻量 Markdown/Diff、图片缩放，复用 project-scoped API。文件错误 404/413/415 分别可解释，无文件写入口。
- [x] Diff 保留旧算法的降级语义：总行数 >800 或乘积 >180,000 时不做昂贵全量 LCS；大文件不阻塞主线程。
- [x] 诊断记录、用户发起的导出、既有 start/stop/upload 服务对接与主题持久化完成。新包日志有 client/renderer 标识，不要求改旧 App 才能排障。
- [ ] IOSFEATURE-007～012 全部通过；更新剩余映射。旧代码缺陷只列出差异，不机械复制缺陷。

### P5：新旧对照、候选交付与保留旧版

- [ ] 执行三份 YAML 全部 required case，包括 IOSTERM-013 最低版本运行与 IOSTERM-014 普通 PTY 兼容，记录每个 verdict；任何 blocked 都使对应完成声明保持未完成。
- [ ] 在同一 Backend 基线下，旧 App 使用 `$toolkit:playwright-cli` 取真实 Web 页面行为证据；旧 iOS 和新原生 App 的键盘/手势/性能比较使用同设备顺序运行。原生视图不是 DOM，不能用 Playwright 声称已经验证原生 UI。
- [ ] 原生 UI 用 Xcode/Simulator 或真机人工操作取证，记录 build、设备、OS、步骤、结果；只有截图无动作/状态证据不算完成。缺少原生控制或真机时明确 blocked，不新增 XCTest 绕过仓库规则。
- [ ] 对照使用独立克隆 fixture 会话或固定流重放；同一 tmux 会话只允许一个交互/resize owner。共同缺陷必须记录，不能以“和旧版一样坏”取得通过。
- [ ] 同时验证当前 Backend 与 P0 固定的旧基线版本（相同版本时记录），不假定 App 和电脑总同步升级。
- [ ] 候选 App 与旧 App 并存交付；停止候选客户端即可回到旧版，不删除远端会话或清理旧数据。移交构建/运行命令、映射与 gate 证据，不自动发布或替换正式 Bundle ID。
- [ ] 更新新包 README/AGENTS、`docs/architecture/README.md`、`docs/architecture/app-mobile.md` 的已验证事实与 `docs/testing/layers.md` 的原生验证路由；完成后按文档治理迁移持久结论并清理过程计划/评估材料。

## 7. 验证入口与证据

配套用例（本轮交付；执行时使用 `toolkit:run-test-cases`）：

- [原生终端技术门禁](../testing/app/ios-native-terminal.testplan.yaml)：14 个 required case。
- [认证、连接与会话](../testing/app/ios-native-session.testplan.yaml)：15 个 required case。
- [移动功能对照](../testing/app/ios-native-features.testplan.yaml)：12 个 required case。

本轮可执行的文档命令：

```bash
pnpm testplan:validate docs/testing/app/ios-native-terminal.testplan.yaml docs/testing/app/ios-native-session.testplan.yaml docs/testing/app/ios-native-features.testplan.yaml
pnpm docs:check
git diff --check
```

下列是 P0 必须实现的命令合同，现在不能报告其通过：

```bash
pnpm --filter @runweave/app-ios ios:doctor
pnpm --filter @runweave/app-ios mapping:check
pnpm --filter @runweave/app-ios ios:build -- --simulator <已安装设备UDID> --configuration Debug
pnpm --filter @runweave/app-ios ios:run -- --simulator <同一UDID>
```

doctor 输出 Xcode/SDK/runtime/destination 与依赖锁版本；build 调用 `xcodebuild -project packages/app-ios/ios/RunweaveNative.xcodeproj -scheme RunweaveNative -configuration Debug -destination 'platform=iOS Simulator,id=<UDID>' -derivedDataPath .runweave/ios-native-build/DerivedData CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- build`，使用绝对 DerivedData/SPM clone/cache 路径。模拟器采用本地 ad hoc 签名及 simulator-only entitlement，使 Keychain 可用；无签名构建实测返回 -34018，不沿用旧计划的禁签参数。成功必须有 `BUILD SUCCEEDED` 和真实 `.app` 路径；run 用 `simctl install/launch` 返回 bundle/PID。设备签名只用执行环境已有配置，不把个人 team 提交进仓库。Profile 性能构建沿用脚本切换 configuration；正式候选还需构建 Release 并确认不包含 Probe。

旧包有改动时执行 `pnpm --filter @runweave/app typecheck`、`pnpm --filter @runweave/app lint`、`pnpm app:build`。shared/Backend 的条件子任务各按就近 AGENTS 执行检查，并跑 `pnpm architecture:check`；新包首次纳入时也执行架构检查。不默认启动完整 Dev Session；实际需要使用 dev:session/status/open/stop 时必须先应用对应 skill。新包脚本只控制 iOS 构建/安装，不偷偷启动或停止 Backend。

证据每次执行独立目录：run 元数据、按 case 的 verdict/操作记录/诊断、旧/新画面与指标、资源归属清单。引用动态端点时在执行现场发现，不把个人 token/主机地址写入 Git；每条 case 自建 fixture，不依赖前一 case 的登录或进程遗留。结束只清理本 case 创建的资源。

## 8. 风险登记与执行停止条件

| 风险                             | 必须取得的证据                        | 失败处理                                                     |
| -------------------------------- | ------------------------------------- | ------------------------------------------------------------ |
| SwiftTerm 与当前 tmux/TUI 不兼容 | IOSTERM-002～005                      | 固定最小流区分库缺陷与适配缺陷；修复适配或记录局部 Web 决策  |
| snapshot 无法恢复屏幕            | IOSTERM-006～008                      | 独立 Backend/shared 恢复子任务；P1 不得通过                  |
| Metal 在设备/后台恢复异常        | IOSTERM-009                           | 关闭 Metal 使用已验证普通原生 renderer；仍须通过 G3 性能预算 |
| 用户写入重复、跨电脑串会话       | IOSSESSION-005、009 与 IOSFEATURE-001 | 阻断候选交付，修复生命周期/写入状态，不靠 UI 提示规避        |
| 两端对照互相 resize 干扰         | IOSTERM-011 及 run 元数据             | 顺序运行或独立会话，不把测试干扰当产品差异                   |
| 无真机/最低版本环境              | IOSTERM-001、007、009、010            | 保留 blocked；模拟器成功不能代替                             |
| 双端长期漂移                     | mapping:check 和各 MAP 对应用例       | stale 行重新检查，固定依赖与 Backend 基线                    |

不确定技术一律遵循：先验证最小真实链路 → 保存证据与结论 → 再展开依赖实现。源码阅读、依赖 manifest、编译成功、模拟器运行、真机验收分别报告，不互相替代。

## 9. 估算与提交划分

单名熟悉 Swift/UIKit 与本仓协议的工程师：P0/P1 约 1–2 人周；P2 约 2–3 人周；P3/P4 约 3–4 人周；P5 与稳定性修复约 2–3 人周。合计约 8–12 人周，置信度中低。若 G2 需要新的服务端恢复协议或切换终端引擎，应先重估，不隐含进原工期。

按阶段形成可评审提交，Backend 恢复子任务独立提交；每次只包含本任务文件。当前已存在 `electron/src/terminal-browser-proxy-preferences.ts` 等无关改动，禁止恢复、清理或带入提交。本轮未获提交/推送请求，不执行 Git 提交与发布。
