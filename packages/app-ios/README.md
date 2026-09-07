# Runweave Native

独立的 Swift iOS 候选客户端，Bundle ID 为 `com.runweave.app.native`。
已进入 P3/P4 业务迁移，提供原生连接、登录、首页、终端输入与项目预览；尚不能替换旧 `app/`。

## 构建与运行

需要 macOS、Xcode、已安装的 iOS simulator 和 Metal Toolchain 编译组件。
SwiftTerm 固定为 1.19.0，依赖锁在 Xcode 工程的
`project.xcworkspace/xcshareddata/swiftpm/Package.resolved`。
首次构建时，在 Xcode 中审查并启用 SwiftTermBuildInfoPlugin；脚本不跳过插件校验。

```bash
pnpm --filter @runweave/app-ios ios:doctor
pnpm --filter @runweave/app-ios mapping:check
pnpm --filter @runweave/app-ios ios:build -- --simulator <UDID> --configuration Debug
pnpm --filter @runweave/app-ios ios:run -- --simulator <UDID>
```

使用 doctor 列出的已安装 destination。脚本只构建和运行候选 iOS App，不启动 Backend。
产物在仓库根 `.runweave/ios-native-build/DerivedData/Build/Products/`。
Debug/Profile 有内部终端验证入口；Profile 使用优化编译，Release 排除该入口源码。
Debug 的认证撤销按钮默认隐藏，仅显式传入启动参数 `--native-auth-validation` 时显示。
该参数只用于专用认证故障用例，连接正式后端的日常验证不启用。
原生库的 `Package.swift` 不包含可安装 App，安装必须使用 Xcode host。
模拟器使用本地 ad hoc 签名和 simulator-only entitlement，支持独立 Keychain；无需个人 Team。
真机签名在本机 Xcode 配置，不提交个人 Development Team。

## 当前实现

已实现连接增删改与健康检测、按连接隔离的 Keychain、登录和刷新、原生项目/终端首页、
搜索与分组、创建项目/终端、删除终端确认、全局事件同步，以及打开 SwiftTerm 终端。
Debug/Profile 保留独立的内部终端验证页；Release 也使用正式的登录和首页入口。
终端页面已有文本 Composer：发送走统一认证，失败保留草稿，仅明确接受后清空。
已接入快捷键、Stop、只读历史复制、系统图片选择与上传、24 kHz WAV 录音转写、
Files 搜索、Markdown/源码/图片/SVG 预览、Changes/Diff、主题和诊断 start/stop/导出。
媒体结果只追加草稿，不自动发送。横屏使用紧凑工具栏，保留终端显示区。
已补 tmux 手势、连接内预览缓存与诊断持久化；完整行为验收仍待完成。
图片迁移范围是旧端已有的 Files/Changes 预览，旧端没有终端输出图片点击打开功能。

2026-09-06 用户手动验证通过后授权继续业务迁移。
[当前验收状态](./docs/validation-status.md) 汇总 41 项用例、未完成子项与真实证据。
[真实后端功能检查](../../docs/review/2026-09-06-ios-native-production-check.md) 保留此前检查记录。
[实现收尾记录](../../docs/review/2026-09-06-ios-native-completion-execution.md) 保留此前实现与环境记录。
[P3/P4 执行记录](../../docs/review/2026-09-06-ios-native-p3-p4-execution.md) 区分新增实现、真实冒烟和待验收项。
[P2 执行记录](../../docs/review/2026-09-06-ios-native-p2-execution.md) 记录本次构建与冒烟证据；
[P0/P1 历史记录](../../docs/review/2026-09-06-ios-native-p0-p1-execution.md) 保留当时结果，
不代表后续代码已经通过全部真机、恢复与性能门禁。

测试时安装候选 App，在连接管理中填写可达的 Backend 地址，使用该 Backend 的用户名/密码登录，
依次验证首页、创建终端、输入与返回。模拟器可访问本机 localhost；真机需填写手机可达地址。
构建脚本不会启动 Backend；已有服务可直接连接，仓库开发环境按 Dev Session 流程启动。

## 对照与验证

- [新旧映射](./docs/migration-map.md)：源码、协议、用例和状态。
- [技术决策与门禁](./docs/decisions.md)：已验证事实及待解决项。
- [终端验收](../../docs/testing/app/ios-native-terminal.testplan.yaml)：真实 tmux 和设备门禁。
- [实施计划](../../docs/plans/2026-09-05-ios-native-app-refactor.md)：后续迁移范围与依赖顺序。

编译成功不等于终端或真机验收通过。源码映射的 planned 状态允许尚未落地；
只有关联用例全部取得真实证据，才可以改为 verified。
