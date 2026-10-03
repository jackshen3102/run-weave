# Runweave Remote Host

独立原生 macOS 15+ App，为现有 Runweave iPhone App 提供局域网桌面。它不使用 Backend token、终端 WebSocket 或公网 Tunnel。

```sh
# Xcode 26.6 / xcodegen；默认 ad-hoc 本地签名。
packages/remote-desktop-host/build-host.sh
# 使用已有 Apple Development team 进行最终签名：
packages/remote-desktop-host/build-host.sh --team YOUR_TEAM_ID
open ".runweave/remote-desktop-implementation/HostDerivedData/Build/Products/Release/Runweave Remote Host.app"
```

在固定 `.app` 路径和签名身份下授权并验收，改变签名/路径可能需要重新授权。脚本只构建，不启动服务、不申请权限、不安装启动项。首次点击“启动局域网服务”会创建本机 TLS 身份：系统 `/usr/bin/openssl` 生成 RSA 2048/SHA-256 自签证书，PKCS#12 与随机密码保存在独立 Keychain 中，临时文件随后清理。证书有效期十年，客户端仍检查当前有效期；过期或身份丢失需要本机处理并重新配对。此版本不自动轮换身份。

同 Mac 的 iOS Simulator 访问本机 LAN 地址会走 `lo0`，不能用来验收 Release 的物理接口策略。仅 Debug 编译接受显式 `--simulator-loopback` 验证入口；无参数 Debug 和所有 Release 构建仍使用原 LAN 策略。构建独立产物并由本机用户启动：

```sh
xcodegen generate --spec packages/remote-desktop-host/project.yml
xcodebuild -project packages/remote-desktop-host/RunweaveRemoteHost.xcodeproj \
  -scheme RunweaveRemoteHost -configuration Debug \
  -derivedDataPath .runweave/remote-desktop-implementation/HostSimulatorDerivedData \
  DEVELOPMENT_TEAM=YOUR_TEAM_ID build
open ".runweave/remote-desktop-implementation/HostSimulatorDerivedData/Build/Products/Debug/Runweave Remote Host.app" --args --simulator-loopback
```

UI 显示橙色模拟器验证标识。点击“启动回环验证服务”后只绑定 `lo0` / `127.0.0.1:48572`，拒绝 Wi-Fi、Ethernet、cellular 和其他接口。模拟器需使用该地址、端口及该窗口的完整 TLS 指纹重新配对；身份和设备授权分别保存在 `com.runweave.remote-host.simulator.identity` 与 `com.runweave.remote-host.simulator.paired-devices`，不读取或更改 Release 配对。TLS/pin/证书有效期/信任锚、H.264、输入租约、Mac 本机确认和停止/撤销均使用同一实现。该入口的闭环证据不能替代真机 LAN 验收；Release 中参数无法启用此模式。

1. 选择实际 Wi-Fi / Ethernet 接口并启动服务。Host 仅绑定该接口的 IPv4 地址与端口 `48571`；没有 Bonjour、公网映射、中继或 Tunnel。启动服务不会采集屏幕。
2. 在本机 UI 分别处理屏幕录制与辅助功能权限。拒绝屏幕权限不能观看；拒绝辅助功能只能观看。任何授权按钮都须本机用户主动点击。
3. 本机点击“连接 iPhone”，在 iPhone 的“Mac 桌面”点击“扫码配对 Mac”，扫描此窗口的二维码。手机自动读取地址、端口、Host 身份和证书 pin，不需手填。手机需能访问此 Mac；相机不可用时展开“手动配对信息”，在手机使用手动填写并核对完整指纹。地址不是身份；身份 pin 不匹配或证书失效必须拒绝连接。
4. 二维码在当前 120 秒窗口内有效，刷新、取消、断连、停止或到期后失效；六位码最多三次尝试。Host 还要本地确认设备名，默认只读，并单独决定是否允许键盘/鼠标控制。未经确认不会分发令牌、屏幕或输入能力。手机保存成功后可选关联终端连接，点击“打开桌面”才开始观看。二维码不能用于 Backend 登录，不含长期令牌。
5. 返回设备列表可以撤销授权。Host 的“结束此会话”或“停止全部共享”释放所有合成按键/鼠标，发送终止消息并等待最多 300ms 的确认后关闭连接和采集；手机收到终止消息不会自动重连。手机“忘记本机配对”只删除手机保存的凭据；Host 撤销才删除 Host 授权。

首版只共享一块当前主显示器：H.264 High、硬件编码强制、≤1920×1080、30 FPS、8 Mbps，保持源宽高比，无编码黑边；`contentRect` 为整个编码画面。视频独立 TLS 连接，输入不进入大视频队列。ScreenCaptureKit queueDepth 为 3、编码 in-flight 最多 2、最多一个媒体发送，单次媒体发送两秒超时。发生视频丢帧后丢弃依赖帧，请求并等待含 SPS/PPS 的 IDR。本机启动服务时锁定显示器 ID；该显示器仍存在且几何改变时，失效旧会话并释放输入，当前可见桌面用新会话、更高 revision、新格式与 IDR恢复，首帧前不可控制。恢复清理期间按钮改为“取消恢复并停止共享”，明确停止整个监听服务；普通活动会话仍使用“结束此会话”。显示器移除会明确终止；更换屏幕必须在 Mac 本机停止服务、核对屏幕并重新启动，不暗换显示器。

本机统计保留最多 256 次编码提交到回调耗时样本，显示 p50/p95 与实际编码/发送队列最大值；这些不是端到端输入到像素延迟。

控制为单会话，心跳每秒一次、租约三秒；断线/超时/撤销/离页释放已跟踪的合成输入，不补发旧输入。输入限定显示 revision、有限归一化坐标、按钮、键码、文本 4096 UTF-8 字节和每秒 240 个事件。辅助功能权限变化主动通知手机并降为只读，不保留虚假的可控状态。观察与控制权限分别检查，Keychain 设备 token 为随机 32 字节，只在 TLS 内认证消息传输。

不提供音频、剪贴板、文件、shell、后台自动控制、虚拟显示器或自动唤醒；锁屏/系统保护弹窗要在本机处理。进程在用户登录的图形会话中工作。

来源：主采集/编码参考 [Mirador](https://github.com/arniesaha/mirador/tree/4cc5c0faddcf4ed87599fbd7cba96e5d9bd4285d)，MIT 版权与原文在 `ThirdPartyLicenses/Mirador-MIT.txt`；H264Encoder 保留上游主体，采集与输入原语已针对权限、租约、输入校验和资源边界改造。[MacRemote](https://github.com/waiyan0x/MacRemote/tree/274901a7d25aead9d58d557ba859b71d031ffe84) 仅研究配对/输入边界，未导入源码。没有第三方运行依赖，未导入 GPL/受限代码。完整来源与实际验收记录由仓库远控架构文档维护。

本地初步证据：Mirador 原版 `swift build -c release` 与 MacRemote 原版 unsigned Host Xcode build 已成功；本 Host App 与共享协议已编译成功。日志在 ignored `.runweave/remote-desktop-implementation/`。构建成功不能代表权限、UI、实际输入或真实设备验收。
