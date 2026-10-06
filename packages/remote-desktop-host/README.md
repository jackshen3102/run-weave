# RemoteDesk

独立原生 macOS 15+ App，为现有 Runweave iPhone App 提供局域网桌面。它不使用 Backend token、终端 WebSocket 或公网 Tunnel。

日常可以直接让 Agent 执行“更新 Mac Host，并用手机验收”。Agent 从当前工作区更新，包含未提交改动；不自动拉取代码、切换分支或更新 iPhone App。若需要指定提交或更新手机 App，在请求中明确说明。

也可以在仓库根目录执行：

```sh
# 日常更新：读取已安装 Host 的签名团队，沿用上次成功启动的网卡。
pnpm host:update
# 首次安装：指定自己的签名团队和实际 LAN 网卡；en0 仅为示例。
pnpm host:update --team YOUR_TEAM_ID --interface en0
# 只查看用法，不构建、不重启。
pnpm host:update --help
```

固定流程是：检查安装与签名身份 → 独立构建并验签 → 保留旧包、正常退出旧进程 → 安装并启动新版 → 核对服务回执 → 手机验收。构建期间旧服务继续运行；替换和重启会断开当前桌面会话，服务就绪后在手机重新打开原配对的 Mac。命令负责更新至监听就绪，手机操作由 Agent 按 `toolkit:agent-device` 执行。

验收使用已保存的 iPhone 和现有配对，确认能打开桌面、看到实际画面并完成一次点击或输入；首次配对或系统授权仍需本机确认。分别报告更新、监听、回退、手机实际会话的结果。手机锁屏、离线或自动化受阻时，保留更新结果并明确验收未完成，不将监听就绪视为手机验收通过。

更新入口只部署 Release 到固定 `/Applications/RemoteDesk.app`，所有 checkout 共用同一个安装位置和更新锁。先在独立 DerivedData 构建、校验 Bundle ID 和签名团队、准备候选包，再正常退出旧进程并替换安装包。构建或验签失败不会修改当前安装；旧进程退出失败不强杀。首次可迁移当前 checkout 原构建路径或 `/Applications/Runweave Remote Host.app` 中运行的同团队 Host；其他路径或多个运行实例会在部署前被拒绝。Debug 仍使用 `build-host.sh`，不覆盖正式安装。

成功时 stdout 返回 `state=ready`、`update=succeeded` 的 JSON，包含新进程 PID、Host ID、应用路径、接口、权限、源码 checkout/commit/dirty 状态和候选签名 code hash。回执核对本次请求、PID 与路径。日志、回执在 `~/.runweave/remote-host/updates/`；旧包和失败候选包保留于回执所指的 `/Applications/.RemoteDesk-update-*` 目录，不自动清理。

替换或新版启动失败时自动恢复旧安装；更新前有运行实例则重新启动旧版并验证监听。此时仍返回非零退出码和 `update=failed`，另用 `rollback=service_restored`、`app_restored`、`installation_removed` 或 `failed` 区分恢复结果；回退失败保留路径和原因供排查。回退使用上次成功监听的接口，不沿用本次失败的接口参数。该回退恢复 App，不回滚 Keychain 或数据结构；后续若修改持久化格式，必须单独处理旧版兼容性。

更新锁位于 `~/.runweave/remote-host/update.lock`。异常中断后先检查其中 `owner.json` 的 PID、回执和安装/备份状态，确认没有更新进程后再恢复现场并移除遗留锁；工具不会自行抢占锁或强杀进程。正常更新由 Agent 完成，失败先按回执排查。

仅构建时使用以下入口：

```sh
# Xcode 26.6 / xcodegen；默认 ad-hoc 本地签名。
packages/remote-desktop-host/build-host.sh
# 使用已有 Apple Development team 进行最终签名：
packages/remote-desktop-host/build-host.sh --team YOUR_TEAM_ID
open ".runweave/remote-desktop-implementation/HostDerivedData/Build/Products/Release/RemoteDesk.app"
```

在固定 `.app` 路径和签名身份下授权并验收，改变签名/路径可能需要重新授权。脚本只构建，不启动服务、不申请权限、不安装启动项。首次点击“启动局域网服务”会创建本机 TLS 身份：系统 `/usr/bin/openssl` 生成 RSA 2048/SHA-256 自签证书，PKCS#12 与随机密码保存在独立 Keychain 中，临时文件随后清理。证书有效期十年，客户端仍检查当前有效期；过期或身份丢失需要本机处理并重新配对。此版本不自动轮换身份。

用户要求“更新 Host”时，交付范围包括构建、部署、启动新版进程和局域网服务，以及验证实际连接。除非明确要求只构建或保持停止，使用上述更新入口完成启动，不再询问是否启动。`state=ready` 只证明新版监听已就绪，`remoteSessionVerified=false` 明确表示还未验证手机实际会话；不能用进程或端口代替真机验收。已有系统权限、Host 身份和设备配对沿用原配置；需要新增系统权限或设备授权时仍按下文处理。

App 接受本机启动参数 `--start-service [--interface INTERFACE]`，异步等待接口发现并调用与 UI 相同的服务生命周期；15 秒内未就绪则停止本次监听并报告失败。接口选择保存于本机，LAN 和模拟器验证使用不同的配置键。`--startup-result PATH --startup-request-id UUID` 用于写入一次性 JSON 启动回执，供更新入口核对。没有 `--start-service` 时仍保持停止；参数只在新进程启动时处理，不通过远程网络提供管理接口。手动停止后不会因窗口再次出现而重启。再次启动已有 App 应使用更新入口或 `tools/start-host.swift` 编译出的本机启动工具，后者参数为 `<RemoteDesk.app> <证据目录> [接口]`，会正常退出旧进程再启动。

同 Mac 的 iOS Simulator 访问本机 LAN 地址会走 `lo0`，不能用来验收 Release 的物理接口策略。仅 Debug 编译接受显式 `--simulator-loopback` 验证入口；无参数 Debug 和所有 Release 构建仍使用原 LAN 策略。构建独立产物并由本机用户启动：

```sh
xcodegen generate --spec packages/remote-desktop-host/project.yml
xcodebuild -project packages/remote-desktop-host/RunweaveRemoteHost.xcodeproj \
  -scheme RunweaveRemoteHost -configuration Debug \
  -derivedDataPath .runweave/remote-desktop-implementation/HostSimulatorDerivedData \
  DEVELOPMENT_TEAM=YOUR_TEAM_ID build
open ".runweave/remote-desktop-implementation/HostSimulatorDerivedData/Build/Products/Debug/RemoteDesk.app" --args --simulator-loopback
```

UI 显示橙色模拟器验证标识。点击“启动回环验证服务”后只绑定 `lo0` / `127.0.0.1:48572`，拒绝 Wi-Fi、Ethernet、cellular 和其他接口。模拟器需使用该地址、端口及该窗口的完整 TLS 指纹重新配对；身份和设备授权分别保存在 `com.runweave.remote-host.simulator.identity` 与 `com.runweave.remote-host.simulator.paired-devices`，不读取或更改 Release 配对。TLS/pin/证书有效期/信任锚、H.264、输入租约、Mac 本机确认和停止/撤销均使用同一实现。该入口的闭环证据不能替代真机 LAN 验收；Release 中参数无法启用此模式。

1. 选择实际 Wi-Fi / Ethernet 接口并启动服务。Host 仅绑定该接口的 IPv4 地址与端口 `48571`，以稳定 Host ID 发布 Bonjour 服务；没有公网映射、中继或 Tunnel。启动服务不会采集屏幕。所选接口的地址变化时释放旧会话与输入、关闭配对邀请，并用原身份重新监听；接口断开时等待其恢复，不自动切换网卡。等待期间仍可点击“停止全部共享”取消恢复。
2. 在本机 UI 分别处理屏幕录制与辅助功能权限。拒绝屏幕权限不能观看；拒绝辅助功能只能观看。任何授权按钮都须本机用户主动点击。
3. 本机点击“连接 iPhone”，在 iPhone 的“Mac 桌面”点击“扫码配对 Mac”，扫描此窗口的二维码。手机自动读取地址、端口、Host 身份和证书 pin，不需手填。手机需能访问此 Mac；相机不可用时展开“手动配对信息”，在手机使用手动填写并核对完整指纹。地址不是身份；身份 pin 不匹配或证书失效必须拒绝连接。
4. 二维码在当前 120 秒窗口内有效，刷新、取消、断连、停止或到期后失效；六位码最多三次尝试。Host 还要本地确认设备名，默认只读，并单独决定是否允许键盘/鼠标控制。未经确认不会分发令牌、屏幕或输入能力。手机保存成功后可选关联终端连接，点击“打开桌面”才开始观看。二维码不能用于 Backend 登录，不含长期令牌。
5. 返回设备列表可以撤销授权。Host 的“结束此会话”或“停止全部共享”释放所有合成按键/鼠标，发送终止消息并等待最多 300ms 的确认后关闭连接和采集；手机收到终止消息不会自动重连。手机“忘记本机配对”只删除手机保存的凭据；Host 撤销才删除 Host 授权。

首版只共享一块当前主显示器：H.264 High、硬件编码强制、≤1920×1080、30 FPS、8 Mbps，保持源宽高比，无编码黑边；`contentRect` 为整个编码画面。视频独立 TLS 连接，输入不进入大视频队列。ScreenCaptureKit queueDepth 为 3、编码至发送完成共用一个 in-flight 名额、最多一个媒体发送；繁忙时跳过未编码的采集画面，不破坏 H.264 依赖链，单次媒体发送两秒超时。发生视频丢帧后丢弃依赖帧，请求并等待含 SPS/PPS 的 IDR。本机启动服务时锁定显示器 ID；该显示器仍存在且几何改变时，失效旧会话并释放输入，当前可见桌面用新会话、更高 revision、新格式与 IDR恢复，首帧前不可控制。恢复清理期间按钮改为“取消恢复并停止共享”，明确停止整个监听服务；普通活动会话仍使用“结束此会话”。显示器移除会明确终止；更换屏幕必须在 Mac 本机停止服务、核对屏幕并重新启动，不暗换显示器。

本机统计保留最多 256 次编码提交到回调耗时样本，显示 p50/p95 与实际编码至发送完成/发送队列最大值；这些不是端到端输入到像素延迟。

控制为单会话，心跳每秒一次、租约三秒；断线/超时/撤销/离页释放已跟踪的合成输入，不补发旧输入。输入限定显示 revision、有限归一化坐标、按钮、键码、文本 4096 UTF-8 字节和每秒 240 个事件。辅助功能权限变化主动通知手机并降为只读，不保留虚假的可控状态。观察与控制权限分别检查，Keychain 设备 token 为随机 32 字节，只在 TLS 内认证消息传输。

不提供音频、剪贴板、文件、shell、后台自动控制、虚拟显示器或自动唤醒；锁屏/系统保护弹窗要在本机处理。进程在用户登录的图形会话中工作。

来源：主采集/编码参考 [Mirador](https://github.com/arniesaha/mirador/tree/4cc5c0faddcf4ed87599fbd7cba96e5d9bd4285d)，MIT 版权与原文在 `ThirdPartyLicenses/Mirador-MIT.txt`；H264Encoder 保留上游主体，采集与输入原语已针对权限、租约、输入校验和资源边界改造。[MacRemote](https://github.com/waiyan0x/MacRemote/tree/274901a7d25aead9d58d557ba859b71d031ffe84) 仅研究配对/输入边界，未导入源码。没有第三方运行依赖，未导入 GPL/受限代码。完整来源与实际验收记录由仓库远控架构文档维护。

本地初步证据：Mirador 原版 `swift build -c release` 与 MacRemote 原版 unsigned Host Xcode build 已成功；本 Host App 与共享协议已编译成功。日志在 ignored `.runweave/remote-desktop-implementation/`。构建成功不能代表权限、UI、实际输入或真实设备验收。
