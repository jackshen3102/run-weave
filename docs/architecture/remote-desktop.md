# Mac 局域网远控

远控使用现有 Runweave iPhone App，独立连接用户明确配对的 Mac Host。终端、文件和
Commands 继续使用原 Backend；远控视频不经过 Backend、Electron 或现有公网 Tunnel。
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

电脑级管理入口在登录与离线界面均可用；终端快捷入口只在恰有一个明确关联的已配对 Host
时直接打开，否则由用户选择。全屏标题始终显示被控 Mac。返回桌面不改变原终端导航、Tab
或草稿；隐藏的视频会话停止，重新进入建立新的呈现代际。

## 会话、权限与隐私

仅一个当前控制会话。宿主以 Host ID、generation 与 presentation ID 隔离回调；退出、
后台、切电脑或 Backend 会话失效停止旧媒体和输入。后台恢复以新 generation 建会话，
不会补发历史点击。Host 控制租约负责客户端断网或被杀后释放合成输入；本地停止与撤销
是 Host 自己的控制权边界，不依赖手机能完成善后。

首次配对要求用户核对 Mac 本地显示的证书指纹、一次性码，并在 Mac 本地确认手机。
系统 TLS 承担传输保护，不默认接受任意自签证书，不把 token 放 URL。控制与视频使用
分开的连接。手机“忘记本机配对”删除其 credential 引用；彻底撤销设备授权须在 Mac
Host 本地执行，界面明确区分两种操作。部署不配置公网映射、云中继或复用现有 Tunnel。

屏幕录制决定能否观察，辅助功能决定能否输入；没有首帧不能报告可控。首版只使用当前
已存在的一个显示器、H.264、已登录的 Mac 图形会话。音频、虚拟屏、公网、浏览器与
Agent 控制不属于首版；不降低 SIP/AMFI，不承诺 FileVault、Touch ID 或系统安全弹窗
都可远控。

远控与配对全屏在宿主整体 `clarityMask()`，原生视频 layer 另设 `preventsCapture`。
后者不能替代 Clarity 云端回放验收。screen 分类固定为 `remote_desktop`、`remote_hosts`
和 `remote_pairing`，不包含机器名、Host ID、endpoint 或输入正文。日志只保留非敏感
状态、尺寸、时序与计数，不记录帧、文本、配对码或 credential。

独立客户端 Package 仍声明 iOS 15；现有 App target 已声明 iOS 18.6，本次没有提高它。
Host target 声明 macOS 15。构建、安装、启动、原生交互、真实硬件编解码、Wi-Fi 与
Clarity 云端回放分别取证，任何一层成功都不能替代另一层。

## 运行与验收

Host 构建、签名、授权、启动、停止和撤销操作见
[Host README](../../packages/remote-desktop-host/README.md)；客户端包边界见
[iOS 远控包](../../packages/remote-desktop-ios/README.md)。现有手机 App 沿用
[iOS 构建安装入口](../../packages/app-ios/README.md)，模拟器仍申请共享设备池。

验收合同对应交接 A01–A16：

- [会话与宿主生命周期](../testing/remote-desktop/session.testplan.yaml)：A01–A05、A14。
- [输入与媒体](../testing/remote-desktop/input-media.testplan.yaml)：A08–A11、A15。
- [配对、权限、隐私与来源](../testing/remote-desktop/security-source.testplan.yaml)：A06–A07、A12–A13、A16。

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
  - Add three-frame in-flight bound, decoder epoch, format and IDR recovery
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
  - Require hardware H.264 and record selected hardware property; bound encoder in-flight to two
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
