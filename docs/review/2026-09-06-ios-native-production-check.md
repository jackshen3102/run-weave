# 原生 iOS 真实后端功能检查

用户已授权复用本机正式 Backend `http://127.0.0.1:5001` 的真实项目数据，
不再为普通功能检查另起空白 Backend。此次没有修改 Backend 或旧 App 源码。

## 环境与实际操作

- 用户使用 iPhone 17 / iOS 26.5，UDID `B51A836B-2DEE-4E18-9FE6-442B63B9E9C3`。
- 用户完成原生独立登录后，CUA 实际看到 coze-monorepo、coze-feature 项目及已有终端列表。
  之前的空白问题发生在尚未登录阶段，本轮没有证据表明 overview 接口丢失项目。
- 从 coze-monorepo 的加号创建本轮专用终端 `7f2680d1`，进入原生 Chat，看到已连接、
  shell 提示符和 tmux 状态栏。没有向任何既有终端发送输入或信号。
- 切换 Files 后看到真实项目根目录；搜索 `README.md` 得到根目录、`.agents`、
  `apps/space` 等不同目录的结果。这些是原生 CUA 实际操作记录。
- 点击根 README 后 CUA 超时，之后重置并重新获取 Simulator、甚至应用列表仍超时。
  未取得预览正文、关闭、Changes、历史或诊断面板的运行通过证据。
- 同期原生持久日志显示 preview/file HTTP 200、终端继续接收和消费输出；2 秒进程采样
  主线程主要在事件循环等待。支持工具连接故障的推测，但不能替代原生页面可操作证据。

## 对照旧 App 后修复

| 问题                                                                    | 本轮改动                                                                                  | 来源与归属                                                                                                    |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 连接在线却仍显示 Not checked，地址配置与登录状态不清楚                  | 当前连接展示实际健康及登录状态，未登录可直接返回登录页；检测当前连接更新实际 Session 状态 | `ConnectionManager.swift` / MAP-04                                                                            |
| 终端 WS metadata 只被记日志，当前目录和命令没有用于界面                 | 保存 metadata 并更新终端标题、目录；显示连接/退出状态和首页活动时间                       | 旧 `header.tsx`、`use-app-terminal-connection.ts`；`SessionController.swift`、`TerminalScreen.swift` / MAP-09 |
| 终端删除等 Session 错误只出现在被覆盖的首页                             | 在当前终端页展示 Session 错误                                                             | `TerminalScreen.swift` / MAP-01                                                                               |
| Debug 的撤销登录按钮暴露在正式后端的日常终端页                          | 默认隐藏，要求显式启动参数 `--native-auth-validation`；Release 仍不编译该方法             | `ComposerView.swift` / MAP-12                                                                                 |
| 读取 overview 期间任何事件都会丢弃整份结果，真实 Backend 活跃时反复重取 | 仅结构变化失效快照；请求期间的状态/目录事件有界保留并按顺序合并进结果，避免覆盖新状态     | 旧 `use-app-session-events.ts`；`AppSession.swift` / MAP-07、MAP-08                                           |

修复前持久请求记录显示 05:19:59.971Z 至 05:20:03.164Z 连续约每 0.53 秒一次 overview GET，
均返回 200，单次约 470 ms；这不是 401。代码中的全事件 revision 失效会造成此类无效重取，
不能把该请求行为称为列表已经正常验收。
修复后再次安装并启动，05:25:48.950Z 获得事件 ticket，overview 只在 05:25:49.351Z、
05:25:49.814Z 返回两次 200；观察至 05:26:34.239Z 未再重取。已有认证正常复用。
前后请求证据分别为 `overview-before.json` 和 `overview-after.json`，该结果只证明这段真实
运行窗口不再连续重取，不替代完整事件去重、乱序与结构变化的验收。

## 证据与边界

运行日志与采样保存在 `.runweave/ios-native-evidence/production/`。
`directed-results.json` 记录修复前安装包指纹及上述定向操作，`fix-candidate.json` 记录修复候选指纹。
本轮修改后 Debug/Release 构建、Swift 严格格式、21 项源码映射与 docs:check 通过。
最新 Debug 已通过包内安装脚本安装到用户的 iPhone 17 并启动（未卸载 App）；
更新后 CUA 仍无法获取 Simulator，因此安装成功不代表新界面回归通过。
该轮是功能定向检查，不将局部步骤换算为三份 YAML 全例通过，也不升级 MAP 为 verified。
Markdown 表格等完整渲染语义仍需对照旧端检查，当前简化解析器不能据文件存在声明等价。

本轮专用终端 `7f2680d1` 暂留用于后续输入、恢复和删除验证；其它真实资源未删除或修改。
自动化恢复后继续从 Files 预览关闭、Changes/Diff、历史复制、诊断入口及新改动回归推进。

## 用户补充验证与后续范围

用户随后确认自行打开预览没有问题、已手工验证，并明确允许跳过这项继续其它功能。
因此正常预览记为用户手工通过，不再以该页面阻塞后续；这不等于预览错误分支或完整
IOSFEATURE-008 均已通过。后续只执行不依赖真机的用例。

IOSFEATURE-005（系统图片选择上传）与 IOSFEATURE-010（图片缩放与关闭）没有必须使用
物理设备的业务不变量，前提已允许模拟器并保留全部行为要求。故模拟器可覆盖的现有用例
从 33 条调整为 35 条；其中 iOS 15 运行验收仍缺环境，本机仅安装 iOS 18.2/18.4/18.6/26.2/26.5。
这些状态调整不是新增运行通过证据。

后续首次读取 Simulator 超时，应用列表一度恢复，但重新读取 Simulator 和 Finder 窗口仍超时。
这是窗口自动化阻塞，不能通过跳过预览来替代其它页面操作。已请求用户恢复可操作的前台桌面；
未重启正式 Backend、修改正式认证或用 Backend 调用冒充原生 UI 通过。

再次恢复执行时，CUA 仍在获取 Simulator 阶段超时。已准备并成功 build-for-testing 一个
本地 XCUITest UI 执行器（`.runweave/native-ui-runner/`），仅通过 XCUIApplication 操作
已安装候选界面，保存 screenshot 与 hierarchy；没有导入业务模块或新增单元测试。
截至该准备记录，仅完成执行器编译，尚未执行；已异步请求用户授权切换 UI 操作技术。

同时发现当前 Xcode host 的三个配置已声明最低 iOS 18.6，而 Swift package 仍声明 iOS 15；
保留这项现有工作区修改，未自行调整最低版本或将 IOSTERM-013 改成通过。
