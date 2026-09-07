# app-ios 与旧 app 功能差异梳理

> 历史对照：旧客户端已退役，以下结论仅适用于当时源码；删除路径的链接固定到该历史提交。当前入口见 [iOS README](../../packages/app-ios/README.md)。
> 日期：2026-09-07。基线：当前工作区 `0ba29d64` 及梳理时已存在的未提交改动。
> 对照对象是 `packages/app-ios/` Swift 原生候选客户端与 `app/` Ionic React + Capacitor 移动客户端，不包含 `frontend/` 桌面功能。

结论：原生端已接入旧 App 的主要业务模块，但“21 个映射均 implemented”不等于逐项行为一致。剩余差异主要在新建终端类型、图片选择来源、预览细节、离线操作与诊断信息；原生端也增加了草稿保留、主题选择、历史一键复制等能力。

本次仅阅读代码、执行只读映射检查及核对已有验收记录；未修改源码、配置或测试，未启动服务、构建或重跑 UI/真机验收。只新增此报告。以下“已有”表示存在实际调用链，不表示本次重新验收通过。

## 主要模块对照

| 模块             | 旧 app                                                | app-ios                                          | 判断                                   |
| ---------------- | ----------------------------------------------------- | ------------------------------------------------ | -------------------------------------- |
| 登录、刷新、退出 | Backend 认证；iOS 安全凭据插件                        | Backend 认证；独立 Keychain                      | 主能力已有；原生写请求与草稿处理更严格 |
| 多连接管理       | 新增、编辑、切换、删除、健康检测                      | 同类能力；删除增加确认                           | 主能力已有；默认连接及存储行为有差异   |
| Home             | 项目/终端分组、搜索、展开、刷新、创建                 | 同类能力；首页长按可删除终端                     | 主能力已有                             |
| 全局事件         | 事件游标、增量更新、重同步                            | 独立 Swift 事件流实现同类链路                    | 已有；不应列为漏迁                     |
| 实时终端         | xterm DOM；5000 行本地历史                            | SwiftTerm CoreGraphics；5000 行本地历史          | 渲染实现和字号不同，性能等价未完成验收 |
| 终端恢复         | WS 断线重连、snapshot、tmux/PTY                       | 同类协议；显式前后台断开与恢复                   | 已有；完整锁屏恢复耗时仍缺证据         |
| 命令输入         | Composer、Codex slash command、Stop                   | 同类输入 API 和接受结果校验                      | 已有；原生保留草稿、限制发送并发       |
| 控制键与手势     | Ctrl-C、Tab、Esc、↑、↓、Enter；tmux 滚动              | 同六键；本地/tmux 滚动与回到底部                 | 已有；快捷键展开及离线行为不同         |
| 历史             | 独立只读历史视图、选择复制                            | 独立只读历史视图、选择复制、复制全部             | 原生增加明确的一键入口                 |
| 图片上传         | `input type=file accept=image/*`                      | 单张 PHPicker 图片选择、上传                     | 上传链路已有；文件选择来源收窄         |
| 语音             | 24 kHz WAV → Backend 转写 → Composer                  | 同协议；原生录音、取消与中断处理                 | 已有；有一项历史异常待归因             |
| Files            | 目录、面包屑、搜索、文件预览、复制路径、跳 Changes    | 同类能力                                         | 已有；搜索结果信息有缺失               |
| Changes/Diff     | All/Staged/Working、只读 Diff、已看标识               | 同类能力；双行号和原生预览                       | 主能力已有；错误重试和展示细节不同     |
| 图片查看         | Files/Changes 中全屏、缩放、平移                      | Files/Changes 中全屏、缩放、平移                 | 已有；控件与缩放规则不同               |
| 缓存与 UI 状态   | 15 秒 stale、30 分钟 gc；切 tab 卸载部分视图          | 同级预览缓存并增加 32 MiB 上限；tab 隐藏保留视图 | 原生保留更多当前页面状态               |
| 诊断             | start/stop、服务端收集、本地日志、复制路径            | 同协议；本地持久化、按连接清空、系统分享导出     | 主能力已有；诊断上下文未完全对齐       |
| 主题             | 深浅色 store 与启动应用逻辑，当前无 `setMode` UI 调用 | 连接管理中可切换深浅色并持久化                   | 原生新增可见选择入口                   |

完整模块索引见 [legacy-map.json](https://github.com/jackshen3102/run-weave/blob/ce1b65853ee69fbf96d788b0b60b2a5d270683ff/packages/app-ios/docs/legacy-map.json)。本次 `pnpm --filter @runweave/app-ios mapping:check` 通过：21 个映射，旧源码/合同哈希均未漂移；检查不验证运行行为。

## 需要关注的差异

下列优先级用于迁移对照，不把所有差异当作缺陷；P1 项需要先明确产品语义，P2 项是可观察的能力或交互差距，P3 项是平台与呈现差异。本次没有发现足以仅凭这些差异判定为 P0 的问题。

### P1：新建终端的运行时选择不同

- 旧端创建请求明确传 `runtimePreference: "pty"`；原生只传 `projectId`，Backend 缺省为 `auto`，tmux 可用时优先 tmux，否则回退 PTY。
- 影响：同一电脑点击“新建终端”，两端可能得到不同运行时；持久恢复、历史滚动及终端输入处理也随之不同。这是行为变化，不是 SwiftUI 外观变化；已存在的会话仍按服务端实际运行时连接。
- 证据：[旧创建入口](https://github.com/jackshen3102/run-weave/blob/ce1b65853ee69fbf96d788b0b60b2a5d270683ff/app/src/routes/AppRoutes.tsx) L64–71；[原生创建请求](../../packages/app-ios/Sources/RunweaveIOS/Services/APIClient.swift) L122–126；[Backend 真正选择运行时](../../backend/src/routes/terminal/index.ts) L266–319。
- 方向：先把“固定 PTY”还是“优先可恢复 tmux”写成明确迁移结论；若接受后者，保留原生 auto 并按 tmux 行为验收，不必为了字面一致强制退回 PTY。

### P2：图片选择来源收窄

- 旧端使用通用 HTML 图片文件输入；原生使用 `PHPickerViewController`，只选择照片库中的单张图片，未接 `UIDocumentPicker` 或拍照入口。
- 影响：不能把旧端文件输入入口与原生照片选择视为完全等价；存放在系统 Files 中的图片缺少原生选择入口。旧 WebView 是否展示拍照菜单取决于运行环境，本次未实测，不把拍照列为已证实的旧端功能。
- 原生增加 HEIC 等格式向 PNG 的转换兜底；后端上传结果仍只追加草稿，用户显式发送。
- 证据：[旧图片输入](https://github.com/jackshen3102/run-weave/blob/ce1b65853ee69fbf96d788b0b60b2a5d270683ff/app/src/components/terminal/composer.tsx) L279–286；[原生选择器](../../packages/app-ios/Sources/RunweaveIOS/Features/Media/ImagePicker.swift) L8–12、L27–49；[媒体调用](../../packages/app-ios/Sources/RunweaveIOS/Features/Media/MediaControls.swift) L40–54。
- 方向：若旧文件输入的 Files 来源属于使用场景，补文件选择来源；不必增加附件列表或图片 chip，旧端没有这些交互。

### P2：Markdown 列表排版未完全迁移

- 旧 Files Markdown 显式生成 `ol/ul/li`；原生只把 `- `、`* ` 转成单行“•”，数字列表落入普通文本，列表项不分组。
- 影响：有序列表、长列表项的缩进与换行呈现不同。普通标题、代码块、引用、frontmatter 和外部链接均已有实现；两端原本都是轻量渲染，不应把桌面 Markdown 全能力算成漏迁。
- 证据：[旧 Markdown](https://github.com/jackshen3102/run-weave/blob/ce1b65853ee69fbf96d788b0b60b2a5d270683ff/app/src/components/preview/file-drawer.tsx) L110–139、L182–200；[原生 Markdown](../../packages/app-ios/Sources/RunweaveIOS/Features/Preview/MarkdownPreview.swift) L54–66、L71–105。
- 方向：按旧端实际有序/无序列表补语义，不扩大到完整编辑器或桌面渲染器。

### P2：离线时的本地回到底部、立即重试行为不同

- 旧端“回到底部”始终可以调用本地 renderer 滚到底部；离线提示有显式健康检查“重试”按钮。
- 原生 `returnToBottom()` 入口首先要求 `canSend`，终端离线或已退出时，即使只是本地 PTY 历史也不能通过该按钮回到底部；菜单“重连”要求 `session.canWrite`，电脑 offline 时禁用。自动恢复仍存在，探测间隔为 5、15、30、60、120 秒。
- 影响：本地只读浏览被远端可写状态限制；详情页少了旧端同位置的立即健康重试。不能因此说原生没有重连能力。
- 证据：[旧终端面板](https://github.com/jackshen3102/run-weave/blob/ce1b65853ee69fbf96d788b0b60b2a5d270683ff/app/src/components/terminal/panels.tsx) L173–180、L202–214；[原生按钮](../../packages/app-ios/Sources/RunweaveIOS/Features/Terminal/TerminalScreen.swift) L93–95、L116–119；[实际执行](../../packages/app-ios/Sources/RunweaveIOS/Features/Terminal/SessionController.swift) L159–167；[自动探测](../../packages/app-ios/Sources/RunweaveIOS/State/AppSession.swift) L313–335。
- 方向：区分本地 viewport 操作与需要远端输入的 tmux 操作；保留显式健康重试。

### P2：诊断记录的信息维度不同

- 旧端记录启动、未捕获异常、业务点击/成功/失败事件，并统一附版本、Build、route、平台等上下文；诊断面板显示 Route、版本、Build。
- 原生主要记录 HTTP 结果和终端协议/计量白名单，虽包含部分终端 appVersion，但没有对应的统一业务操作事件与 Build/route 上下文，诊断面板也未展示这些信息。
- 影响：同样可以 start/stop、收集和复制服务端日志路径，但复原“用户点了什么”和区分安装版本的能力不等价。原生系统分享导出及按连接清空则是增加的能力。
- 证据：[旧全局上下文和异常](https://github.com/jackshen3102/run-weave/blob/ce1b65853ee69fbf96d788b0b60b2a5d270683ff/app/src/features/support-logs/SupportLogProvider.tsx) L29–45、L79–120；[旧面板](https://github.com/jackshen3102/run-weave/blob/ce1b65853ee69fbf96d788b0b60b2a5d270683ff/app/src/features/support-logs/SupportLogSheet.tsx) L249–262；[旧业务事件](https://github.com/jackshen3102/run-weave/blob/ce1b65853ee69fbf96d788b0b60b2a5d270683ff/app/src/hooks/use-app-terminal-actions.ts) L71–117；[原生 HTTP](../../packages/app-ios/Sources/RunweaveIOS/Services/APIClient.swift) L273–297；[原生白名单](../../packages/app-ios/Sources/RunweaveIOS/State/DiagnosticStore.swift) L153–160；[原生面板](../../packages/app-ios/Sources/RunweaveIOS/Features/Diagnostics/DiagnosticsView.swift) L21–68。
- 方向：对齐排障所需的版本、页面和操作边界，不机械照搬 Web 异常事件名。

### P2：Files/Changes 的信息与重试入口有小缺口

- 旧 Files 搜索结果显示语言标记和 Git 状态；原生搜索结果只显示文件名、目录，DTO 虽有 `gitStatus`，UI 没有用它。原生普通目录仍有变更状态，不能说 Git 状态整体缺失。
- 旧 Diff 错误页有 Retry；原生预览 sheet 显示错误，没有同位置显式重试按钮。列表有下拉刷新，关闭重开也会重新加载，因此不是完全不能恢复。
- 旧 Changes 详情展示 diff status；原生 `PreviewDiff` 只解码 path/oldContent/newContent，详情未显示状态；列表状态仍在。
- 证据：[旧 Files 搜索行](https://github.com/jackshen3102/run-weave/blob/ce1b65853ee69fbf96d788b0b60b2a5d270683ff/app/src/components/terminal/files-tab.tsx) L315–336；[原生搜索行](../../packages/app-ios/Sources/RunweaveIOS/Features/Preview/FilesView.swift) L69–79；[旧 Diff 状态与重试](https://github.com/jackshen3102/run-weave/blob/ce1b65853ee69fbf96d788b0b60b2a5d270683ff/app/src/components/terminal/changes-tab.tsx) L303、L346–352；[原生预览](../../packages/app-ios/Sources/RunweaveIOS/Features/Preview/FilePreview.swift) L37–81；[原生 DTO](../../packages/app-ios/Sources/RunweaveIOS/Contracts/Preview.swift) L45–49。
- 方向：补 UI 已有数据的接线与重试入口即可，不需要更换 Preview API。

### P3：输入、布局与图片查看交互不同

- 旧 Keys 默认收起，可展开；原生六键常驻，横屏与媒体按钮共用一行。旧 Composer 自动增高；原生竖屏固定 70 pt、横屏 36 pt。两端都能输入多行，只是长草稿编辑体验不同。
- 旧 Chat/Changes/Files 在底部；原生在顶部。旧文件/变更详情在 tab 内替换；原生弹 sheet。原生 ZStack 保留三个 tab 的视图，旧端切 tab 会卸载 Files/Changes 和 Composer；原生返回 Chat 保留草稿、目录、过滤和已看状态的范围更大。
- 旧图片全屏有标题、缩放按钮；原生全屏为关闭按钮加手势缩放，范围 1–5 倍、双击 1/2 倍。动画 GIF、各图片解码格式的等价性本次未作运行验证。
- 旧终端字号 12；原生 14，默认分别为 DOM 与 CoreGraphics。同尺寸下行列与排版可能变化，不能仅凭原生实现认定性能更好。Metal 当前只有内部入口，非正式用户设置。
- 证据：[旧 Composer](https://github.com/jackshen3102/run-weave/blob/ce1b65853ee69fbf96d788b0b60b2a5d270683ff/app/src/components/terminal/composer.tsx) L36–37、L288–305；[原生 Composer](../../packages/app-ios/Sources/RunweaveIOS/Features/Terminal/Input/ComposerView.swift) L34–48；[原生 tab](../../packages/app-ios/Sources/RunweaveIOS/Features/Terminal/TerminalScreen.swift) L46–69；[旧 tab 生命周期](https://github.com/jackshen3102/run-weave/blob/ce1b65853ee69fbf96d788b0b60b2a5d270683ff/app/src/components/terminal/panels.tsx) L241–264 和 [旧 Composer 挂载](https://github.com/jackshen3102/run-weave/blob/ce1b65853ee69fbf96d788b0b60b2a5d270683ff/app/src/pages/AppTerminalPage.tsx) L387–404；[旧 lightbox](../../packages/common/src/terminal/image-lightbox.tsx) L40–64；[原生图片](../../packages/app-ios/Sources/RunweaveIOS/Features/Preview/ImagePreview.swift) L8–40；[原生终端](../../packages/app-ios/Sources/RunweaveIOS/Features/Terminal/Rendering/SwiftTermSurface.swift) L12–29。
- 方向：按手机实际输入体验判断哪些保留，不必以像素级复制旧 UI 为目标。

### P3：安装迁移和默认连接不等价

- 旧端支持 `VITE_RUNWEAVE_API_BASE` 或 Web 同源默认连接；原生没有对应预置逻辑，首次使用手动添加。
- 原生独立 Bundle ID、连接存储和 Keychain，不导入旧安装配置。用户需重新添加连接并登录，这是候选客户端隔离设计，不是认证链路漏迁。
- 原生 URL 编辑同时按旧 endpoint 清理其凭据；凭据实际作用域包含 connectionId 与 endpoint 哈希。
- 证据：[旧默认连接](https://github.com/jackshen3102/run-weave/blob/ce1b65853ee69fbf96d788b0b60b2a5d270683ff/app/src/store/use-app-connection-store.ts) L62–78；[原生连接初始化](../../packages/app-ios/Sources/RunweaveIOS/State/ConnectionStore.swift) L18–42；[原生 endpoint 凭据](../../packages/app-ios/Sources/RunweaveIOS/Services/APIClient.swift) L36–51；[原生安装边界](../../packages/app-ios/AGENTS.md)。
- 方向：若以后作为旧 App 的替代发行，再定义配置迁移；本次候选安装保留隔离。

## 原生端增加或改善的能力

| 能力                    | 实际差异与依据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 草稿保留                | 同一连接内按终端存于 AppSession；返回 Home 重开、认证过期都保留，仅明确接受且草稿未变时清空。主动退出、切连接、删终端清理；没有磁盘草稿，不保证杀进程保留。见 [AppSession](../../packages/app-ios/Sources/RunweaveIOS/State/AppSession.swift) L18、L199–227。旧端草稿是 Composer 局部 state，401 路径还可能正常 return 后触发清空，见 [旧输入动作](https://github.com/jackshen3102/run-weave/blob/ce1b65853ee69fbf96d788b0b60b2a5d270683ff/app/src/hooks/use-app-terminal-actions.ts) L142–152。                                                                            |
| 输入确认与并发限制      | 校验 operationId、terminalSessionId、inputAccepted/inputEnqueued；等待响应时限制新发送，失败明确提示未确认。见 [APIClient](../../packages/app-ios/Sources/RunweaveIOS/Services/APIClient.swift) L143–170 和 [SessionController](../../packages/app-ios/Sources/RunweaveIOS/Features/Terminal/SessionController.swift) L188–209。                                                                                                                                                                                                                                            |
| 重连期间不排队原始输入  | 旧端在电脑未判离线但 WS 暂断时，可排队最多 8192 字符，连接后 flush；原生要求 socket 与 snapshot 就绪后发送，六键禁用，不补发。这是安全行为差异，不建议复刻旧排队。见 [旧连接](https://github.com/jackshen3102/run-weave/blob/ce1b65853ee69fbf96d788b0b60b2a5d270683ff/app/src/hooks/use-app-terminal-connection.ts) L26、L270–277、L441–467；[原生 canSend](../../packages/app-ios/Sources/RunweaveIOS/Features/Terminal/SessionController.swift) L44–46。                                                                                                                  |
| 历史复制全部            | 历史工具栏增加“复制全部”。见 [HistoryView](../../packages/app-ios/Sources/RunweaveIOS/Features/Terminal/HistoryView.swift) L63–70。                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 录音取消与中断          | 增加明确取消按钮；离开 Chat、后台或音频中断时停止录音、删除临时文件。见 [MediaControls](../../packages/app-ios/Sources/RunweaveIOS/Features/Media/MediaControls.swift) L23–33、L60–77 与 [VoiceRecorder](../../packages/app-ios/Sources/RunweaveIOS/Features/Media/VoiceRecorder.swift) L15–25、L92–102。                                                                                                                                                                                                                                                                   |
| SVG 与 Changes 文档预览 | 旧 Files 中 SVG、旧 Changes 中 Markdown/SVG Preview 实际仍为 pre 文本；原生可实际渲染 SVG、Changes Markdown，并提供 Files Source/Preview 切换。见 [旧文件预览](https://github.com/jackshen3102/run-weave/blob/ce1b65853ee69fbf96d788b0b60b2a5d270683ff/app/src/components/preview/file-drawer.tsx) L354–361、[旧 Changes](https://github.com/jackshen3102/run-weave/blob/ce1b65853ee69fbf96d788b0b60b2a5d270683ff/app/src/components/terminal/changes-tab.tsx) L365–370、[原生预览](../../packages/app-ios/Sources/RunweaveIOS/Features/Preview/FilePreview.swift) L39–56。 |
| 可见主题切换            | 旧 store 有 light/dark 和 setMode，但全 app/src 搜索没有 UI 调用；原生在连接管理提供主题 Picker。见 [旧主题 store](https://github.com/jackshen3102/run-weave/blob/ce1b65853ee69fbf96d788b0b60b2a5d270683ff/app/src/store/use-theme-store.ts) 与 [原生主题](../../packages/app-ios/Sources/RunweaveIOS/Features/Connections/ConnectionManager.swift) L19–25。                                                                                                                                                                                                                |
| 其他便捷操作            | Home 长按删除终端；删除本地连接确认；Files 截断提示；系统分享本地诊断。分别见 [HomeView](../../packages/app-ios/Sources/RunweaveIOS/Features/Home/HomeView.swift) L44–47、[ConnectionManager](../../packages/app-ios/Sources/RunweaveIOS/Features/Connections/ConnectionManager.swift) L83–95、[FilesView](../../packages/app-ios/Sources/RunweaveIOS/Features/Preview/FilesView.swift) L67、L80、[DiagnosticsView](../../packages/app-ios/Sources/RunweaveIOS/Features/Diagnostics/DiagnosticsView.swift) L41–51。                                                         |

## 不应算作漏迁的项目

- **本地通知**：旧 [notifications.ts](https://github.com/jackshen3102/run-weave/blob/ce1b65853ee69fbf96d788b0b60b2a5d270683ff/app/src/services/notifications.ts) 有权限、调度和点击回调封装，Capacitor 依赖也已接入，但 `app/src` 没有业务调用者。原生没有对应封装属于基础能力差异，不能说旧端已有“Agent 完成通知”而原生丢失。
- **终端输出图片点击打开**：旧 TerminalRenderer 只加载 Fit、Unicode 与 renderer，App 安装的是触摸扩展；并无图片 addon/打开图片接线。已有图片查看范围是 Files/Changes。见 [TerminalRenderer](https://github.com/jackshen3102/run-weave/blob/ce1b65853ee69fbf96d788b0b60b2a5d270683ff/packages/terminal-renderer/src/TerminalRenderer.tsx) L261–275 与 [App 面板](https://github.com/jackshen3102/run-weave/blob/ce1b65853ee69fbf96d788b0b60b2a5d270683ff/app/src/components/terminal/panels.tsx) L130–141。
- **代码编辑、Git stage/commit、桌面 Browser、完整 IDE**：不在旧移动 App 当前链路里。两端 Changes/Files 都以只读预览为主，不能把桌面功能计入本次 diff。见 [移动端架构边界](../architecture/app-mobile.md)。

## 已有验收记录与剩余不确定性

本次核对当前 [validation-status.md](../../packages/app-ios/docs/validation-status.md) 和本地累计 JSON `.runweave/ios-native-evidence/goal-results.json`：共 44 项，38 pass、4 partial、2 skip。其中一个 skip 是“性能尚未执行”，另一个是“iOS 15 用户排除”；所以文档口径为 **38 通过、4 部分、1 未执行、1 排除**。这都是已有记录，不是本轮新增运行证据。

| 未完成项                  | 当前记录的真实含义                                                                                                                      |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| IOSFEATURE-006 录音       | 转写、取消、拒绝/恢复、错误恢复已有真机记录；早前取消测试后一次来源不明输入仍未归因，不能宣称彻底关闭                                   |
| IOSFEATURE-007 文件作用域 | 相对越界/软链接拒绝已记录；Backend 明确允许绝对路径只读预览项目外文件，与计划预期不同。属于共享后端行为与验收合同差异，不是原生独有漏迁 |
| IOSTERM-007 锁屏恢复      | 会话恢复与新输入已有记录；缺 scene 时间戳和解锁到完整画面的耗时                                                                         |
| IOSSESSION-015 网络权限   | 局域网 HTTP 已有记录；局域网权限拒绝/恢复未验证。HTTPS/WSS/TLS 证书部分按既有记录被用户排除                                             |
| IOSTERM-010 性能          | 真机 Profile 持续负载、显示提交延迟与同设备旧 xterm 基线尚未完成                                                                        |

Unicode 现有记录还确认 `👩‍💻` 在 SwiftTerm 占 2 列、旧 xterm Unicode 11 占 4 列；这是已记录的表现差异，不应为了迁移强制复制旧行为。证据边界见 [技术决策](../../packages/app-ios/docs/decisions.md)。

建议先确认新建终端运行时选择，再补图片来源、Markdown 列表、离线本地操作和 Files/诊断的信息缺口。原生草稿、主题、预览改进可保留；替换旧 App 的结论仍需与性能及剩余异常验收分开。
