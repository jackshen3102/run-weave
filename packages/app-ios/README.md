# Runweave iOS

Runweave 的原生 iOS 应用，使用 SwiftUI/UIKit 和 SwiftTerm，通过 HTTP/WebSocket 连接 Runweave Backend。
应用包含连接管理、登录、项目与终端、命令输入、图片与文件上传、语音转写、Files/Changes 预览与单文件删除、Reset及诊断；终端链接可在单页内置浏览器阅读、收起与恢复。

内置浏览器使用相邻的 [RunweaveBrowser Swift Package](../browser-ios/README.md)，与随记共享实现；终端来源和呈现条件仍由本 App 管理。
Bundle ID 为 `com.runweave.app.native`，保留已有安装的连接、主题和安全凭据。

应用在前台活跃期间默认保持屏幕常亮；可在“连接管理 → 屏幕”关闭，选择会保存在本机。
该设置覆盖正式页面与诊断实验室，离开应用后恢复系统息屏规则；不阻止手动锁屏，也不替代 UI Automation 授权。

## Clarity 自动采集

原生 App 包含 Microsoft Clarity iOS SDK `4.1.0`。仅 Release 真机构建默认初始化，生产项目是
[Runweave iOS](https://clarity.microsoft.com/projects/view/yofefg4fsy/settings)（`yofefg4fsy`）。
项目设置为 Strict masking，WebView DOM capture 关闭。代码另对登录和配置输入、任务提示词、终端、命令输入、文件预览及内置浏览器遮盖。
SDK 在主线程启动时初始化一次，不上报自定义用户 ID 或 Runweave 连接标识；没有用户操作开关。
远控发送固定自定义事件 `remote_paired`、`remote_opened`、`remote_visible`、`remote_input_sent`、
`remote_closed`，没有事件参数；详细口径见[远控使用记录](../../docs/architecture/remote-desktop.md#使用记录与分析口径)。
关键页面使用官方 `setCurrentScreenName` 命名：`home`、`login`、`connections`、`terminal_chat`、`terminal_files`、`terminal_changes`、`composer`、`quick_replies`、`quick_reply_editor`、`scheduled_tasks`、`scheduled_task_editor` 等。名称只来自固定分类，不包含项目名、终端 ID、命令或文件路径。
共用页面标记按可见视图层级选择名称，弹层关闭时恢复底层分类；输入面板的 UIKit host 显式传递层级。SDK 会话开始时重新应用当前分类，未初始化时不调用 SDK 命名接口。系统键盘、系统确认框及未标记的次级内容保留所属业务页面分类；分类不是任务成功率，也不把集中处理或长时间停留视为异常。

Debug、Profile 默认 `RUNWEAVE_CLARITY_ENABLED=NO`，项目 ID 为空。需要采集测试会话时，显式同时传入 `RUNWEAVE_CLARITY_ENABLED=YES` 与 `RUNWEAVE_CLARITY_PROJECT_ID=<独立移动测试项目 ID>`；不复用生产项目。模拟器即使构建 Release，也拒绝初始化生产项目 `yofefg4fsy`。
Release 真机仍可传入 `RUNWEAVE_CLARITY_ENABLED=NO` 关闭初始化，或用项目 ID 覆盖测试目标。
这些是 Xcode 构建设置，改动后必须重新构建并安装；旧 App 不会自动停采。项目 ID 是公开标识。
发布前核对 App Store 隐私申报和用户披露，并用合成标记逐项检查终端、文件、图片、内置浏览器与任务提示词的云端回放遮盖。已有模拟器登录页回放确认账号和密码遮盖；真机回放及上述敏感界面仍未完成验收。
构建、安装、启动、页面交互与云端数据分别留证，不能互相代替。

## 构建与安装

### 一条命令更新到 iPhone

在仓库根运行 `pnpm ios:update --devices` 获取硬件 UDID。首次明确指定手机和签名团队，
成功后保存本机默认目标：

```bash
pnpm ios:update --device <硬件UDID> --team <TEAM_ID> --save-target
```

以后运行 `pnpm ios:update` 即完成检查、按需构建、签名检查、安装、安装版本核对和启动。
不需要 Agent 或 XCTest runner。支持 USB 和已配对可达的无线连接；首次配对/信任、Developer
Mode、Xcode 签名登录和 Swift package 插件审批仍需按正常系统流程准备。锁屏时命令提示并
最多等待 120 秒，解锁后自动继续；超时非零退出，重新执行可复用已验证的产物。
保持 Bundle ID、Keychain 和应用数据，不卸载旧 App。

默认 Release，沿用生产 Clarity 和 APNs production；可传入 `--configuration Debug` 或
`Profile`（默认关闭分析、APNs sandbox）。签名必须支持现有 entitlement，不自动删减推送能力。
`--dry-run` 只读预览，不消耗构建号、不保存目标、不安装；`--json` 将最终结果输出为 JSON，
进度输出到 stderr。另一个显式目标不自动覆盖已保存手机，须添加 `--save-target` 才保存。
脚本消费 stdout 时使用 `pnpm --silent ios:update --json` 或独立 Node 入口，避免 pnpm 的命令提示混入 JSON。

每个新产物自动递增产品版本的补丁位，例如 `0.1.0 → 0.1.1 → 0.1.2`，界面直接显示产品版本。
独立构建号仍自动递增并记录在诊断、分析标签和构建信息导出中；同一可信产物重复安装保持版本和构建号不变。
版本分配参考工程默认、本机历史和目标手机；发布阶段可使用 `--version 0.2.0` 指定尚未使用的新产品版本。
不自动修改或提交工程配置。本机号源跨 worktree 共享；跨电脑并发的全局排序需另设统一号源。
直接 Xcode 构建仍使用工程默认版本，但包含独立构建身份。

无需 pnpm workspace 安装时，在本包执行 `node scripts/ios.mjs update`（相同参数）。要求
macOS、Node、Python 3 和完整 Xcode。默认目标和号源保存在 `~/.runweave/ios-update/`，
本轮日志及回执在工作区 `.runweave/ios-updates/<runId>/`，成功记录在 `last-success.json`。
运行不会拉代码、切分支或更新 Backend，使用当前磁盘源码，包括未提交改动。

退出码：0 为安装版本和启动进程均核对成功；2 为参数/配置；3 为环境、设备或占用阻塞；
4 为构建/签名；5 为安装/安装身份；6 为启动失败。安装成功但启动失败会分别报告。
成功结果的 `uiVerified` 仍为 false，业务页面和 Clarity 云端回放需独立验收。新 Clarity
会话附带 `app_version`、`app_build`、`build_id`、`source_revision`、`source_state` 标签；
旧会话不会被补写。

### Xcode 与模拟器入口

需要 macOS、Xcode、iOS SDK 和 Metal Toolchain。应用部署版本以 Xcode host 的
`IPHONEOS_DEPLOYMENT_TARGET` 为准；Swift package 的最低平台声明不等于应用已验证的最低系统。
SwiftTerm 基于 1.19.0，以仓库内 [Vendor/SwiftTerm](Vendor/SwiftTerm/README.md) 本地 package
交付最小直接单击补丁；来源 commit、许可、原始输入哈希与完整差异随源码保存，不依赖下载缓存补丁。
首次构建需通过 Xcode 的正常流程审查并启用 SwiftTermBuildInfoPlugin，不跳过插件信任校验。

直接打开 `ios/RunweaveNative.xcodeproj`，选择 `RunweaveNative` scheme 和设备即可构建。
真机在本机 Xcode 中设置签名 Team，团队身份不提交到工程。无需启动 Web 服务或安装 pnpm 依赖。

有 Node 时，也可在本目录执行：

```bash
node scripts/ios.mjs doctor
node scripts/ios.mjs build --simulator <UDID> --configuration Debug
node scripts/ios.mjs run --task-dir <本工作区任务目录> --configuration Debug
```

使用 doctor 列出的已安装 destination。支持 Debug、Profile、Release 三种配置。模拟器安装前先按[共享设备池](../../docs/cli/ios-simulators.md)申请任务；run 会核对当前源码、构建产物和设备上的二进制，按需构建或安装后启动。
Debug/Profile 真机构建启用 APNs sandbox 推送，Release 使用 production；
需要支持 Push Notifications 的 Apple Developer Program 团队和描述文件。
推送密钥、网关和仅安装电量展示版的本地签名覆盖方式见[推送网关](../push-gateway/README.md#ios-签名和启用)。
模拟器使用 ad hoc 签名和专属 Keychain entitlement；产物在本目录
`.build/ios/DerivedData/Build/Products/`。脚本不启动 Backend，也不改变其他应用的配置。
仓库根的 `pnpm ios:doctor`、`pnpm ios:build -- ...`、`pnpm ios:run -- ...` 只是同一脚本的快捷入口。

### 真机操作与取证

日常交互排查、修复后的探索验收使用 [`toolkit:agent-device`](../../plugins/toolkit/skills/agent-device/SKILL.md)，
显式绑定设备并核对业务后置状态。它不替代构建安装，也不作为唯一的无人值守门禁。

固定套件入口使用 Xcode、devicectl 和仓库内固定 `BatchRunner.testBatch`。在本目录执行：

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
元素存在性等待可用 `element.waitUntilExists(timeout:)`：先检查当前状态，未出现再调用
XCTest 等待；它不保证元素可点击，交互前仍需相应检查，业务断言也不能省略。
已知目标使用元素类型与 ID 或文字直接查询，例如 `app.buttons["关闭"].exists`；
不要为单个元素的存在性判断读取并搜索 `app.debugDescription`。完整控件树继续用于
未知页面探索、诊断和既定的前后取证。
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

Mac 桌面使用独立配对：在 Mac 的 Runweave Remote Host 启动服务并点击“连接 iPhone”，
手机进入“Mac 桌面 → 扫码配对 Mac”，扫描自己 Mac 窗口的二维码后等待 Mac 确认。
无需填写地址、端口或指纹；Mac 默认只读，控制许可由本机另行决定。保存成功后可选关联
终端连接，或点击“打开桌面”。相机权限拒绝/不可用时可手动填写；旧 Host 同样使用手动入口。
扫码不改变 Backend 登录，二维码不能混用。邀请到期或中断后重新扫码，已保存配对无需重复扫描。
合同与验收见 [Mac 局域网远控](../../docs/architecture/remote-desktop.md)。

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
图片、文件和语音转写只追加到草稿，用户显式发送后才进入终端。Files/Changes 支持预览及确认后的单文件删除、Reset；文件正文仍只读。

## 终端网页

OSC 8 真实链接与普通完整 HTTP(S) URL（含终端自然软折行）均可直接单击内置打开，不要求先长按或聚焦。
长按并调整原生选区是兜底；菜单提供内置打开和“链接”，后者显示完整真实目标并可复制。
内置页采用紧凑的单行标题栏和底部图标栏；右上角“…”展示域名与链接操作，底部提供后退、前进、刷新。
TUI 排版成多行的链接使用 OSC 8 提供的完整目标；普通文本不推测拼接硬换行。已激活选区时保留选择操作。浏览器全屏覆盖终端，“回终端”保留网页并由 toolbar 的网页按钮恢复；
“关闭网页”或替换不同 URL 需确认未提交内容风险。离开来源终端释放网页，不跨终端或进程恢复表单。

网站登录独立于电脑连接和 Safari；“清除网页数据”影响本机全部内置网站，不清电脑凭据或终端草稿。
电脑 localhost 服务不支持，不做转发。TLS 错误不可忽略，下载和不兼容的网站登录可由用户选择默认浏览器继续。
HTTP(S) 链接默认内置打开，新窗口链接复用当前页，自动弹窗由 WebKit 限制。
HTTPS 网页可请求打开飞书/Lark 客户端，由原生弹窗确认后交给系统；授权后返回 Runweave，原网页保留并继续处理登录结果，不自动刷新。
未安装或无法打开客户端时显示提示，可继续使用默认浏览器；其他外部协议（包括 mailto/tel）仍不自动唤起 App。
成功唤起客户端不代表企业设备授权通过；客户端拒绝设备授权时，可从“更多”在默认浏览器继续。Runweave 不在默认浏览器与内置网页之间复制 Cookie 或授权凭据，是否放行由网站决定。
内嵌页面允许 `about:blank`、`about:srcdoc`；被拦截的子页面不显示整页提示，主页面提示可手动关闭。
需要外部浏览器时，从网页右上角“更多”主动打开当前网页。关闭/替换会等待旧文档安全卸载；卸载失败时不清网站数据，并提示重启后重试。
当前实现的边界见 [架构](docs/architecture.md#终端内置网页)，构建与尚未关闭的原生运行门槛见
[验收状态](docs/validation-status.md)。

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

模拟器安装前先按[共享设备池](../../docs/cli/ios-simulators.md)以本 App 身份申请设备，两个槽位均可使用；整个验证任务共用 task-dir，结束执行 finish。

## 源码构建身份

共享 scheme 构建时生成安装包内的 `BuildIdentity.json`，记录提交、源码指纹及构建配置。
连接页或连接设置中的“构建信息”可按需离线导出该文件。
本功能不采集运行日志；回查构建和安装记录见 [构建身份](../ios-build-identity/README.md)。
