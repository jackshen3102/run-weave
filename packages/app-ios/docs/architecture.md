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

| 入口                                                        | 职责                                                  |
| ----------------------------------------------------------- | ----------------------------------------------------- |
| `App/RootView.swift`、`Features/Connections`                | 导航、连接管理和主题                                  |
| `State/ConnectionStore.swift`                               | 本地连接列表与当前连接，不保存明文凭据                |
| `State/AppSession.swift`                                    | 当前连接、认证、Home、草稿和 generation；丢弃过期响应 |
| `Services/APIClient.swift`                                  | 规范化 endpoint、认证、HTTP 错误分类与请求            |
| `Features/Terminal/SessionController.swift`                 | 终端连接、输入确认、事件与资源释放                    |
| `Features/Terminal/EventStream.swift`、`Rendering`、`Input` | 传输、解析显示和用户输入分别归属                      |
| `Features/Preview`、`Features/Media`                        | 只读审阅、上传与转写，业务错误由所属区域展示          |
| `State/DiagnosticStore.swift`、`ios/Diagnostics`            | 日常脱敏日志与内部验证入口，二者分开                  |

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
点击后由系统 Sheet 覆盖终端并自动聚焦固定高度的大文本区；iOS 16 及以上提供半屏、全屏档位，
iOS 15 使用普通系统 Sheet。键盘只改变 Sheet 内部布局，底层终端保持挂载和原始 bounds，
因此打开输入、切换键盘或关闭输入不应产生 PTY resize；设备旋转等真实视口变化仍正常同步行列数。

文字与图片继续由 `AppSession` 按 terminal ID 持有，关闭 Sheet 不清空草稿；存在草稿时入口显示提示。
发送确认成功后关闭 Sheet，失败则保留面板、错误和草稿。Agent 执行期间终端右下角独立显示停止按钮，
不要求先打开输入面板。录音、麦克风权限请求或转写进行中时禁止交互关闭，避免视图销毁取消媒体操作。

## 终端图片草稿

`TerminalImageDrafts` 由当前 `AppSession` 持有，按 terminal ID 保存图片、上传状态和远端路径。
选图后在输入面板顶部显示可预览、移除的缩略图，上传失败可显式重试；多张图片按添加顺序排列。
上传通过既有 `clipboard-image` 接口完成，不改变文字草稿，也不触发终端输入。文字为空时图片也可发送，
但任何图片尚未上传成功都会阻止整条草稿发送。图片预览下采样至最长边 1600 像素，上传仍使用原始数据；
上传成功后释放用于重试的原始数据，100 MiB 单图限制与 Backend 一致。

点击发送时捕获文字与附件快照，将每个原始远端路径分别做 shell 单引号转义，再通过既有 `input` 一次提交。
确认成功只移除该快照中的附件，发送期间新增的图片和修改后的文字保留；失败不清空、不自动重发。
返回首页保留同一终端的草稿；删除终端、注销或切换连接时清理所属附件并取消上传，迟到响应不能恢复已移除图片。
附件与文字均为当前 App 进程的临时草稿，不跨 App 重启持久化。移除附件不删除 Backend 临时图片，沿用服务端现有生命周期。
