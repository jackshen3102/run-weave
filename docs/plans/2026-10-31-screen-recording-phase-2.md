# 屏幕记录二期：原生查看与时间回放实施计划

日期：2026-10-31。状态：实施中；原生 Mac、Backend、iOS 读取与回放代码已落地，正在进行隔离环境与模拟器验收，尚未全量通过。

范围依据：[整体计划](2026-10-31-screen-recording-plan.md)、[图片原型](../prototypes/screen-recording-phase-2/README.md)、[一期当前实现](../../packages/screen-recording-macos/README.md)。本文件是二期实现依据；与旧图片冲突时，以本文件的时间、应用标记和播放语义为准。图片仍是设计稿，不是已实现界面证据。

## 1. 交付目标和边界

在独立 ScreenJournal Mac App 与 Runweave iOS 中，查看一期已经保存的整屏记录。选日期、选时间段，播放快速回顾，暂停查看细节，通过胶片带和逐帧按钮定位。手机先在模拟器中连接本机真实 Backend 验证。

- 采集保持独立：关闭 Runweave、退出查看窗口、停止回放，都不停止采集。查看不需要模型，也不需要先生成工作事项。
- 手机复用 Runweave 当前连接、认证与令牌刷新；所有索引、缩略图及画面字节均经过同一授权链路。没有新的账号、配对码、手机令牌或服务地址。
- Mac 使用 SwiftUI／AppKit，iOS 使用 Runweave 内的 SwiftUI；不做 Web 页面或 Electron 展示。
- 只在线查看，不提供下载、视频导出、离线副本、预生成延时视频、云端镜像、AI/OCR、总结或随记写入。
- 保留一期媒体及数据库格式。默认 7 天与 10 GiB 清理规则继续生效，查看不能无限阻止过期或容量清理。
- “Mac 在线可查看”具体指 ScreenJournal 进程运行且读服务可用；采集暂停仍能查看 ready 数据，明确退出 App 后读服务不可用。Backend 不负责自动启动 App 或恢复录制。
- 当前连接必须是采集 Mac 上同一登录用户的 Backend；Linux Backend、其他机器或其他用户不自动转发到某台 Mac，返回能力不可用。

## 2. 已核查的代码现状

| 位置                                                             | 已有能力与二期缺口                                                                                               |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `ScreenJournalCore/StoreSchema.swift`、`RecordStore.swift`       | SQLite v1、WAL、captures／segments／sessions／state_events。可只读打开，但没有供浏览使用的分页、范围和可用性合同 |
| `StorageEngine.swift`、`InstanceLock.swift`                      | 单 writer 持有目录独占锁；负责提交、恢复和清理。不能为了查看放开第二个 writer                                    |
| `RetentionCoordinator.swift`                                     | 先标 deleting，再删媒体和索引；目前没有活跃解码协调。UI 单独打开文件会与清理竞争                                 |
| `SegmentReader.swift`                                            | verify 完整解码；image 使用 AVAssetImageGenerator 精确取单帧。不能每个播放 tick 重新创建 reader／generator       |
| `ScreenJournalInspect/main.swift`                                | extract／verify 要求共享锁，不能与运行中的 writer 并用；保留诊断语义，不将其改成在线服务                         |
| `ScreenJournalApp/RecorderModel.swift`、`ScreenJournalApp.swift` | 已有独立 App、菜单和配置，关闭最后窗口仍运行；没有记录浏览或本地读服务                                           |
| `backend/src/index.ts`、`auth/middleware.ts`                     | 已有 API 注册与 Bearer 鉴权；隧道请求仍遵循 requireTunnelAuth                                                    |
| `backend/src/bootstrap/runtime-services.ts`、`resource-scope.ts` | 已有资源装配、启动失败清理与退出责任；新增 Backend 适配层纳入该机制                                              |
| `RunweaveIOS/Services/APIClient.swift`                           | authorized 支持自定义 decode，可在原认证和刷新流程内接收二进制，不另开匿名 URLSession 或 AsyncImage URL          |
| `RunweaveIOS/Features/Home/HomeView.swift`、`App/RootView.swift` | 原生更多菜单、当前连接、session generation 已存在；没有屏幕记录入口                                              |

上表 Swift 路径分别相对于 `packages/screen-recording-macos/Sources/` 与 `packages/app-ios/Sources/`。一期存在不代表全天采集已在本轮复验；短跑、构建、fixture、模拟器和真机证据分别报告。

## 3. Dayflow 参考及采用方式

固定来源：[JerryZLiu/Dayflow@730d6f84b919998158ff7fdab15e3f032f7d8135](https://github.com/JerryZLiu/Dayflow/tree/730d6f84b919998158ff7fdab15e3f032f7d8135)。以下为源码核查，不是运行验收。

| 难点                     | 上游依据                                                                                                                                                                                    | 本项目决定                                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 回放与截图关系           | [ScreenshotSlideshow.swift](https://github.com/JerryZLiu/Dayflow/blob/730d6f84b919998158ff7fdab15e3f032f7d8135/Dayflow/Dayflow/Views/UI/MainView/ScreenshotSlideshow.swift)                 | 同一序列的大画面、胶片带、播放与倍速；不拆成视频和图库两个功能                                               |
| 播放时钟与拖动           | [ScreenshotSlideshowPlayback.swift](https://github.com/JerryZLiu/Dayflow/blob/730d6f84b919998158ff7fdab15e3f032f7d8135/Dayflow/Dayflow/Views/UI/MainView/ScreenshotSlideshowPlayback.swift) | 参考实际采集时间偏移、20×／40×／60×、拖动前播放状态恢复；本项目打开详情默认暂停，到末尾停止                  |
| 连续取帧                 | [FrameStore.swift](https://github.com/JerryZLiu/Dayflow/blob/730d6f84b919998158ff7fdab15e3f032f7d8135/Dayflow/Dayflow/Core/Recording/FrameStore.swift)                                      | 同段顺序请求复用 AVAssetReader；反向或远距离跳转重建 reader，按实际 PTS 确认命中帧，不能假定关键帧就是目标帧 |
| 响应速度与资源           | 同上回放引擎的 frame loader                                                                                                                                                                 | 参考下一两帧预取、16 帧缓存、旧请求结果丢弃；额外加字节预算和优先级，不照搬无界网络请求                      |
| 后台预生成视频           | [TimelapsePreferences.swift](https://github.com/JerryZLiu/Dayflow/blob/730d6f84b919998158ff7fdab15e3f032f7d8135/Dayflow/Dayflow/Core/Recording/TimelapsePreferences.swift)                  | 不采用；已有 MP4 是采样帧存储容器，二期不再生成一份回放视频                                                  |
| 远程鉴权、过期和清理竞争 | Dayflow 本机界面不能直接覆盖这些边界                                                                                                                                                        | 采用下文 Runweave 授权与单 owner 读取设计，不推断上游已解决手机场景                                          |

复用或改写上游代码时更新 `packages/screen-recording-macos/ThirdPartyLicenses/README.md` 来源映射，保留已有 MIT 文本与版权；若 iOS 直接移植代码，同步随 iOS 分发许可证。后续遇到未覆盖的实现疑点，先查同一固定提交的调用链，再记录采用／调整理由；不得凭文件注释宣称性能指标已通过。

## 4. 用户看到的内容

### 4.1 整屏与应用元数据

标题统一是时间段，例如“09:30–09:45 的屏幕记录”。当前画面标为“09:42:10 · 前台应用：Visual Studio Code”。前台应用 ID 来自 NSWorkspace，不是图像识别结果，不代表画面只有这个应用，也不代表它位于当前显示器。名称由 Mac 解析，找不到时显示“未知应用”；隐私帧不返回或显示应用名称。

预览按原始宽高比适配，不能为了卡片填满裁掉桌面边缘；缩略图允许裁切，但进入详情必须能看到完整画面。暂停后支持缩放／平移，iOS 支持横屏；继续播放回到适配画面，避免缩放位置掩盖新帧内容。原型中的应用大标题降为当前帧元数据，不作为整段标签。

### 4.2 日期、分组与回放范围

- 日期按采集 Mac 当前 IANA 时区解释，状态接口返回时区和每个日历日的实际 UTC 起止；跨夏令时日期不固定为 24 小时。客户端显示来源时区，当前帧仍保留采集时记录的 UTC offset。一天从 00:00 开始，不沿用 Dayflow 的分析日边界。
- 列表用本地日历 15 分钟窗口分组，不依赖 10 分钟物理媒体段。跨会话、显示器变化、时间戳回拨处拆分；同一窗口可以有多条，显示器作为副标签。范围 ID 必须包含这些边界，不能仅用显示时间作为键。
- 同一时刻并列记录保留 capture ID 与 session sequence 顺序；会话中时间回拨时开启新的单调区间，不用排序把历史帧悄悄接回原序列。前后端比较的是整数 UTC 毫秒，不是格式化时间字符串。
- 只读 ready 数据；writing 只贡献“最近记录整理中”状态。没有记录、已过期、媒体损坏、权限失败、服务未运行分别显示，不统称加载中。
- 打开时建立范围快照，包含该范围当时的 capture ID 和状态区间，后续新增 ready 帧不会改变当前轴。返回列表刷新后才进入新的范围；保留期限不会被快照延长。

### 4.3 播放状态机

状态为 loading、paused、playing、scrubbing、buffering、unavailable。打开加载首个可用帧后 paused；速度首次 20×，可切换 40×／60×，记住用户选择。实际时钟用单调时钟推进记录偏移，系统墙钟只用于展示和过期判断。

1. playing 时按目标时间找到不晚于目标的最近采样；重复时间戳取该区间 sequence 最后的帧。屏幕同步更新只替换变化帧，不能随刷新率发网络请求。
2. 拖动立即暂停时钟，保存拖动前状态。合并目标、取消过时请求；松开必须完成最终定位，再恢复之前 playing 或 paused。下一帧／上一帧定位真实采样并保持 paused。
3. 画面未到达进入 buffering，冻结播放时钟并显示加载反馈，不能继续走时间让旧画面冒充新时刻；恢复后从已显示帧推进。高倍速可跳过中间采样但最终拖动目标必须准确。
4. 到范围末尾 paused；再次播放从头开始，不自动跳下一条。页面退出、App 进入后台、连接切换或登出时停止并取消请求。
5. 采样之间可保持最近帧，当前帧时间单独显示；已知暂停／休眠／错误区间显示缺口，隐私区间显示通用锁形占位。事件不足时标“此区间无采样”，不推断“用户没有工作”。

一期未记录每帧的配置版本，不用当前采样间隔解释历史数据。无事件佐证且相邻帧超过支持的最大采样间隔 60 秒时，前一帧最多保持 60 秒，剩余区间标未知缺口；已知状态事件优先。最后一帧不向没有采样的时间无限延长，最新未封口区间显示整理中。最后一条 state_event 的结束时间不直接当作“持续到现在”，仅结合新鲜 runtime status 或明确后续边界延长。

## 5. 架构与本地读服务

```text
ScreenJournal App（独立生命周期、唯一 writer）
  ├─ StorageEngine：提交、清理、读取许可与可用版本
  ├─ JournalReadService：范围查询、取帧、缓存、快照
  ├─ Mac SwiftUI 回放 → 同进程 JournalReadService
  └─ JournalReadSocketServer：仅同用户 Unix domain socket
       ↑
Runweave Backend：现有鉴权 → ScreenRecordingClient → 本机 socket
       ↑
Runweave iOS：现有 APIClient → 原生列表与回放
```

选 Unix domain socket，不开额外 TCP 端口。Node 端通过 `node:net`，Swift 端通过 Darwin 的 AF_UNIX/SOCK_STREAM 与专用 I/O 队列实现；macOS 可用 getpeereid 校验对端 UID。依据：[Node IPC 文档](https://nodejs.org/api/net.html#ipc-support)、[Apple getpeereid 文档](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man3/getpeereid.3.html)。这条通道是本机同用户权限边界，不声称能隔离该用户启动的恶意进程。

- 标准路径 `<ScreenJournal 数据目录>/runtime/read.sock`；沿用父目录 0700、socket 0600，校验 owner、文件类型和路径无符号链接。启动前校验 sockaddr_un 长度，超长明确报错，不截断或回退公共网络。
- 获得一期 writer 锁并完成恢复后，才能清理本目录旧 socket 并监听；第二实例不能删除第一实例的 socket。Debug 隔离目录使用独立 socket。Backend 默认只找标准路径；开发验收允许进程级 `RUNWEAVE_SCREEN_JOURNAL_SOCKET` 覆盖，仅 Backend 启动环境读取，不能由 HTTP 请求指定。
- App 暂停采集仍保有读服务；退出先停止接受读请求、取消读取并等待资源退出，再执行原关闭逻辑。监听失败只令查看不可用并显式提示，不因此停止可用的采集链路。
- Backend 适配层按需连接，连接失败不阻塞整个 Backend 启动；非 macOS 直接报告 unsupported。关闭 Backend 只关闭自己的 socket 与请求，绝不退出 ScreenJournal。
- 本机协议 v1：请求和响应均为 4 字节大端 JSON 头长度、UTF-8 JSON 头、按头内 payloadLength 指定的二进制体。头上限 64 KiB、body 上限 8 MiB；请求字段 version、requestId、method、params，响应字段 requestId、status、code、payloadLength、contentType、serverEpoch。JSON 结果放 body，画面直接传二进制，不用 base64。
- 每条 socket 一次在途请求，不做流水复用；全局最多 4 条，空闲 15 秒关闭。请求总期限 5 秒，超时／取消关闭本请求连接，服务端取消对应任务；非法头、超限或未知版本在解码媒体前拒绝。使用长度解析状态机，不能假定一次 read 得到完整报文。
- 不转发手机 Bearer 给 App，不允许客户端传 SQL、任意路径或启动／停止采集指令。Backend 只转发固定 method 和已验证参数。

### 5.1 并发读取与清理

单 writer 锁及现有恢复流程不变。在线读服务属于持有该锁的 App，由 StorageEngine 核验 ready／期限并获取按 segment 的读取许可；短查询可使用独立只读 WAL 连接，但所有“允许打开文件／删除”的判定由同一 owner 串行协调。不能在 MainActor 或 StorageEngine actor 上执行耗时解码，不能持有长读事务跨越媒体解码。

读取许可不是无限保留租约：当前请求持有许可直到实际解码退出；reader 不预先占用未来段。清理先将段标 deleting、使快照与缓存失效、拒绝新读，再取消在途读取；只有引用数归零才删除文件和索引。取消／5 秒超时不等于解码器已退出，不能提前释放许可后删除仍在读的文件。异常 reader 未退出时保留最小受影响段，报告 read_cleanup_pending，并继续清理其他候选；容量或磁盘底线仍不满足则沿用停止新采集策略，不能跳过上限。诊断工具的锁规则不变。

每次请求返回前再次核验段可用性及请求代际；清理期间完成的旧结果不能送到 UI。清理完成后调用原恢复／checkpoint 规则，崩溃留下的 deleting 段仍由一期恢复处理。schema 保持 v1，不增加持久化快照、第二份媒体库或永久删除墓碑。

### 5.2 解码、缓存和在线有效性

- 新建有状态 PlaybackFrameReader，顺序复用 reader；跨段、向后、远跳或变更目标尺寸时取消旧 reader。每个结果校验实际 PTS 对应 frame_index；使用异步 AVFoundation API，不复制上游的阻塞主线程等待方式。单帧精确读取可复用一期 generator 作为诊断或随机读取回退。
- 每个设备的本地读服务最多 2 个解码任务，交互定位优先于预取；每个视图只预取接下来 2 帧。拖动目标最多每秒 15 次实际派发，最终落点不节流；每个视图只保留 1 个待处理最新目标。
- 解码缓存键为 deviceID、serverEpoch、captureID、variant，最多 16 帧且 128 MiB，先达到即淘汰；缩略图额外最多 16 MiB。Backend 不做媒体缓存；iOS 内存图像缓存最多 16 帧／64 MiB，缩略图 8 MiB，不写磁盘或相册。大图传输优先 JPEG，thumb 高度 180、preview 高度 540、full 保留采集分辨率，均保持宽高比、不放大，质量先定 0.85；测量文字可读性后再调优。
- 所有 HTTP 响应 `Cache-Control: no-store`，iOS 使用现有 ephemeral transport 和内存缓存；缓存命中仍要求当前连接与范围可用性有效。不能绕过 APIClient 发送不带鉴权的图片请求。
- 活跃页面每 2 秒核验可用性／删除版本；每次播放、拖动、前后台恢复先核验。手机确认离线、服务失败或校验超时就暂停并隐藏画面／胶片带；最近一次有效确认超过 5 秒也隐藏，不以本地图片继续回放。网络断开到发现之间最多存在该检测窗口，不宣称物理断网瞬间已获知。
- 明确返回的过期时间到达立即失效；容量删除通过可用性响应发现并清除对应缓存。手机不承诺比 2 秒轮询更快感知远端删除；服务端删除后立即拒绝新媒体请求。重连刷新范围后保持暂停。进入后台清空画面及缓存，不长期保留个人屏幕内容。
- Mac 同进程直接订阅读取协调器的失效事件，不依赖手机轮询；列表、详情和解码缓存都清除已失效 capture。

## 6. HTTP 与跨端数据合同

新增 `packages/shared/src/screen-recording/index.ts` 并导出 `@runweave/shared/screen-recording`；Swift Codable DTO 对照相同序列化合同。协议 version=1，时间统一整数 UTC 毫秒；路径、凭据和 SQLite 内部错误不出现在响应中。

所有路径位于 `/api/screen-recording`，按 `requireTunnelAuth → requireAuth → 参数校验 → 本机适配` 注册。status 也必须鉴权。一次本机请求只能访问当前 Backend 所属用户的本机记录。

| 方法与路径                             | 输入                                                  | 输出及边界                                                                                                                                                                                                                            |
| -------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET `/status`                          | 无                                                    | version、availability（ready/notRunning/unsupported/incompatible）、deviceID、deviceName、timeZone、serverEpoch、catalogRevision、captureState、retentionDays、可用日期边界、最新 ready 时间、hasPending；notRunning 不表示采集库为空 |
| GET `/days`                            | cursor 可选，limit 默认 7／最大 30                    | 有记录的日期及 UTC 起止、nextCursor；首次 cursor 绑定 catalogRevision，期间变化返回 409 重新查询，不无声跳页                                                                                                                          |
| GET `/ranges`                          | day=YYYY-MM-DD、cursor 可选，limit 默认 100／最大 200 | 按 4.2 分组的 rangeID、startMs/endMs、displayID、sampleCount、previewCaptureID、状态、nextCursor；分组不以某个应用命名                                                                                                                |
| GET `/ranges/:rangeID/thumbnail`       | catalogRevision                                       | 列表预览专用，重新校验范围后取其中一个非隐私代表帧的 thumb；全隐私范围返回 PRIVATE_FRAME，由 UI 绘制占位；不为每个可见列表行占用一个 view                                                                                             |
| POST `/views`                          | rangeID、catalogRevision                              | 创建只读内存快照：viewID、serverEpoch、deviceID、range、captures、intervals、expiresAt；catalog 已变化返回 409，客户端刷新后重开                                                                                                      |
| GET `/views/:viewID/availability`      | 无                                                    | checkedAt、expiresAt、invalidCaptureIDs、intervals、viewState；供在线核验、清理和过期提示                                                                                                                                             |
| GET `/views/:viewID/frames/:captureID` | variant=thumb/preview/full                            | 二进制 JPEG，Content-Type 与长度正确；ID 必须属于快照且当前可读，隐私占位不返回原内容，使用明确 PRIVATE_FRAME 状态由 UI 绘制通用占位                                                                                                  |
| DELETE `/views/:viewID`                | 无                                                    | 幂等释放快照与预取，已不存在也成功；只删除内存视图，不删除原始记录                                                                                                                                                                    |

`captures` 每项包含 id、sessionID、sequence、capturedAtMs、timezoneOffsetSeconds、displayID、frontmostApplication（id/name 可空）、privacyPlaceholder、availableUntilMs。存储 segmentID/frameIndex 只留在 Mac 内部。`intervals` 用 startMs/endMs 与 kind=privacy/paused/systemInactive/error/unknown 表达状态，不能包含敏感应用名称。

一个 view 最多 900 帧（15 分钟、最密 1 秒采样），超过时在范围查询阶段拆分，不截断结果。全局最多 8 个 view，索引总量上限 8 MiB，空闲 60 秒或绝对存活 30 分钟释放；活跃核验续空闲期，不延长原始数据期限。新请求超额返回 busy，不抢占现有视图。view 由 Backend 绑定到现有认证主体与 connectionID；同一主体并发 view 也不能借 ID 跨 Backend、deviceID 或 serverEpoch 读取。App 重启产生新 serverEpoch，旧 ID 全部失效。

错误响应统一 `{code,message,retryable}`：400 参数错误；401/403 沿用现有认证语义；404 unknown ID／不属于当前 view；409 catalog changed／view expired；410 该 view 原本包含但已过期或清理的帧；422 private frame；429 并发／容量忙；503 本机服务未运行或媒体暂不可用；504 超时。媒体损坏返回明确 MEDIA_UNAVAILABLE，不能伪装成过期。查询没有记录返回正常空数组。旧 Backend 不认识路由返回 404 时，手机提示需更新，不能重建登录。

手机媒体调用在 APIClient 内增加 Decodable 的二进制包装类型，利用现有 `authorized(..., decode:)`，保留 Bearer 刷新、X-Connection-ID、redirect guard 与 revision 失效检查；不要复制一套认证。viewID 仅是查询作用域，不是访问凭证；每个请求仍鉴权。X-Connection-ID 是作用域元数据，不能单独充当授权依据。

当前 requireAuth 只验证并放行，没有把主体附到 Request。记录路由可使用现有 `readBearerToken` 和 `authService.verifyAccessToken` 取得已验证 sessionId／username，将 view 所有权绑定 Backend 实例与 sessionId；App 会话再通过 `getActiveAppSession(sessionId)` 取得服务端保存的 connectionId，与请求头比对，不信任调用者自报身份。令牌刷新保留 sessionId，因此不丢 view；注销撤销会话后所有媒体读取立即被拒绝，内存 view 按释放或超时回收。不必为此重写全仓鉴权中间件。

## 7. 文件范围与实施顺序

新增文件名是建议落点，允许在同一职责目录内调整；协议和外部行为不得因此变更。实现前重读各目录 AGENTS，保留已有改动。现在的 Mac 包规则只允许一期采集，实施 2.1 时同步扩展职责为本地只读，2.2 再加入 Mac 浏览；不把 iOS 源码放入 Mac 包。

### 2.1 记录读取、清理协调与协议

- [x] 在 `ScreenJournalCore/JournalReadService.swift`、`JournalReadModels.swift`、`JournalReadCatalog.swift` 实现范围、日期、快照和实际时间语义；`RecordStore.swift` 添加参数化只读查询，不引入动态 SQL 或数据库迁移。
- [x] 新增 `SegmentReadCoordinator.swift`、`PlaybackFrameReader.swift`；在 `StorageEngine.swift`、`RetentionCoordinator.swift` 接通读取许可、取消与失效。必要时修改 `RecoveryCoordinator.swift`，仍保持一期恢复顺序。
- [x] 新增 `JournalReadSocketServer.swift`；通过 `RecorderModel.swift`／`CaptureCoordinator.swift` 持有共享读服务，避免第二个 StorageEngine。生命周期无查看请求时不占解码器。
- [x] 定义 shared DTO 与 Swift 对照结构，新增 `tools/verify-read-service.swift` 独立集成入口，通过 `project.yml` 的 `ScreenJournalReadVerify` scheme 构建；此工具只接收显式隔离目录和 socket，不默认读取正式目录，不是单元测试。
- [x] 扩展 `tools/make-validation-fixture.swift` 的 playback 场景，生成已知帧号、实际时间、跨段、隐私占位、缺口、回拨与夏令时样本。不能用 fixture 替代真实采集。
- [ ] 通过读取服务验收用例后交付；必须在 writer 运行中取到已封口帧，不能以暂停退出 writer 后 extract 成功代替。

### 2.2 Mac 原生回放

- [x] 在 `ScreenJournalApp/ScreenJournalApp.swift` 增加“查看记录”窗口和菜单；新增 `Views/JournalBrowserView.swift`、`JournalPlaybackView.swift`、`JournalFilmstripView.swift` 与 `JournalPlaybackModel.swift`，直接消费同进程 JournalReadService。
- [ ] 实现第 4 节所有行为、日期与空状态；播放器使用单调时钟和低成本图层更新，UI 错误不能停止采集。
- [ ] 在独立验证目录实际采集、打开回放并取证。关闭查看窗口后核对采样计数继续增长；暂停采集后旧记录仍可看。
- [ ] 更新原型中的应用标记与整屏适配，在实际截图中确认不裁切大画面；产出真实 Mac UI 截图与操作记录，不能交付生成图冒充。

### 2.3 Backend 与 Runweave iOS

- [x] 新增 `backend/src/screen-recording/client.ts`、`service.ts` 与 `backend/src/routes/screen-recording.ts`；在 `index.ts` 注册鉴权路由，在 `bootstrap/runtime-services.ts` 和 `runtime-services-contract.ts` 接入资源清理。只在请求时连接 App，Backend 启动不依赖 App。
- [x] DTO 导出更新 `packages/shared/package.json`；参数校验、HTTP 错误映射、请求中止与本机取消完整连通，不记录凭据、画面或本地路径。
- [x] 新增 iOS `Contracts/ScreenRecording.swift`、`Services/APIClient+ScreenRecording.swift`、`Features/ScreenRecording/` 下的列表、详情、胶片带和 view model。只有需要通用二进制包装时才修改 APIClient 主文件。
- [x] 在 HomeView 更多菜单增加“屏幕记录”；使用现有 session／RootView 连接作用域。每次请求绑定 connectionID、generation、serverEpoch、viewID、request generation；迟到结果先校验再显示。
- [ ] iOS 实现在线核验、后台停止、身份切换清理、缩放和横屏；状态说明区分 Runweave 断线与记录服务未启动。
- [ ] 按共享模拟器池申请设备，以当前源码构建安装，通过真实 Backend 和真实 ready 帧验证完整链路，最后释放本任务设备。真机与外网验证不在本期结论内。

### 收尾与兼容

仅增加读能力；Mac App 与 Backend 任一读能力关闭都不改变采集意图。Mac 协议版本不匹配返回 incompatible，不尝试写 schema 或降级匿名读文件。回滚二期代码只失去浏览，保留一期数据库和媒体。更新包 README、就近 AGENTS、来源映射及 `docs/architecture/README.md` 的当前能力描述；完成后按文档治理迁移有效合同，再删除已完成的临时计划。

## 8. 验收与验证方式

配套合同：[读取与服务边界](../testing/screen-recording/read-service.testplan.yaml)、[原生回放与手机链路](../testing/screen-recording/playback.testplan.yaml)。这些是二期待实现要求，不是已通过用例；保留一期[采集与存储合同](../testing/screen-recording/capture-storage.testplan.yaml)，修改清理／退出链路后对受影响用例执行回归，不新增单元测试。

实施阶段的静态与构建入口：

```bash
packages/screen-recording-macos/build.sh --configuration Debug --derived-data-path .runweave/screen-recording/build
pnpm --filter @runweave/shared typecheck
pnpm --filter @runweave/backend typecheck
pnpm --filter @runweave/backend lint
pnpm architecture:check
pnpm docs:check
```

新增验证工具实现后用 Xcode 构建 `ScreenJournalReadVerify` scheme，输出到同一 DerivedData；入口约定 `ScreenJournalReadVerify --socket ABSOLUTE_PATH --fixture-manifest ABSOLUTE_PATH`，无参数拒绝运行。它验证协议与合成内容，不自动启用采集、关闭别人的进程或接触正式数据库。真实采集需要现有 `--team TEAM_ID` 签名路径与系统权限，不能把临时签名构建通过当作权限可用。

原生操作：Mac 使用 CUA；iOS 按 [共享模拟器流程](../cli/ios-simulators.md)申请任务目录，通过 `node packages/app-ios/scripts/ios.mjs run --task-dir <本任务绝对目录>` 构建安装，使用 `$toolkit:agent-device` 交互，结束执行池的 finish。如确需启动 Runweave Dev Session，先使用对应技能，不能凭计划直接附着未知实例。

性能以真实记录测量：默认 10 秒采样、1080 高度，连续回放与拖动 10 分钟，记录首帧和最终定位延迟、内存峰值、Mac CPU、网络字节、待处理解码数与采样缺失。设计目标为本地／模拟器同机链路首帧和最终定位 p95 ≤1 秒、取消后无旧帧覆盖、缓存与并发始终不超过上限；这是验收目标，不是 Dayflow 或当前实现的性能结论。弱网允许 buffering，不允许无限队列或自动降成离线模式。若目标未达，先调整解码复用和尺寸，不删掉回放能力来宣告完成。

最终报告分别列出：静态检查、构建、隔离数据读写协调、Mac 真实操作、模拟器真实操作、资源测量；每项附证据与未覆盖范围。出现阻塞保留对应未通过状态，不以图片原型、fixture 或构建结果代替。每次修改只重跑受影响验证与明确回归项，避免无依据重复全天测试。
