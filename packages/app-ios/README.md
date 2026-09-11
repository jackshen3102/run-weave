# Runweave iOS

Runweave 的原生 iOS 应用，使用 SwiftUI/UIKit 和 SwiftTerm，通过 HTTP/WebSocket 连接 Runweave Backend。
应用包含连接管理、登录、项目与终端、命令输入、图片上传、语音转写、Files/Changes 只读预览及诊断。
Bundle ID 为 `com.runweave.app.native`，保留已有安装的连接、主题和安全凭据。

## 构建与安装

需要 macOS、Xcode、iOS SDK 和 Metal Toolchain。应用部署版本以 Xcode host 的
`IPHONEOS_DEPLOYMENT_TARGET` 为准；Swift package 的最低平台声明不等于应用已验证的最低系统。
SwiftTerm 固定为 1.19.0，依赖锁在
`ios/RunweaveNative.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved`。
首次构建需通过 Xcode 的正常流程审查并启用 SwiftTermBuildInfoPlugin，不跳过插件信任校验。

直接打开 `ios/RunweaveNative.xcodeproj`，选择 `RunweaveNative` scheme 和设备即可构建。
真机在本机 Xcode 中设置签名 Team，团队身份不提交到工程。无需启动 Web 服务或安装 pnpm 依赖。

有 Node 时，也可在本目录执行：

```bash
node scripts/ios.mjs doctor
node scripts/ios.mjs build --simulator <UDID> --configuration Debug
node scripts/ios.mjs run --simulator <UDID> --configuration Debug
```

使用 doctor 列出的已安装 destination。支持 Debug、Profile、Release 三种配置；先构建，再安装对应配置。
模拟器使用 ad hoc 签名和专属 Keychain entitlement；产物在本目录
`.build/ios/DerivedData/Build/Products/`。脚本不启动 Backend，也不改变其他应用的配置。
仓库根的 `pnpm ios:doctor`、`pnpm ios:build -- ...`、`pnpm ios:run -- ...` 只是同一脚本的快捷入口。

### 真机操作与取证

需要操作或验收连接的 iPhone 时，统一使用 Mac 上的 Xcode 工具链和既有 XCUITest 执行器：

1. 先确认当前设备连接、配对、解锁和签名条件，读取当前脚本；设备标识、Team 和产物路径按本机实际状态解析。
2. 用 `xcodebuild` 构建并签名对应配置，再用 `xcrun devicectl device install app` 安装到目标手机；保留既有 Bundle ID 和应用数据。
3. 通过既有 XCUITest 执行器激活应用、读取控件树，并执行点击、输入、滑动等真实 UI 操作；产品流程从正式首页进入。
4. 保存 `.xcresult`，用 `xcrun xcresulttool export attachments` 导出截图、控件树等证据，并分别报告构建、安装和真机行为结果。

当前执行机器的历史脚本在仓库根 `.runweave/native-device-runner/`：`build-app.py` 负责构建安装，
`run.py` 负责执行当前 `UIProbe.swift` 并导出证据。`run.py` 的名称参数是本次证据名称，
不会按名称加载历史 Swift 脚本。复用前检查脚本中的固定设备标识、Team、旧产物目录和当前操作内容，
使用新的证据名称；这些本地文件不随源码分发，缺失时明确报告，不能假定新机器已具备该执行器。

Playwright 只用于配套 Web 页面，不能验证 SwiftUI。终端实验室是被测页面，
其入口是否显示不影响真机操控能力；仅专项验证显式启用实验室参数。历史成功、编译通过或单张截图不代表本次交互验收通过。

## 连接 Backend

在应用的连接管理中添加可达的 HTTP/HTTPS Backend 地址，再使用该 Backend 的账号登录。
也可以在已登录的 Electron“当前连接 → 连接手机”打开二维码，在 iOS 连接管理点击
“扫码连接电脑”，扫描后等待电脑允许登录。仅点击扫码时申请相机权限；拒绝后可返回手动连接。
手机需能直接访问二维码显示的电脑地址，远程代理路径会保留；本功能不提供公网穿透。
旧 Backend 不支持扫码接口时继续使用原来的手动登录。
地址和登录状态在运行时配置，不使用 Vite 环境变量或编译时固定服务器。
为支持用户配置的公网和局域网 HTTP 后端，App 使用 `NSAllowsArbitraryLoads`；不要同时添加
`NSAllowsLocalNetworking`，否则 iOS 会忽略此放行设置。HTTPS 仍由系统校验服务器证书；
公网部署优先使用 HTTPS。策略语义见 [Apple ATS 配置说明](https://developer.apple.com/documentation/bundleresources/information-property-list/nsapptransportsecurity/nsallowsarbitraryloads)。
模拟器可以访问电脑的 localhost；真机应填写手机可达的电脑地址。
Backend 的部署和开发生命周期由仓库部署工具管理，原生应用不负责启动或停止服务器。

连接配置存于 UserDefaults；凭据按连接 ID 与规范化 endpoint 隔离在 Keychain。
切换电脑会释放原连接任务和终端视图；网络错误保留凭据，明确的认证失效才要求重新登录。
扫码会复用相同规范化地址的连接和用户命名，保存完成前保留当前连接。若提示“登录已保存，但未收到
电脑确认回执”，可重试完成确认或进入首页；不要因此删除已保存的登录。授权与回执边界见
[跨端扫码合同](../../docs/architecture/app-mobile.md#手机扫码登录)。
图片和语音转写只追加到草稿，用户显式发送后才进入终端。Files/Changes 是只读审阅入口。

## 诊断与终端实验室

所有配置默认进入正式登录和首页导航。日常日志使用应用内“诊断”菜单。
Debug/Profile 的内部终端实验室仅通过启动参数 `--native-terminal-lab` 打开；
Profile 使用优化编译，Release 不启用实验室。

在 Xcode Run/Profile 启动参数中启用，或安装 Debug/Profile 后执行：

```bash
xcrun simctl launch --terminate-running-process <UDID> com.runweave.app.native --native-terminal-lab
```

实验室可返回首页；再次进入需带参数重新启动，不保存开启状态。
Unicode/ANSI、Metal 故障注入、只读附着和性能采样从此入口取证，产品流程从正式首页验收。
Debug 的认证撤销按钮另需 `--native-auth-validation`，只用于本例独占的认证故障环境。

## 维护入口

- [架构与协议边界](docs/architecture.md)：代码归属、状态生命周期、数据与渲染边界。
- [技术决策](docs/decisions.md)：依赖、签名、重试、预览和诊断约束。
- [验收状态](docs/validation-status.md)：当前计划、已有证据边界与未关闭问题。
- [编码约束](AGENTS.md)：本目录的变更与验证要求。
