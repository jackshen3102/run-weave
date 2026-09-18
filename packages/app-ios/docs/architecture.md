# iOS 架构与协议边界

Runweave iOS 是独立的原生客户端。Xcode host 装配 Swift package，Swift package 仅依赖 SwiftTerm，
业务数据通过 Backend HTTP/WS 获取。构建不读取其他客户端源码；协议兼容以真实接口和 Swift DTO 为准。

```text
ios/RunweaveNative → RootView → AppSession
                               ├─ APIClient → Backend HTTP
                               ├─ EventStream → terminal-events WS
                               └─ SessionController → terminal WS
                                      └─ SwiftTermSurface → UIKit / SwiftTerm
```

## 归属与生命周期

| 入口                                                        | 职责                                                     |
| ----------------------------------------------------------- | -------------------------------------------------------- |
| `App/RootView.swift`、`Features/Connections`                | 导航、连接管理和主题                                     |
| `State/ConnectionStore.swift`                               | 本地连接列表与当前连接，不保存明文凭据                   |
| `State/AppSession.swift`                                    | 当前连接、认证、Home、草稿和 generation；丢弃过期响应    |
| `Services/APIClient.swift`                                  | 规范化 endpoint、认证、HTTP 错误分类与请求               |
| `Features/Terminal/SessionController.swift`                 | 终端连接、输入确认、事件与资源释放                       |
| `Features/Terminal/EventStream.swift`、`Rendering`、`Input` | 传输、解析显示和用户输入分别归属                         |
| `Features/Preview`、`Features/Media`                        | 文件审阅与单文件操作、上传与转写，业务错误由所属区域展示 |
| `State/DiagnosticStore.swift`、`ios/Diagnostics`            | 日常脱敏日志与内部验证入口，二者分开                     |

源码路径相对于 `Sources/RunweaveIOS`，host 及内部验证目录除外。
终端关闭释放本客户端资源，不结束远端 tmux；连接切换使旧请求、socket 和缓存失效。

终端 WS 的 `notice` 是可继续使用的恢复提示，不进入失败或停止重连状态；`error` 仍表示失败。
手动重连独立于写入权限：已登录的前台客户端可在离线时立即检查 Backend 并重新连接，
但离线时不能发送输入。切换连接或终端后，旧的手动重连结果不会连接到新目标。
旧 socket 的发送失败回调不能停止新连接；当前 socket 发送失败时继续走接收循环的重连，
仅重同步窗口尺寸。输入结果未确认仍显示提示，不自动重发输入。
设备 online/offline 与后端 TerminalState 分开管理；socket open 不等于业务已连接。

## 协议来源

Swift 不直接导入 TypeScript。修改接口时同时核对 Swift `Contracts/`、`Services/`、`Features/Terminal/`
与仓库的 `packages/shared/src`，并对真实 Backend 取证，不再维护依赖已删除客户端源码的迁移哈希。

| 能力       | Backend 合同                                                             |
| ---------- | ------------------------------------------------------------------------ |
| 认证与健康 | `/api/auth/*`、`/health`；`X-Auth-Client: app` 和 Bearer                 |
| 首页与事件 | `/api/app/home/overview`、`/ws/terminal-events`                          |
| 终端       | ticket、session metadata、terminal WS、input、interrupt、clipboard-image |
| 文件与变更 | `/api/terminal/project/:id/preview/*`，项目作用域与后端权限共同约束      |
| 语音       | `/api/voice/transcribe`，24 kHz WAV                                      |
| 诊断       | Backend diagnostic logs 的 start/stop/upload 合同                        |

`app` 是服务端认证与接口命名的一部分，删除旧客户端不重命名这些协议或改变权限。
Backend、Web/Electron 和 App Server 继续由仓库各自入口维护，iOS 不承担其进程生命周期。

## 首页终端查找

首页保持项目分组，手动置顶、未读完成和在线执行中的终端另在顶部“关注”区集中显示，两处使用同一
session ID 和 overview 数据源。关注区按未读、执行中或启动中、手动置顶排序；同一终端只出现一次，
但仍保留在原项目分组中。未读和执行态只参与客户端即时投影，不写入置顶元数据；确认已读或进入空闲后
自动退出关注区，手动置顶仍常驻。离线时不使用缓存的执行态临时上浮，避免把过期运行状态当作当前事实。
置顶通过 `PATCH /api/terminal/session/:id` 显式发送 `pinned: boolean`；`pinnedAt` 由 Backend
生成并持久化，缺失或 null 表示未置顶。最近置顶在前，同时间按 session ID 排序；重复置顶不改变
时间，输出、退出和重命名不改变位置。数据随所连接的 Backend 隔离，桌面端不增加置顶 UI。

重命名复用共享 `alias`，空值清除别名；Backend 和 Swift 均按最多 80 个 UTF-16 code units
校验。PATCH 响应是 session list item，标题仍取 overview；修改成功后刷新失败会单独提示已保存，
不自动重发修改。写入忙状态按终端共享，generation 和 overview 请求序号隔离旧连接与旧快照。
其他客户端通过重新加载、前台恢复或主动刷新读取变化，不承诺别名和置顶的后台实时推送。

搜索沿用项目名/路径与终端标题、摘要、命令、工作目录的匹配规则；命中项目强制展开，关注区
按同一命中集合筛选。普通展开集合只在当前连接首次加载时初始化，搜索与清空不会覆盖它。

副标题由 Backend 返回当前 thread 最近一次已完成任务的最终回复，转为纯文本后最多保留
120 个字符并追加省略号，iOS 最多展示两行。正在执行下一轮时保留上一轮回复；无回复时显示
工作目录，不回退到旧 thread 标题。预览按 Session/Panel 与 provider/thread 身份保存，重启可恢复，
其他分屏与旧 thread 的回复不覆盖当前预览。缺失预览或当前 thread 的完成 Hook 缺少正文时补取历史，完成 Hook
携带有效正文时直接更新；成功回填后的列表刷新不重复加载完整对话。
iOS 收到完成和状态变化事件后刷新 overview，并丢弃刷新期间已过期的快照。

## 终端状态与接管提醒

运行状态和未读提醒相互独立。列表分别展示正在执行、启动中、等待输入、终端空闲和已退出；
项目标题汇总执行状态和待接管终端数，收起项目后仍保留提示。

绿色小点表示 `completionRevision > acknowledgedCompletionRevision`，包括完成及需要关注的
通知，不能由 `agent_idle` 推断。成功打开终端时，只确认点击时看到的完成版本；也可通过列表
长按菜单或终端页新提醒按钮标记已读。PATCH 成功后更新已读版本，失败保留绿点，迟到确认
不能覆盖更高版本的新提醒。版本由 Backend 持久化；其他客户端在刷新、重连或前台恢复时
读取共享已读状态，现有协议不推送已读确认事件。

黄色小点来自非当前终端的实时响铃，持续 2 秒，并暂时覆盖绿点；过期后恢复仍未读的绿点。
历史事件补发不触发响铃，返回后台或切换连接时清理临时响铃。完成版本仍从 overview 和事件恢复。

## 终端输入面板

终端页面不再把 Composer 作为 `TerminalHostView` 的纵向兄弟视图。默认状态只在右下角显示输入入口，
点击后由独立的底部模态容器承载输入：正文从两行起步，按真实排版高度向上增长，达到顶部安全区后
只滚动正文。`TerminalComposerPresentation` 用 UIKit keyboard layout guide 确定底边，SwiftUI 不再重复
避让键盘；收起键盘后重新使用可用高度。横屏等空间不足时，附件、快捷键与提示区域限制高度并可滚动，
为正文和固定操作栏保留空间。快捷回复列表/编辑页单独使用正常高度的系统 Sheet。
终端内容忽略键盘安全区变化，包含回复库搜索键盘；底层终端保持挂载和原始 bounds，
因此打开输入、正文增长、切换键盘或关闭输入不应产生 PTY resize；设备旋转等真实视口变化仍正常同步行列数。

文字与图片继续由 `AppSession` 按 terminal ID 持有，关闭面板不清空草稿；存在草稿时入口显示提示。
发送等待确认时允许关闭面板并切换目标，界面明确提示关闭不会撤回已发送内容或自动重发；
切换目标取消旧请求等待，迟到结果不能清理新目标草稿。留在原面板时，发送确认成功后关闭面板，
失败则保留面板、错误和草稿。Agent 执行期间终端右下角独立显示停止按钮，
不要求先打开输入面板。录音、麦克风权限请求或转写进行中时禁止交互关闭，避免视图销毁取消媒体操作。

## 终端内置网页

浏览器实现位于独立 [RunweaveBrowser](../../browser-ios/README.md) 包，终端的选区识别留在
`TerminalLinkSelection`。宿主将下面的业务来源映射到不透明 `BrowserContext`，以实时呈现注册接入；
共享包不导入 RunweaveIOS，WebView 与页面对象不对宿主暴露。

`AppSession` 持有唯一 `BrowserSession`，来源是 connection scope、AppSession generation 与 terminal ID；
网页回调额外检查 session identity；确认检查来源、session 与生命周期 token，URL 相关确认及异步外部打开
另检查导航 revision。关闭/清除不检查 revision，网站不能靠持续改变地址使用户确认失效。过期 URL 操作
显示明确状态，不重放操作；旧来源已离开则直接丢弃，避免在新来源弹旧错误。
返回首页、切换终端/连接、注销和删除来源走 `closeTerminal` 同步使页面失效；事件流收到匹配当前 ID
的权威 `terminal_session_deleted` 同样立即关闭，不等待 overview 刷新。网络断开和普通后台
往返不主动销毁网页，不改变既有终端 socket 策略。网页运行时不落盘，冷启动不恢复地址、历史或表单。

终端链接沿 `SwiftTermSurface → SessionController → TerminalScreen` 只传递意图，不传入认证或输入。
[本地 SwiftTerm 1.19.0 补丁](../Vendor/SwiftTerm/README.md) 以默认关闭的 opt-in 复用原生
single-tap recognizer、bidi-aware hit test 与 implicit detector；本 App 开启后，普通完整 HTTP(S)
URL 和 OSC 8 均首次单击打开，不需预先聚焦或选择。普通 URL 仅合并真实软折行；TUI 多行显示使用 OSC 8 的完整目标。
不启用上游通用跨硬换行 heuristic；不新增 ANSI/单元格映射，不把 URL 发送到终端。OSC 8 仍常驻高亮。Backend 的 tmux attach 声明 hyperlinks 能力，实时输出与重连屏幕快照均保留字符绑定的真实链接。
已激活选区保留原选择处理；长按沿用公开 `select` 作为兜底，选区软折行由依赖合并，
硬换行与多个 URL 混合选区不推测拼接。菜单在现有长按/选择路径上使用系统 edit menu，不新增竞争滚动手势
或原始 ANSI 坐标映射；OSC 8 菜单按所选字符真实目标显示域名，原生复制仍复制选区原文。
该菜单使用 iOS 16 API，产品 host 部署版本仍是 iOS 18.6，package 平台声明不代表已验收更低系统。

`BrowserScreen` 覆盖全屏显示；顶部 48pt 单行标题栏放返回和更多菜单，底部 48pt 图标栏放后退、前进、刷新。
标题优先使用网页标题，加载前回退真实域名；更多菜单展示实际目标域名并提供完整地址，HTTP 在标题旁显示非加密图标。
加载进度以顶部 2pt 细线覆盖显示，状态提示浮于正文上方，不改变网页可用高度；外框随 App 深浅主题切换。
收起保留同一 `WKWebView`，终端不出栈；toolbar 恢复不 reload。
同完整 URL 仅恢复，不同 URL 替换及关闭均确认未提交内容风险；替换清除旧网页历史。
终端保持原挂载与键盘安全区策略，网页工具栏不加入终端布局，也不新增 WS resize 或输入调用。
这一零 resize 合同仍需按 [浏览与任务连续性](../../../docs/testing/app/ios-native-browser.testplan.yaml)
在实际设备上取证，构建不能证明网页键盘行为。

`TerminalScreen` 按自己的稳定实例 UUID 和来源 scope 注册实时呈现查询，读取 SwiftUI Binding 的当前
Composer/媒体宿主 Sheet、历史/信息/诊断/删除状态及该终端窗口的系统呈现状态；另核对当前 controller 身份。
注销仅匹配自己的注册 UUID 与 controller 身份，旧页面的 onDisappear 不会清掉新来源注册。首次链接打开、恢复沿用此互斥；
替换等待旧页卸载完成后，创建 WKWebView/加载之前再次查询同一注册。查询失败立即丢弃意图并提示主动重试，
不等 Sheet 结束自动重放。查询成功到创建/加载之间没有进一步 await，均在 MainActor 同步完成。

网页主导航、frame、新窗口及响应复用 `BrowserURLPolicy`；内嵌 frame 额外允许 `about:blank`
和 `about:srcdoc` 文档，不放宽终端入口、主页面或卸载隔离规则。接受有效 HTTP(S)，拒绝 URL 用户密码、
显式 localhost/loopback/未指定本地地址及其它协议；不替换电脑域名、不代理、不做 DNS 防火墙承诺。
HTTP 明示未加密；TLS 保留 WebKit 系统校验，不提供忽略入口。HTTP(S) 链接默认内置打开，
新窗口请求通过 URL 策略后保留原始 request 并加载到当前 WebView，不创建额外页面。WebKit 自动开窗许可关闭；
网页中的飞书/Lark 链接单独走客户端交接策略：识别 `lark`、`x-feishu`、`x-lark` 的客户端地址及官方 HTTPS AppLink。
AppLink 精确匹配 `applink.feishu.cn`、`applink.larkoffice.com`、`applink.larksuite.com`；其中 larkoffice 用于设备授权页发起的隐藏 iframe 跳转，不使用域名后缀泛匹配。
仅 HTTPS 来源且网页当前可见、应用在前台、无其它弹窗时可提出请求；原生确认显示请求 frame 的域名和客户端名称，不展示授权参数。
主页面、子 frame 和新窗口均需原生确认，网页脚本或 `.linkActivated` 本身不算用户授权。确认与异步打开回调复核页面身份及导航 revision。
HTTPS AppLink 先尝试 Universal Link，系统无法打开时回退到同地址的 `lark` scheme，保留路径和授权参数；失败不自动转入外部浏览器。客户端打开不收起、替换或刷新原网页，使站点自己的授权轮询在返回后继续。
这不提供向 Runweave 自动回跳的协议或跨浏览器 Cookie 同步；其它协议（包括 mailto/tel）仍被阻止，终端入口仍只接受 HTTP(S)。
网页更多菜单提供用户主动“在默认浏览器打开当前网页”的入口；外部调用前后复核来源
及 session/lifetime，且只允许 HTTP(S)。不引入私有 API、JS bridge 或触摸时间窗口授权。
附件和不可显示响应取消；子页面拦截不产生整页提示，主页面失败提示可手动关闭。
主页面附件提示从更多菜单复制链接或外部打开，
HTTP 4xx/5xx 仍显示站点页面。宿主处理主文档网络失败和 WebContent 回收，回收后只允许用户重载。

普通网页启用 JS；`alert`、`confirm`、`prompt` 由原生弹窗呈现并显示调用 frame 的网站来源。
确认与取消分别回传网页结果；收起、后台、导航、进程回收及会话失效会取消尚未完成的对话框，
回调只完成一次，旧页面不能向新页面回传结果。其他系统呈现占用时取消并提示主动重试，不排队弹出。
使用本机默认持久 `WKWebsiteDataStore`，不注入脚本、message handler、Backend header、
URLSession Cookie 或终端/文件/认证桥。网站账号由本机所有终端共用，但不继承 Safari 或电脑登录。
关闭、切换、Runweave 注销不清网站 Cookie。每次页面失效都先进入待卸载集合，包括已关闭但可能被
SwiftUI 退场暂时持有的实例；停止加载/移出视图不被当作旧文档已卸载。页面保留严格导航 delegate，
只允许一次宿主发起、禁 JS 的受控 `about:blank` 导航；须匹配同一 `WKNavigation` 的 commit 与 finish
才解除卸载屏障。退役页面即使仍被持有，也拒绝后续导航和交互；新网页等待所有旧页卸载完成。
卸载失败、WebContent 终止或 30 秒未完成均为失败，保留阻止新页的状态并明确要求重启后重试；
超时不是销毁证据，不会触发网站数据删除。

清除需确认全部本机内置网站影响，锁住新导航并等待上述全部旧页屏障成功，之后才调用 WebKit
删除数据；待删除回调及 data records 校验结束才解除清除忙态。删除 API 没有错误参数，残余记录显示
未完全清除，回调未返回时保持忙态，不提前宣称成功。SVG 预览保持独立非持久、禁 JS/网络配置。

终端选区菜单保留内置打开和“链接”；网页更多菜单也使用“链接”展示完整地址并提供复制。
失败页使用失败导航地址；默认浏览器入口位于网页更多菜单。默认浏览器通过
系统 URL opening，不硬编码 Safari，成功后收起原页，拒绝则原界面报错。不记录网页正文、URL query、
fragment 或认证错误详情。安全验收入口为
[网页身份与导航安全](../../../docs/testing/app/ios-native-browser-safety.testplan.yaml)。

## 本地快捷回复

`RootView` 持有唯一 `LocalQuickReplyStore`，连接管理页和终端输入面板共用同一设备回复库；
切换项目、终端、电脑、注销或删除连接不清理该库。列表支持手动新增、全文编辑、删除确认、
标题/正文搜索与排序；也可从当前文字草稿保存，不复制图片和远端附件路径。正文中的技能名称
只是文本，不解析、不自动执行。回复最多 500 条、正文最多 64 KiB UTF-8、标题最多 80 个字符。

回复以版本化 JSON 原子保存到 Application Support 的 `native-quick-replies/replies.json`，使用
设备文件保护并排除系统备份。读写在后台执行，写入成功后才发布新列表；失败保留原数据和编辑内容，
未知版本或损坏文件禁止覆盖并可重试读取。不请求 Backend 快捷库、不上传或同步；卸载与换机不保证恢复。

选择回复只填入本地编辑器；已有文字时明确选择追加、替换或取消，附件保留。仍需显式点击发送，
保持既有离线禁止发送、接受确认、输入不重试与 agent-aware 模式。回复库由输入面板呈现独立 Sheet，
不重挂底层终端；录音/转写忙时禁用进入，存储写入期间禁用关闭。发送前临时编辑不改写库原文。

带回复的草稿按连接/终端持久化禁止快捷历史的标记，非空编辑保守保留，清空文字或成功清理相同
草稿版本后移除。文字归档升级为版本化 envelope，与标记同文件原子写入；读取旧字符串字典时
默认无标记。`AppSession+Input.swift` 发送标记草稿时携带 `recordQuickInput: false`，确认按
connection generation、controller 身份和草稿 revision 隔离，同文新编辑不会被旧确认清空。
普通手打输入仍省略该字段。旧版 App 不保证读取新草稿格式，回滚前须备份设备数据。

后端先部署对应输入协议再更新手机；不支持字段的 strict-schema 旧 Backend 会在执行前拒绝，
手机保留草稿并提示，不删除字段重发、不绕到 raw 输入。实际文字仍交给 Backend 和终端/Agent，
“不收录快捷历史”不代表清除它们的日志或对话记录。验收入口为
[本地快捷回复](../../../docs/testing/app/ios-native-local-quick-replies.testplan.yaml) 与
[草稿隐私兼容](../../../docs/testing/app/ios-native-draft-privacy.testplan.yaml)。

## 终端图片草稿

`TerminalImageDrafts` 由当前 `AppSession` 持有，按 terminal ID 保存图片、上传状态和远端路径。
选图后在输入面板顶部显示可预览、移除的缩略图，上传失败可显式重试；多张图片按添加顺序排列。
上传通过既有 `clipboard-image` 接口完成，不改变文字草稿，也不触发终端输入。文字为空时图片也可发送，
但任何图片尚未上传成功都会阻止整条草稿发送。图片预览下采样至最长边 1600 像素，上传仍使用原始数据；
上传成功后释放用于重试的原始数据，100 MiB 单图限制与 Backend 一致。

点击发送时捕获文字与附件快照，将每个原始远端路径分别做 shell 单引号转义，再通过既有 `input` 一次提交。
确认成功只移除该快照中的附件，发送期间新增的图片和修改后的文字保留；失败不清空、不自动重发。
返回首页保留同一终端的草稿；删除终端、注销或删除连接时清理所属附件并取消上传，迟到响应不能恢复已移除图片。
切换连接先保存当前 scope，再恢复目标 scope。文字与附件保存在设备受保护、排除备份的本地目录，支持通知冷启动恢复；
文字变更合并写入，图片内容只在附件变化时写入。未完成上传恢复为可重试状态，不自动发送。移除附件不删除 Backend 临时图片，沿用服务端生命周期。

## Mac 电量与推送

首页与连接列表展示目标 Backend 的电量；提醒默认关闭。原生 `NotificationCoordinator` 管理用户授权、token、
Keychain 撤销凭据和通知点击。跨端身份、采样、告警与部署合同见 [设备监控](../../../docs/architecture/device-monitor.md)。

电脑本地页面通过可选宿主 lease、原生 CONNECT 和认证 WS 访问；协议、隔离与兼容边界见 [本地网页预览](local-browser.md)。
