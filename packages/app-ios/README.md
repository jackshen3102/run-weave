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
Debug/Profile 真机构建不启用 APNs 推送，可使用 Personal Team 签名；Release 保留推送权限，
需要支持 Push Notifications 的开发者团队和描述文件。
模拟器使用 ad hoc 签名和专属 Keychain entitlement；产物在本目录
`.build/ios/DerivedData/Build/Products/`。脚本不启动 Backend，也不改变其他应用的配置。
仓库根的 `pnpm ios:doctor`、`pnpm ios:build -- ...`、`pnpm ios:run -- ...` 只是同一脚本的快捷入口。

### 真机操作与取证

正式入口使用 Xcode、devicectl 和仓库内固定 `BatchRunner.testBatch`。在本目录执行：

```bash
node scripts/ios.mjs device doctor --device <硬件UDID> --json
node scripts/ios.mjs device run --device <硬件UDID> --suite scripts/device/suites/read-only --configuration Debug --json
node scripts/ios.mjs device status --run <runId> --json
```

设备必须显式指定硬件 UDID，不接受设备名称或 CoreDevice 别名，不自动选择第一台设备。
`xcrun devicectl list devices --json-output <本机文件>` 可用于选择设备。真机执行支持 Debug/Profile；
Team 从现有工程签名配置解析，有歧义时传 `--team <本机Team>`。不提交个人设备、证书或本机配置。
免费签名设备若已满安装槽位，可在确认旧测试 runner 空闲后，通过
`--runner-bundle-id <旧runner的基础BundleID>` 复用其槽位（不含 `.xctrunner` 后缀）。
该参数只覆盖测试 runner 的构建身份，会安装本轮新 runner，不能借此复用旧测试逻辑。

`doctor` 只查询工具、当前连接、配对、开发服务、锁屏、App 元数据和占用；每项查询超时 10 秒，
独立查询并行，总预算不超过 30 秒。它不安装、不启动 App 或 XCTest。
`preflight_ok` 不证明 UI Automation 已授权：该项保持 `unknown`，只有同一轮 XCTest 激活固定目标
并读取新的控件树后才进入 `automation_ready`。明确识别到系统授权错误时，保留原进程等待最多
120 秒；普通启动失败不会被猜成密码问题。授权或锁屏由用户在手机上处理，不改变密码和权限。

套件目录必须提供 `suite.json` 和 `Suite.swift`，可从
[`scripts/device/suites/read-only`](scripts/device/suites/read-only/suite.json) 复制。
manifest 固定 `schemaVersion: 1` 和 Bundle ID，`cases` 是 1–20 个唯一 ID 的显式顺序；
`timeoutSeconds` 可设 30–1800 秒，默认 180。Swift 的 `DeviceSuite.cases()` 返回对应 `DeviceCase`，
每例分别声明 `precondition`、`execute`、`postcondition`，使用 `context.require` 立即抛出失败。
每例自行建立导航和物料条件，不依赖上一例结果、不缓存控件引用。需要冷启动时声明
`restartReason`；非空 `launchArguments` 要求每例均声明重启。套件是用户明确选择的可执行
Swift 源码，运行前应审查业务动作；工具不解析任意点击指令，也不按日志名称选择旧代码。
内置三例仅检查正式首页、连接管理和返回首页，不登录、不提交外部动作。

App 与 runner 分开计算输入摘要并检查签名及产物内容；套件变化只使 runner 身份改变。
无法完整描述的生成插件、构建脚本、外部依赖或符号链接回退到 Xcode 增量构建，并记录理由。
当前 SwiftTerm 插件会生成构建触发文件，所以 App 层仍请求增量构建，不能声称零构建。
不跳过插件信任验证。跨批不能仅凭 Bundle ID 或展示版本证明安装身份，因此每批保守安装一次，
不卸载 App 或清除数据。安装完成后和执行结束时核对当前安装位置；身份改变时结果为 unknown。
结束阶段的只读观察在 30 秒预算内最多尝试 3 次，仅对超时重查，仍无法确认时保留 unknown。

每批只请求一次 `test-without-building`，主动检查也在其中；首个失败停止后续例子，
保留 pass/fail/blocked，执行中断的例子标 unknown，不自动重放。正常例子 activate App，
只有声明冷启动才主动 restart。状态文件不能恢复已经退出的 XCTest 进程。

证据位于 `.build/ios/device/runs/<runId>/`：`run.json` 保存身份、结果、计数和各命令计时，
`events.jsonl` 保存阶段和用例事件，`commands.jsonl` 保存命令时序，`result.xcresult` 与
`attachments/` 保存断言、控件树和截图。Xcode 内部 runner 部署次数不可观测时为 unknown。
业务结果与附件导出状态分开；导出失败保留 xcresult，可只重新导出：

```bash
xcrun xcresulttool export attachments --path <run目录>/result.xcresult --output-path <新附件目录>
```

退出码：0 为 doctor 无硬阻塞或整批通过；2 为参数错误；3 为环境阻塞/占用；4 为用例失败；
5 为执行器、未知结果或证据故障。doctor 返回 0 仍不代表能操作 UI。

同一用户的多工作树共享 `~/.runweave/native-device/locks/<UDID>/owner.json` 原子排他锁，
记录父进程与每个子进程的 PID、启动身份和进程组。正常结束且全部子进程组退出才释放；
父进程异常退出或子进程身份不明时保留锁并返回 device_busy，不自动抢占。
人工处理遗留锁前必须逐一确认 owner 中父子进程和进程组都已退出，再仅移走该 UDID 的锁目录；
禁止全局清理 Xcode 进程。此锁不覆盖手动 Xcode 和旧脚本，遇到外部 runner 应协调设备窗口。

历史 `.runweave/native-device-runner/` 脚本保留但新入口不调用它们。
旧 `run.py` 只执行当时的 `UIProbe.swift`，名称参数不会选择历史用例；迁移时整理成显式套件，
不能原样运行未知的历史探针。配套验收合同见
[真机预检与复用](../../docs/testing/app/ios-device-preflight-reuse.testplan.yaml)。

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
