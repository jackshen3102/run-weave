# 随记 iOS

独立 SwiftUI App，最低 iOS 18.6，Bundle ID `com.runweave.suiji`。
宿主装配 `SuijiRootView(endpoint:)`；没有终端、SwiftTerm、SwiftUIX 或 Runweave 节点身份依赖。

## 构建和启动

```bash
pnpm --filter @runweave/suiji-ios ios:doctor
pnpm --filter @runweave/suiji-ios ios:build --simulator <UDID> --configuration Debug
pnpm --filter @runweave/suiji-ios ios:build --simulator <UDID> --configuration Release
pnpm --filter @runweave/suiji-ios ios:run --simulator <UDID> --configuration Debug
```

产物位于根 `.runweave/suiji/ios-build/`。必须指定 Simulator UDID；run 安装指定配置的已有产物。
真机由 Xcode 显式配置签名团队，本工程不提供个人团队默认值。Release 只接受 HTTPS；
Debug 可配置本地服务，网络声明仅允许本地网络，没有全局 ATS 明文例外。

App 内提供“正式 / 开发”两套连接；首次分别输入云地址、用户名和密码，之后在连接设置
一键切换并自动恢复登录，重启会恢复上次使用的环境。升级前的连接、登录和草稿保留在“正式”下。
“更换服务地址”保留已有登录；“退出正式账户 / 退出开发账户”只清除当前环境、当前地址的登录。
测试服务默认 `http://127.0.0.1:4783`，
该地址仅适用于同一 Mac 的 Simulator；真机可通过同一局域网内 Mac 的 IP 和服务端口连接。
本地服务需监听局域网接口（例如 `SUIJI_HOST=0.0.0.0`），不能只监听 `127.0.0.1`。
配置保存两套端点、账号名及上次使用的环境，不保存密码；token 按环境与端点隔离，
保存在独立 Keychain service `com.runweave.suiji.credentials`。正式环境沿用原凭据键，开发环境独立存储。
切换取消旧连接及页面任务，不撤销另一环境的登录，也不自动重试业务写入。

## 行为与代码入口

- [根视图](./Sources/SuijiIOS/App/SuijiRootView.swift)：记录、待办、真实 AI 回顾、搜索和连接入口。
- [会话](./Sources/SuijiIOS/State/SuijiSession.swift)：身份代次、分页、状态操作与编辑器生命周期。
- [连接配置](./Sources/SuijiIOS/State/ConnectionProfiles.swift)与[连接界面](./Sources/SuijiIOS/Features/ConnectionViews.swift)：两套环境、升级兼容与登录入口。
- [编辑器](./Sources/SuijiIOS/State/EditorModel.swift)：上传与记录请求先持久化，未知结果冻结、手动确认、冲突比较。
- [草稿存储](./Sources/SuijiIOS/State/DraftStore.swift)：actor 串行磁盘操作、原子元数据、附件本机副本。
- [客户端](./Sources/SuijiIOS/Services/APIClient.swift)：无 Cookie 会话、合并刷新、只读请求最多一次认证恢复重试。
- [AI 回顾](./Sources/SuijiIOS/Features/ReviewView.swift)：手动发问与追问、取消、引用版本提示，用户选择后预填编辑器。
- [HTTP DTO](./Sources/SuijiIOS/Contracts/Contracts.swift)：对应 `@runweave/shared/suiji`。

草稿按环境、规范端点、serverId、ownerId 隔离；正式环境沿用原草稿目录。
即使两套环境填写相同地址和账号，也分别保存登录与草稿。注销保留本机草稿，验证相同身份后才能恢复。
收起保留草稿，明确放弃需要确认。保存结果未知时不能改写或放弃，重启后手动重试原请求。
已经上传的附件复用 ID；完成/不再做为终态，再建待办只预填正文。

图片通过 PhotosPicker 转 JPEG，再按实际上传字节检查限额；Markdown 复制后按纯文本阅读，
不执行 HTML、不抓取远程图片。图片与 Markdown 都可在本机草稿中预览。
Swift Package 的 privacy manifest 声明本 App UserDefaults 使用原因；App Store 提交与真机隐私审核未执行。

## 映射与原生验证

```bash
# 只通过受保护环境注入测试会话，不将 token 写入命令参数。
pnpm --filter @runweave/suiji-ios mapping:check
```

需要 `SUIJI_VERIFY_URL`、`SUIJI_VERIFY_TOKEN` 和含专用记录的真实服务。
脚本下载实际 info/list JSON，用 App 同一份 Swift DTO 编译解码，再对照回编码后的字段与 Unicode 正文；
可选 `SUIJI_VERIFY_REVIEW_ID` 核对同一服务上的已完成真实回答、引用版本和 coverage。
不会创建记录或使用伪造响应。样例正文只落根 `.runweave/suiji/mapping/`。

原生合同：[ios-capture.testplan.yaml](../../docs/testing/suiji/ios-capture.testplan.yaml)。
当前已验证构建与 HTTP DTO；2026-09-07 已用本机开发证书完成 Debug 真机签名，
并在 USB 连接的 iPhone 17 上安装、启动。签名团队仅通过构建参数传入，没有写入工程默认值。
已在真机通过局域网 IP 完成登录、真实列表读取和类型筛选，并导出控件树与截图。
用户指定的既有真机执行器已复制到根 `.runweave/suiji/physical/runner/`，
通过 `python3 .runweave/suiji/physical/runner/run.py <本次唯一名称>` 构建并执行当前 `UIProbe.swift`，
输出 `.xcresult`、日志及导出的附件。当前执行器标识为 `com.runweave.suiji-device-runner.xctrunner`；
同一手机不能同时运行多个原生执行任务。该本地执行器不随 Git 分发；运行前核对设备 UDID，
当前探针的目标 Bundle ID 为 `com.runweave.suiji`。
设备操作前按 Bundle ID 核对目标：随记为 `com.runweave.suiji`，`packages/app-ios` 的
Runweave Native 为 `com.runweave.app.native`，已退役的旧 `app` 为 `com.runweave.app`。
2026-09-07 已通过 SUIJIIOS-001～014、016、017 共 16 条本地真机用例，包含附件、草稿重启、
离线手动重试、记录与状态丢响应的幂等确认、版本冲突、身份隔离、屏幕键盘及最大辅助功能字号。
空白草稿的入口默认类型和长正文输入时的光标可见性问题已修复并重测。
另外已在手机实际发问到已登录的 Codex CLI，核对单条记录范围、引用回看和显式另存笔记。
015 云端独立网络用例按用户要求延期；
当前逐例状态与阻塞见根 `.runweave/suiji/physical/readiness-results.json`。
执行器通过后仍须检查截图中的实际布局、末行与光标，并用独立 HTTP 读取核对保存结果；
仅构建、安装或 XCTest 断言通过不能代替这一步。大字号用例结束后恢复设备原字号。
