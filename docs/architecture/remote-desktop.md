# RemoteDesk（Mac 局域网远控）

RemoteDesk 是独立的 Mac 原生远控 App；现有 Runweave iPhone App 作为客户端，连接用户明确配对的 Mac Host。终端、文件和
Commands 继续使用原 Backend；远控视频不经过 Backend 或 Electron 的 HTTP 网关。已配对 Host 可选用 Runweave 管理的 Devbox 内网/VPN TCP 中转，TLS 始终在手机和 Mac Host 之间终止。
Host 的在线状态与 Backend 健康、登录状态分别判断，Backend 离线时仍可显式选择已配对 Host。

```text
packages/app-ios
  RootView → RemoteDesktopCoordinator → fullScreen 桌面 / 配对管理
  TerminalScreen ── 仅提供快捷入口 ──┘
                         │
             packages/remote-desktop-ios
                  TLS 控制 / TLS H.264 视频
                         │
             packages/remote-desktop-host
                  ScreenCaptureKit → VideoToolbox
                  校验当前会话输入 → CGEvent

packages/remote-desktop-protocol：两个 Swift 运行时共用的线协议
```

## 边界与身份

这是 iOS 原有“业务只通过 Backend HTTP/WS”边界的一项限定例外：
[`Features/RemoteDesktop`](../../packages/app-ios/Sources/RunweaveIOS/Features/RemoteDesktop/RemoteDesktopCoordinator.swift)
只装配独立远控包，提供目标、呈现和生命周期；不向包传入 AppSession、TerminalController
或 Backend token。远控包不导入 Backend、Electron 或 Web 实现。手机 Bundle ID 仍是
`com.runweave.app.native`，没有第二个移动 App。

`RemoteTarget.id` 是 Mac Host 身份，不是 terminalID、projectID 或 Backend connection ID。
初次配对从已核对证书 pin 的 TLS 响应取得真实 Host ID；后续控制同时校验 Host ID、证书
指纹与该手机的专属 credential。机器名只是给用户辨认的标签，不承担认证。

普通设备偏好 `native.remoteHosts.v1` 只保存机器名、独立 host/port、证书 SHA-256 指纹、
Host ID、credential 引用及可选 Backend connection ID。长期远控凭据属于独立 Keychain
service `com.runweave.remote-desktop.credentials.v1`，不沿用 Backend 的凭据标识。
编辑 IP/端口保留原 Host 身份与 pin；不通过替换 Backend URL 端口来选择电脑。

已配对会话每次连接与重试先用 Host ID 解析局域网 Bonjour 服务
`_runweave-rd._tcp`（`local.`），再校验原 TLS pin、Host ID 与专属 credential；
发现结果不授予信任，也不覆盖配对身份。视频使用本次控制连接的实际端点。
发现三秒内不可用时回退保存的显式地址，以兼容旧 Host 或不支持 mDNS 的网络；
证书校验失败直接终止，不回退。Mac 所选接口的 IPv4 变化时结束旧会话、释放输入、
失效配对邀请并用原身份重新监听；网卡断开则等待同一接口恢复，不切换接口。
用户停止共享后取消自动恢复。该发现机制解决同一局域网内的地址变化；局域网不可达且允许备用连接时，再尝试下述隧道入口。

电脑级管理入口在登录与离线界面均可用；终端快捷入口只在恰有一个明确关联的已配对 Host
时直接打开，否则由用户选择。远程画布占满可用区域，悬浮工具栏可拖动贴边、收起并记忆位置；
会话菜单显示被控 Mac、连接状态、输入模式、统计和手势帮助，键盘按需打开。
“返回终端”或“返回”入口在工具栏收起后仍可见；退出不改变原终端导航、Tab 或草稿。
隐藏页面或移除原生视频层立即停止旧媒体和输入，重新进入建立新的呈现代际。
界面合同以[原生控件](../../packages/remote-desktop-ios/Sources/RunweaveRemoteDesktop/RemoteSessionControls.swift)
为准；[历史原型](../prototypes/remote-desktop-mobile/README.md)不代表当前实现或真机验收。

## Devbox 内网/VPN 隧道

Runweave「端口与隧道 → 编辑 SSH 主机 → RemoteDesk」独立启用远控中转。复用该主机的
系统 SSH 配置、连接意图、重连与退出清理；不要求启用 Backend 的「远程访问本机」。
关闭 Runweave、断开 SSH 主机或关闭此开关会停止自有隧道。Host 仍需由本机用户启动共享，
配对、控制授权、撤销与输入 lease 均由原 Host 处理。

```text
手机（LAN/蜂窝 + 所需 VPN） → Devbox 内网 TCP 入口
  → SSH -R 回环监听 → 当前 Mac 的 LAN 地址:RemoteDesk端口 → 原 Host
```

配置记录独立的中转 IPv4/端口、本机 Host IPv4/端口和完整 SHA-256 证书指纹。
开启 RemoteDesk 后，表单自动读取本机 Host 地址、端口和证书指纹，无需手填这三项；
服务未启动或 Host 版本不支持时提示启动或更新，可点击“重新获取”。保存前再次读取并核对原指纹。
自动配置设置 `autoDetectLocalHost=true`，每次连通检查读取当前本机地址；地址变化时重建隧道，
证书指纹变化则拒绝连接，不自动替换原身份。旧配置未设置此字段时保留手动地址行为。
中转地址限定 RFC1918；本机地址还必须属于当前 Mac 的非回环 IPv4 接口。
RemoteDesk 与 Backend 入口不能共用相同地址/端口。旧手动配置在 Mac IP 变化时报告需更新 Host 地址，
自动配置只跟随同一证书身份的本机 Host，不猜测另一台电脑、不跳过证书检查。Devbox 需能通过 SSH 执行 Node.js 并允许反向转发；
Mac 和手机均需可达入口。中转只透传字节，控制和视频保持独立 TLS 连接、共用同一个入口。

本机发现合同为 `~/Library/Application Support/RemoteDesk/local-host.json`（schemaVersion 1）：
Host 在监听就绪、停止和网络恢复时原子发布 `pid`、`running`、`localAddress`、`localPort`、
`certificateFingerprint`，目录/文件权限分别为 0700/0600；模拟器专用 Host 不发布此文件。
Electron 只读取当前用户的固定路径，检查权限、进程存活和本机网卡地址，不通过网络首次获取 pin。
本机读取不发起 TLS；实际隧道仍以保存的 pin 验证 TLS、证书有效期与自签名。
文件不包含私钥、设备凭据或配对邀请，不授予观察/控制权限。

手机先按原流程在局域网配对，再在「Mac 桌面 → 编辑地址」开启「允许隧道备用连接」，
填写中转 IPv4/端口。普通偏好中的可选 `RemoteTarget.relay` 保留原 LAN 地址、Host ID、pin
和 credential 引用；`relayEnabled` 保存是否允许备用连接，关闭后仍保留已保存的中转入口。
旧数据缺少该字段时，有 relay 默认允许备用连接，无 relay 保持仅局域网行为。每次连接与重连
均先尝试 Bonjour 与保存的 LAN 地址：发现最多 3 秒，各 LAN TLS 连接最多 3 秒；网络不可达或
超时后才尝试隧道（TLS 连接最多 10 秒）。仅实际隧道连接允许蜂窝/VPN 路由，LAN 仍限制为局域网。
编辑仅在保存时生效，取消不修改配置。视频跟随本次控制连接的实际端点与路由，会话菜单显示
当前线路。两条线路网络连接均失败时分别显示原因；身份、认证与协议错误直接报告，不换线路
掩盖错误。收到不支持的远控协议版本时显示兼容性错误，网络故障不归类为版本不兼容。

每 15 秒的连通检查仅建立 TLS、核对固定证书、有效期与自签名，不携带设备 token，不开始采集。
“中转入口与 Host 证书已验证”不等于手机已连接或已取得画面/控制。一次超时保留已验证通道，
连续三次超时或明确断开/身份错误才重建；执行器状态过期时清空远控入口的可用状态。
远端 TCP 中转最多接纳 8 对连接；应用心跳停止超过 45 秒后在下一次 5 秒检查退出。

实现入口：[远控通道](../../electron/src/tunnels/remote-desktop-channel.ts)、
[生命周期](../../electron/src/tunnels/remote-desktop-owner.ts)、
[手机路由](../../packages/remote-desktop-ios/Sources/RunweaveRemoteDesktop/RemotePairedConnection.swift)。

## 会话、权限与隐私

仅一个当前控制会话。宿主以 Host ID、generation 与 presentation ID 隔离回调；退出、
后台、切电脑或 Backend 会话失效停止旧媒体和输入。后台恢复以新 generation 建会话，
不会补发历史点击。Host 控制租约负责客户端断网或被杀后释放合成输入；本地停止与撤销
是 Host 自己的控制权边界，不依赖手机能完成善后。

首次配对优先在 Mac Host 点击“连接 iPhone”，手机在“Mac 桌面 → 扫码配对 Mac”扫描
本机窗口的二维码，自动取得端点、真实 Host ID、证书 pin、窗口 ID 与一次性码；
二维码只用于发起请求，仍需在 Mac 本地确认手机，默认只读。相机不可用时保留手动填写
并核对 Mac 本地显示的完整指纹和一次性码。可选终端关联在扫码保存后设置。

二维码类型为 `runweave.remote-desktop-pairing`，版本 1，JSON 最多 4096 字节，
不包含长期凭据或 Backend 登录态。手机拒绝误扫登录码、未知版本与无效端点。
扫描自己的 Mac 本地屏幕承担初次 pin 传递，不是网络上的 trust-on-first-use。
Host 的单调时钟限制 120 秒窗口；刷新、取消、批准、断连、停止、睡眠和到期失效邀请。
扫码 TLS 消息携带并回显 `pairingWindowID`，手机保存前校验 Host ID、窗口与设备身份。
缺少窗口 ID 的旧客户端仍可按原六位码流程手动配对；旧 Host 使用手动入口。
两条路径共用 Keychain → 目标元数据保存逻辑，保存失败清理新 credential，重配保留原有
终端关联并在成功落盘后删除旧 credential。取消/后台隔离旧异步结果，不自动打开桌面。

系统 TLS 承担传输保护，不默认接受任意自签证书，不把 token 放 URL。控制与视频使用
分开的连接。手机“忘记本机配对”删除其 credential 引用；彻底撤销设备授权须在 Mac
Host 本地执行，界面明确区分两种操作。Host 不创建隧道；可选的 TCP 转发由 Runweave 桌面端管理，不自动开启 Host 共享。

屏幕录制决定能否观察，辅助功能决定能否输入；没有首帧不能报告可控。首版只使用当前
已存在的一个显示器、H.264、已登录的 Mac 图形会话。音频、虚拟屏、公共互联网入口、浏览器与
Agent 控制不属于首版；不降低 SIP/AMFI，不承诺 FileVault、Touch ID 或系统安全弹窗
都可远控。

远控与配对全屏在宿主整体 `clarityMask()`，原生视频 layer 另设 `preventsCapture`。
后者不能替代 Clarity 云端回放验收。screen 分类固定为 `remote_desktop`、`remote_hosts`
和 `remote_pairing`，不包含机器名、Host ID、endpoint 或输入正文。日志只保留非敏感
状态、尺寸、时序与计数，不记录帧、文本、配对码或 credential。

独立客户端 Package 仍声明 iOS 15；现有 App target 已声明 iOS 18.6，本次没有提高它。
Host target 声明 macOS 15。构建、安装、启动、原生交互、真实硬件编解码、Wi-Fi 与
Clarity 云端回放分别取证，任何一层成功都不能替代另一层。

## 使用记录与分析口径

“Mac 桌面 → 桌面使用记录”保留最近 100 次打开，每次最多保留最近 20 段已结束连接明细；
总尝试数、首帧次数与已结束连接的输入/帧计数不随明细裁剪重置。记录独立保存在手机
Application Support 的 `RemoteDesktopUsage/records.json`，异步原子写入、排除备份，
可在界面导出 JSON 或清空，不依赖 Backend 在线。异常退出可能丢失尚未落盘的变化；
下次启动把未关闭记录标为 `interrupted_unknown`，不猜测结束时间与任务结果。
原文件无法解析时保留它，仅在内存记录新使用并展示警告，直到用户显式清空。

一个 `id` 对应一次远控页面呈现；网络重试、同次呈现的前台恢复只增加 `attemptCount`。
`visibleAttemptCount` 以显示层就绪且可见为依据；`firstVisibleFrameMilliseconds` 是
**首次出现画面的那段连接**从开始到显示就绪的单调时钟耗时，不含此前失败尝试，
也不是端到端输入延迟。`readOnlyAttemptCount` 统计首次显示时只读的连接，
`controlPermissionLossCount` 统计辅助功能权限撤销后的降级。
`inputObserved` 表示至少一条客户端输入发送完成，不证明 Host 接受或应用完成操作。
精确输入计数和连接时长只汇总已结束的连接，不能拿它们当用户点击数、前台活跃时间或任务成功率。

导出顶层 `schemaVersion: 1` 与 `records`；时间使用 ISO 8601。记录包括安装构建身份、
`environment`（device/simulator）、连接汇总、最近连接结束时间和固定原因分类。
不包含机器名、地址、Host/Backend 身份、配对码、凭据、按键/文本/坐标或桌面画面。
`connection_lost` 只代表客户端观察到连接丢失，不能据此断言 Wi-Fi、Mac 睡眠或锁屏。
`connection_timeout` 表示 TLS 连接未在 10 秒内建立；超时与建立后断开分别记录。
旧版本的 `connection_lost` 也可能包含建连超时，不回填原因。手机的记录详情展示最近连接尝试的
结束原因、时长和是否出现画面，用于定位反复重连；这些明细不改变会话级 Clarity 事件口径。

每条记录允许事后选择 `purpose` 与 `outcome`；默认均为 `unknown`。
“处理 Agent 卡点”是用户填写的目的，不表示发生了 Agent 自动交接。
反馈仅随本地记录导出。分析先按 environment、构建和时间区间分组，列出打开次数、
有画面次数、有输入次数、连接结束原因，以及已填写/未知反馈数量；结果比例必须注明分母。
优先看反复出现的具体使用目的及未解决情况，再决定是否建设专门的接管 Agent。

Clarity 沿用原有构建开关，只发送固定事件：配对保存、打开、首次画面、首次发送输入、关闭。
首次画面与输入事件在每次打开内各至多一次；配对事件表示本机凭据及元数据保存成功。
Clarity 会话与远控打开不是同一单位，固定事件没有本地记录 ID；云端趋势不能代替导出记录
做精确会话归因，SDK 接受事件也不等于云端入库成功。

## 运行与验收

Host 构建、签名、授权、启动、停止和撤销操作见
[Host README](../../packages/remote-desktop-host/README.md)；客户端包边界见
[iOS 远控包](../../packages/remote-desktop-ios/README.md)。现有手机 App 沿用
[iOS 构建安装入口](../../packages/app-ios/README.md)，模拟器仍申请共享设备池。

验收合同对应交接 A01–A16：

- [会话与宿主生命周期](../testing/remote-desktop/session.testplan.yaml)：A01–A05、A14。
- [输入与媒体](../testing/remote-desktop/input-media.testplan.yaml)：A08–A11、A15。
- [配对、权限、隐私与来源](../testing/remote-desktop/security-source.testplan.yaml)：A06–A07、A12–A13、A16。
- [扫码配对](../testing/remote-desktop/qr-pairing.testplan.yaml)：真实相机、邀请失效、身份绑定与手动备用。
- [使用记录](../testing/remote-desktop/usage.testplan.yaml)：连接归并、未知结果、反馈、导出与云端事件。

每项只能依据完整证据记 pass，行为不符记 fail，缺环境或证据记 blocked。模拟器里的
真实 Host/H.264 闭环只证明对应原生链路；不能替代真机 Wi-Fi、硬件编码、温度/功耗、
锁屏和至少十分钟持续运行。端到端可见延迟需要独立的测量方法和误差说明，RTT、
sample 提交和本地指针反馈不等于 Mac 应用响应。

## 来源账本

阅读顺序不构成项目质量或性能排名。原始交接文档与含全部 16 个项目的 JSON 索引保存于
本地 ignored `.runweave/remote-desktop-implementation/`；其中 `license_evidence`、
`review_level`、`observed_revision` 与 `runtime_tested_by_this_handover` 保持原证据边界。
候选索引的日期为 2026-10-03，记录的是源码/文档研究，不能用来认定本地 runtime 通过。

| 范围                     | 固定上游                                                                                         | 实际用途与许可                                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| Host 编码及采集参考      | [Mirador](https://github.com/arniesaha/mirador/tree/4cc5c0faddcf4ed87599fbd7cba96e5d9bd4285d)    | 主实现来源，MIT，2026 Arnab Saha；保留 [Host 许可](../../packages/remote-desktop-host/ThirdPartyLicenses/Mirador-MIT.txt) |
| iOS 解码、呈现与输入参考 | 同一 Mirador SHA                                                                                 | 选择性改造，MIT；保留 [iOS 许可](../../packages/remote-desktop-ios/ThirdParty/Mirador-LICENSE.txt)                        |
| 配对与输入对照           | [MacRemote](https://github.com/waiyan0x/MacRemote/tree/274901a7d25aead9d58d557ba859b71d031ffe84) | 读取 MIT LICENSE（2026 Wai Yan）及原生输入/连接源码；没有复制其密码协议或代码                                             |

```yaml
component: native-ios-remote-desktop
upstream_repository: https://github.com/arniesaha/mirador
upstream_commit: 4cc5c0faddcf4ed87599fbd7cba96e5d9bd4285d
files:
  - source: clients/Mirador/Sources/H264Decoder.swift
    local: packages/remote-desktop-ios/Sources/RunweaveRemoteDesktop/H264Decoder.swift
  - source: clients/Mirador/Sources/InputCaptureView.swift
    local: packages/remote-desktop-ios/Sources/RunweaveRemoteDesktop/RemoteNativeSurface.swift
  - source: clients/Mirador/Sources/RemoteSession.swift
    local: packages/remote-desktop-ios/Sources/RunweaveRemoteDesktop/RemoteDesktopSession.swift
license_file: packages/remote-desktop-ios/ThirdParty/Mirador-LICENSE.txt
third_party_dependencies:
  - Local RunweaveRemoteDesktopProtocol; Apple system frameworks only
local_changes:
  - Keep Annex-B splitting and CoreMedia sample construction; add actual VideoToolbox decoding
  - Await one decode per video read; coalesce decoded presentation frames independently; retain decoder epoch, format and IDR recovery
  - Explicit display geometry/contentRect/revision and view-owned native layer
  - Reimplement paired TLS dual-channel session, bounded input and presentation invalidation
verification_evidence:
  - Fixed upstream checkout and LICENSE read; source headers preserve adaptation attribution
  - Runtime verdicts require the three remote-desktop YAML plans and actual run artifacts
```

同版 Mirador 的 `VideoSurface`、`VideoClient`、`InputClient`、`InputState` 也用于源码核对；
读取文件不等于复制文件。MacRemote 的 `RemoteConnection`、`KeyboardInputSession` 与
`TrackpadSurface` 仅用于输入、IME 和配对设计对照。新增客户端没有外部 Swift 第三方依赖；
现有 App 的既有依赖仍由 App Package 管理。

```yaml
component: native-mac-remote-host
upstream_repository: https://github.com/arniesaha/mirador
upstream_commit: 4cc5c0faddcf4ed87599fbd7cba96e5d9bd4285d
files:
  - source: Sources/Mirador/H264Encoder.swift
    local: packages/remote-desktop-host/Sources/RunweaveRemoteHost/H264Encoder.swift
  - source: Sources/Mirador/ScreenCaptureService.swift
    local: packages/remote-desktop-host/Sources/RunweaveRemoteHost/DesktopCapture.swift
  - source: Sources/Mirador/InputEvent.swift
    local: packages/remote-desktop-host/Sources/RunweaveRemoteHost/DesktopInput.swift
license_file: packages/remote-desktop-host/ThirdPartyLicenses/Mirador-MIT.txt
third_party_dependencies:
  - Local RunweaveRemoteDesktopProtocol; Apple system frameworks only
local_changes:
  - Require hardware H.264 and record selected hardware property; share one in-flight reservation through encode and send completion
  - Fix presentation timestamp timescale; retain format and IDR recovery
  - Adapt ScreenCaptureKit primitives for one explicit display; remove MJPEG and automatic permission requests
  - Reimplement protocol validation, control lease and per-session synthesized input release
verification_evidence:
  - Upstream swift build -c release succeeded; local upstream/mirador-build.log
  - MacRemoteHost Debug build succeeded as a reference; local upstream/MacRemote-build.log
  - Local Host app build log is host-build.log; build is not permission or UI acceptance
  - Runtime verdicts require the three remote-desktop YAML plans and actual run artifacts
```

上述日志属于本次 ignored `.runweave/remote-desktop-implementation/` 证据目录；正式交付
须保留实际命令、系统、签名、产物与 runtime verdict，不能只凭本账本中的构建结果判断可用。
导入范围变化时同一改动更新本账本。GPL/AGPL 候选没有进入本次复制清单；受限 Loupe 与
未定位 Sidecar 没有引入。
