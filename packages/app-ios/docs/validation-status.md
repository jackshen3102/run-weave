# 原生 iOS 验收状态

2026-09-07 范围更新：用户已接入 iPhone 17，真机用例开始执行；用户明确排除
`IOSTERM-013`（iOS 15 兼容性）以及 `IOSSESSION-015` 中的 HTTPS/WSS 与 TLS 证书测试，
这些子项不再作为验收阻塞，也不再等待 HTTPS 地址。局域网权限拒绝与恢复已在真机通过。
下文保留 2026-09-06 的结果快照。
真机预检、当前 Debug 构建/安装/启动、登录保留与 XCUITest 就绪已通过。
`IOSTERM-005` 已修复并通过真机回归：动态手势优先级覆盖 SwiftTerm 后装载的 pan，
6000 行历史可拖动，tmux 历史模式 0→1→0，回到底部后的命令执行正常。
新增 `IOSSESSION-016` 已通过真机完整回归：中央拖动不退出，左边缘右滑返回 Home，
重开同一终端保留草稿且不自动发送；客户端数 0→1→0→1，远端 pane PID 保持。
终端详情改为系统导航推入，临时触摸诊断代码已移除。当前 Debug 与 Release 真机构建通过。
`IOSTERM-007` 恢复功能与新输入通过：约 360 秒接收空档后恢复同一会话和实时画面，
后台程序仅启动一次，新命令仅执行一次；仍需在同次持续输出锁屏运行中补齐恢复耗时与 scene/socket 记录。
`IOSTERM-009` 已通过真机 Metal 渲染与新实例失败降级；两条路径导出字符/光标一致。
默认仍为 CoreGraphics，持续输出性能仍在验证；局域网 HTTP 真机连接与权限拒绝/恢复已取证。
`IOSFEATURE-006` 已完成真实语音转写、取消、麦克风拒绝与恢复、服务失败与上传参数取证。
上传实测 audio/wav、24 kHz、单声道、16 位；声明时长与 WAV 时长最大差约 21 ms。
仍保留部分完成：早前取消测试结束后记录一次来源未明的发送，无触摸回归未复现。
新增 `IOSFEATURE-013` 已通过：修复成功转写后页面顶部残留旧 HTTP 503 错误；
同一真机与独立 fixture 内验证失败→成功后旧错误消失，等待二十秒无自动发送，
显式发送仅出现一次输入。媒体局部错误不再写入全局错误，认证和网络状态处理保留。
此次修复 Debug/Release 真机构建、Swift 格式与 21 项映射检查通过，功能计划共 13 项校验通过。
`IOSTERM-015` 已修复并通过真机回归：SwiftTerm 解析输出时产生的自动设备响应，
在 tmux 模式下不再经 pane 输入接口写入 shell；键盘和快捷键路径保持，普通 PTY 仍返回合法设备信息。
真实 tmux 验证零自动 WS input、显式命令一次、Ctrl-C 一次；普通 PTY 收到合法设备属性响应。
Debug/Release 真机构建、Swift 格式、21 项源码映射和新增终端计划 15 项校验通过。
见[tmux 输入证据](../../../.runweave/ios-real-backend-20260907/tmux-response-verification.json)、
[真机回归](../../../.runweave/native-device-runner/query-routing-tmux-clean.xcresult)与
[PTY 回归](../../../.runweave/native-device-runner/query-routing-pty.xcresult)。

本轮补充通过：独立真实 Backend 重启后的新事件流与 Home 同步；前台独立断网后大 TUI 恢复；
只读原生客户端退出后旧客户端继续输入；旧 App 同 fixture Diff 与 Unicode 对照；
Safari 外链请求无认证头/Cookie、无原生 bridge；新旧安装、连接配置与主题隔离。
Unicode 差异已记录：SwiftTerm 保留 👩‍💻 为 2 格，旧 xterm Unicode 11 拆成两个 emoji 共 4 格，
没有将旧端退化复制到原生。
原生已恢复 mac 后端、深色主题和已有登录，测试连接 Dedicated Real Backend 已移除，远端测试资源仍在。
旧 App 的 5 个连接、默认家里mac和深色外观前后不变；
[隔离与恢复证据](../../../.runweave/native-device-runner/dedicated-cleanup-isolation.xcresult)。
原 native-theme-old-isolation runner 的原生主题步骤通过，但旧端面板定位失败；
旧端已独立补跑通过，没有把失败 runner 整体计作通过。

`IOSSESSION-015` 局域网权限子项已通过：拒绝时保留 Home/登录、禁用写操作并显示可解释的连接错误；
用户恢复权限后手动检测显示在线且已登录，无需重新认证，原终端重新连接，pane PID 75312 保持。
[权限拒绝](../../../.runweave/native-device-runner/local-network-denied-verified.xcresult)与
[恢复证据](../../../.runweave/native-device-runner/local-network-restored-verified.xcresult)。TLS 仍按用户要求排除。

`IOSFEATURE-007` 按本轮有效范围通过：项目搜索隔离、相对越界与越界软链接拒绝已取证。
用户明确排除“项目外绝对路径预览”子项，保持后端现有只读预览行为，不再等待该决策。

前后台及操作来源诊断已补充：记录 scene 与 Composer/录音按钮动作，不记录命令或语音正文。
Profile 真机连续 3 次取消录音、等待 20 秒无输入；显式发送对应 1 次动作、1 次 accepted 和 1 次后端执行。
[诊断回归证据](../../../.runweave/ios-native-evidence/device-20260907/action-scene-verification.json)。
Profile/Release 真机构建、Swift 格式与 21 项映射检查通过；历史来源未明输入仍单独保留。
新增一次锁屏实测：后台 408.708 秒，scene.active 到 snapshot 接收 1.328 秒，
ticket 到 snapshot 0.168 秒，原 shell PID 保持，恢复后新输入执行一次。
但该次输出程序在锁屏前已被 Ctrl-C 停止，不能作为持续输出锁屏用例的完整证据；
snapshot 接收也不等于画面已经提交。
[锁屏计量及限制](../../../.runweave/ios-native-evidence/device-20260907/lock-metrics-return-verification.json)。

`IOSTERM-010` 的原生性能子项已通过完整 Profile 真机重跑：256 KiB/s、600 秒、150 MiB，
字号 14、46×12、5000 行 scrollback、CoreGraphics。接收与提交均为 157286452 B，
前 60 秒输出提交 p95 为 41.56 ms，本地输入提交 p95 为 4.51 ms（130 次）；
队列峰值 23 KiB、最终为 0，最后接收到提交为 36.69 ms，最终截图包含末行与 PERF END。
第二/第十分钟附近 RSS 为 163.44/163.89 MiB，增长 0.28%，五秒采样峰值 165.64 MiB。
RSS 包含内部计量开销；正常结束的 Instruments 短录制另取得该进程 RSS，用于交叉核对。
输出延迟从解码后的通知开始，不包含 WebSocket JSON 解码；输入从应用事件分发开始，
不包含 OS 键盘投递。UIKit afterCATransactionCommit 不代表屏幕发光时刻。
内部验证入口新增 RSS 采样与保存失败提示，Profile/Release 构建、格式和 21 项映射检查通过。
[完整原生负载结果](../../../.runweave/ios-native-evidence/device-20260907/performance-native-rss-analysis.json)与
[真机 UI 回归](../../../.runweave/native-device-runner/performance-long-native-rss.xcresult)。

旧 xterm 对照仍未完成十分钟：同一手机的 Safari 加载原有 TerminalRenderer，
固定 46×12 与系统等宽字号 14；这是组件测试页，不是旧 App 安装包的完整性能测量。
已取得前 60 秒数据，但两轮先后出现 WebSocket 关闭与 CoreDevice 控制连接失效，
第二次未同时录制 Instruments，仍发生中断；设备工具随后已无法找到手机，停止真机操作。
用户指出手机仍连接后重新核对：USB 注册表可见 iPhone，xcdevice 也显示 USB 可用；
不可用的是 CoreDevice tunnel。刷新已有配对后恢复 connected，进程查询与 DDI 服务均成功。
没有解除配对或重置手机，不能把先前工具不可用描述为手机被拔掉。
[控制通道恢复记录](../../../.runweave/ios-native-evidence/device-20260907/device-channel-recovery.json)。
其 onRender 加两次 requestAnimationFrame 的计量边界不同，不能将两端数字直接换算为速度比例。
首轮另因布局变成 44 列及输入焦点问题作废，已修正测试页，未计为通过。
[旧端结果及中断记录](../../../.runweave/ios-native-evidence/device-20260907/performance-legacy-analysis.json)。
首次原生录制曾提前结束显示采样，且断连文件没有可导出的 RSS 行；
该轮限制保留在[首次负载分析](../../../.runweave/ios-native-evidence/device-20260907/performance-native-initial-analysis.json)，
没有使用那份文件推断内存增幅。

当前累计 **44 个用例：40 通过（含明确排除的子项）、3 部分完成、1 整项排除**。
尚未完成：

- `IOSFEATURE-006`：早前取消测试后的一次来源未明 HTTP 输入；与本次 raw 设备响应缺陷不是同一证据，未合并结论。
- `IOSTERM-007`：在同次持续输出锁屏运行中补齐恢复耗时与 scene/socket 记录。
- `IOSTERM-010`：原生性能子项通过，同设备旧 xterm 十分钟基线因真机连接丢失未完成。

`IOSTERM-013` 按用户要求排除。部分完成和未执行均不计为通过。
[累计结果](../../../.runweave/ios-native-evidence/goal-results.json)与
[真机执行记录](../../../.runweave/ios-native-evidence/device-20260907/results.json)。
下文 9 月 6 日表格为历史快照，不代表本轮当前状态。

2026-09-06，候选版本 0.1.0。41 个正式用例已逐项核对：**23 项通过，10 项部分完成，8 项未执行**（6 项真机、2 项环境受限）。部分完成不计为通过。按本轮约定，真机和下表列明的困难子项跳过；这不代表可替换旧 App 或全部迁移门禁已通过。

## 执行环境与证据边界

- iPhone 17 模拟器，iOS 26.5，UDID `B51A836B-2DEE-4E18-9FE6-442B63B9E9C3`；Xcode 26.6，SwiftTerm 1.19.0，CoreGraphics renderer。
- 原生操作使用用户授权的独立 XCUITest runner，实际点击、输入、旋转、截图并核对 HTTP/WS 或 tmux 结果。未新增产品单元测试。
- 真实业务链路连接现有 `http://127.0.0.1:5001`；故障注入使用仅本例持有的 HTTP/WS 协议服务和 node-pty，未修改或重启正式 Backend。
- 旧 Web 的 Playwright CLI 确实尝试执行，但返回 `No terminal browser target available`。旧 Bundle 可安装启动不等于新旧功能对照通过。
- 普通文件预览按用户已验收跳过重复验证；404/413/415 仍实际执行。部分用例共用受控 fixture，结果按子步骤取证，不宣称每个用例都完成独立环境重建。
- 本地原始证据位于仓库根 `.runweave/native-ui-runner/` 与 `.runweave/ios-native-evidence/`，属于忽略产物；下列证据链接在本工作区可用，不随 Git 自动分发。

## 已修复并回归的问题

1. 输入已被接收但响应丢失时，原生只显示普通网络错误。现在明确提示“发送结果未确认”，保留草稿并要求用户先核对结果；没有自动重发。见 [输入错误分类](../Sources/RunweaveIOS/Contracts/APIError.swift) 与 [真实原生回归](../../../.runweave/native-ui-runner/image-upload-unconfirmed-coordinate.xcresult)。
2. 诊断导出丢失记录所属连接。现在每条导出记录保留 `connectionId` 与 `client=native-ios`，并允许所需关联字段。修复前 72 条均无连接 ID，修复后 182 条全部带 ID，测试凭据及命令 marker 未泄漏。见 [诊断存储](../Sources/RunweaveIOS/State/DiagnosticStore.swift) 与 [回归](../../../.runweave/native-ui-runner/diagnostic-export-regression.xcresult)。

Debug、Release 构建、Swift 格式检查和 21 项源码映射检查通过；这些静态结果没有用于替代运行验收，也未将映射批量改为 verified。

## 未执行或未完整执行清单

表内“部分”表示已完成部分步骤，但列出的子项没有取得完整证据。

| 用例                                                | 状态       | 已验证与剩余缺口                                                                                                                                                                      |
| --------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| IOSFEATURE-006 录音转写保持用户确认边界             | 未测：真机 | 按用户范围排除真机：录音转写保持用户确认边界                                                                                                                                          |
| IOSFEATURE-007 文件浏览搜索保持项目作用域           | 部分       | 已验证 A/B 同名文件隔离、嵌套搜索和 symlink 在搜索中排除。未执行：直接构造越界 HTTP 请求的后端拒绝；UI 没有任意路径入口，保留为未覆盖的后端边界子项。                                 |
| IOSFEATURE-008 文件内容与预览错误有明确边界         | 部分       | 实际 404/413/415 错误提示和登录保留通过；普通预览按用户已验收不重复。未执行：外链携带凭据与内容容器权限的独立网络取证，现有浏览器验收入口无法附着。                                   |
| IOSFEATURE-009 Changes 与 Diff 保留只读审阅语义     | 部分       | 新增、删除、修改、重命名及 staged/working Diff 内容检查、大 Diff 打开返回通过；14 项文件/索引哈希一致。未执行：旧 App 同 fixture UI 对照，Playwright 找不到 terminal browser target。 |
| IOSFEATURE-012 主题选择在原生界面与终端一致持久化   | 部分       | 原生明暗主题在 Home、Composer、终端、预览一致，冷启动保留并恢复原来的深色。未执行：旧 App 主题前后独立 UI 对照；旧端自动化入口受阻。                                                  |
| IOSSESSION-004 删除本地连接不清理其他连接           | 部分       | 原生删除 A 配置后 B 可访问，服务端 fixture 资源仍在，未发起远端删除。未执行：旧 App 连接配置前后完整 UI 对照。                                                                        |
| IOSSESSION-012 Backend 重启后的事件流重新同步       | 部分       | 新 streamId 后重读权威 overview 通过，隔离协议进程重启后亦恢复。未完整执行：按正式 Backend 重启后创建新资源并观察事件的全流程；没有重启用户正式后端。                                 |
| IOSSESSION-014 原生连接配置与旧安装态隔离持久化     | 部分       | 测试 HTTP 地址前缀规范化、移除 query/hash、拒绝 FTP，以及编辑名称和冷启动持久化通过。未完整执行：已登录连接修改目标地址后的全链路，以及旧 App 配置前后 UI 对照。                      |
| IOSSESSION-015 原生网络权限与 TLS 连接结果准确      | 未测：真机 | 按用户范围排除真机：原生网络权限与 TLS 连接结果准确                                                                                                                                   |
| IOSTERM-001 独立原生 App 可以在模拟器与旧 App 并存  | 部分       | 原生 doctor、Debug/Release 构建、安装启动和旧 Bundle 独立启动通过。未完整执行：旧 App 连接列表与默认连接的前后 UI 对照；独立容器和可启动不能代替此子项。                              |
| IOSTERM-004 Unicode 与分包控制序列保持正确          | 部分       | 最新原生 Debug Probe 已逐字节重放并导出字符/光标。旧 xterm Playwright 对照环境无法附着，尚无本轮新旧同 fixture 完整对照。                                                             |
| IOSTERM-005 tmux 历史滚动能正确回到实时输出         | 未测：真机 | 按用户范围排除真机：tmux 历史滚动能正确回到实时输出                                                                                                                                   |
| IOSTERM-006 网络断开后的 TUI 恢复不依赖完整输出尾部 | 部分       | 超过 64 KiB 初始化输出的 TUI 在客户端后台暂停 socket 后恢复当前画面，服务端持续运行。未执行：独立网络故障而不触发 scene 生命周期的同等恢复；后台恢复不替代该子项。                    |
| IOSTERM-007 真机锁屏返回后恢复同一个会话            | 未测：真机 | 按用户范围排除真机：真机锁屏返回后恢复同一个会话                                                                                                                                      |
| IOSTERM-009 Metal 渲染路径真实可用且降级明确        | 未测：真机 | 按用户范围排除真机：Metal 渲染路径真实可用且降级明确                                                                                                                                  |
| IOSTERM-010 持续输出满足原生渲染性能预算            | 未测：真机 | 按用户范围排除真机：持续输出满足原生渲染性能预算                                                                                                                                      |
| IOSTERM-011 原生客户端退出只释放自己的连接          | 未测：环境 | 未执行新旧客户端共用 session 的只读附着/退出隔离。旧端 Playwright 报 No terminal browser target available，无法建立要求的旧端唯一输入/resize 所有者；不以两个写客户端替代。           |
| IOSTERM-013 声明的最低 iOS 版本能实际运行           | 未测：环境 | 无 iOS 15 runtime。宿主现为用户设置的最低 iOS 18.6，Swift package 仍声明 iOS 15；无法用 iOS 26.5 冒充最低版本运行验证。                                                               |

## 全部用例记录

通过项也保留实际验证范围；协议 fixture 结果不冒充正式后端全流程结果。

| 用例                                                 | 结果 | 本轮证据与范围                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| IOSFEATURE-001 Composer 保留文本提交与未确认结果语义 | 通过 | 原生 UI 与协议录入记录通过：三种输入模式；照片引用 shell quoting；取消保留草稿；仅显式发送才写入；响应丢失不重发且修复后的未确认提示通过回归。 [证据 1](../../../.runweave/native-ui-runner/fixture-input-stop-protocol-valid.xcresult) [证据 2](../../../.runweave/native-ui-runner/image-upload-unconfirmed-coordinate.xcresult) [证据 3](../../../.runweave/native-ui-runner/fixture-events.jsonl)                          |
| IOSFEATURE-002 快捷键使用原始控制序列                | 通过 | 协议记录的 Ctrl-C/Tab/Esc/方向键/Enter 原始字节正确且保留草稿；真实 tmux 补全、历史执行与 Ctrl-C 中断闭环通过。 [证据 1](../../../.runweave/native-ui-runner/real-tui-recovery.xcresult) [证据 2](../../../.runweave/native-ui-runner/landscape-history-screen.xcresult) [证据 3](../../../.runweave/ios-native-evidence/remote-pty-sizes.jsonl)                                                                               |
| IOSFEATURE-003 Stop 展示以后端 Agent 状态为准        | 通过 | interrupt 响应后仍显示 Stop；释放权威 idle 事件后才收敛。请求关联信息见协议记录。 [证据 1](../../../.runweave/native-ui-runner/fixture-input-stop-protocol-valid.xcresult) [证据 2](../../../.runweave/native-ui-runner/fixture-events.jsonl)                                                                                                                                                                                  |
| IOSFEATURE-004 历史查看与复制不影响实时会话          | 通过 | 复制全部并粘贴 520 行已知多屏历史，0001 至 0520 完整有序；关闭历史后回到持续更新的实时终端。本轮使用全选范围，未另测任意局部选择手柄。 [证据 1](../../../.runweave/native-ui-runner/real-tui-recovery.xcresult) [证据 2](../../../.runweave/native-ui-runner/landscape-history-screen.xcresult) [证据 3](../../../.runweave/ios-native-evidence/remote-pty-sizes.jsonl)                                                        |
| IOSFEATURE-005 图片上传只进入待发送草稿              | 通过 | 原生 UI 与协议录入记录通过：三种输入模式；照片引用 shell quoting；取消保留草稿；仅显式发送才写入；响应丢失不重发且修复后的未确认提示通过回归。 [证据 1](../../../.runweave/native-ui-runner/fixture-input-stop-protocol-valid.xcresult) [证据 2](../../../.runweave/native-ui-runner/image-upload-unconfirmed-coordinate.xcresult) [证据 3](../../../.runweave/native-ui-runner/fixture-events.jsonl)                          |
| IOSFEATURE-006 录音转写保持用户确认边界              | 未测 | 按用户范围排除真机：录音转写保持用户确认边界                                                                                                                                                                                                                                                                                                                                                                                   |
| IOSFEATURE-007 文件浏览搜索保持项目作用域            | 部分 | 已验证 A/B 同名文件隔离、嵌套搜索和 symlink 在搜索中排除。未执行：直接构造越界 HTTP 请求的后端拒绝；UI 没有任意路径入口，保留为未覆盖的后端边界子项。 [证据 1](../../../.runweave/native-ui-runner/connection-isolation-theme-recovered.xcresult) [证据 2](../../../.runweave/native-ui-runner/real-files-scope-errors.xcresult)                                                                                               |
| IOSFEATURE-008 文件内容与预览错误有明确边界          | 部分 | 实际 404/413/415 错误提示和登录保留通过；普通预览按用户已验收不重复。未执行：外链携带凭据与内容容器权限的独立网络取证，现有浏览器验收入口无法附着。 [证据 1](../../../.runweave/native-ui-runner/restart-preview-expanded.xcresult) [证据 2](../../../.runweave/native-ui-runner/real-tui-recovery.xcresult)                                                                                                                   |
| IOSFEATURE-009 Changes 与 Diff 保留只读审阅语义      | 部分 | 新增、删除、修改、重命名及 staged/working Diff 内容检查、大 Diff 打开返回通过；14 项文件/索引哈希一致。未执行：旧 App 同 fixture UI 对照，Playwright 找不到 terminal browser target。 [证据 1](../../../.runweave/native-ui-runner/core-features.xcresult) [证据 2](../../../.runweave/native-ui-runner/image-memory-diff-delete.xcresult) [证据 3](../../../.runweave/ios-native-evidence/readonly-fixture-verification.json) |
| IOSFEATURE-010 图片预览可缩放关闭并释放资源          | 通过 | 1206×2622 PNG 全屏缩放、平移和返回通过；10 次开关的 49 个 RSS 样本为 432.47–440.06 MiB，起止 439.95→432.56 MiB，未见持续增长或残留遮罩。这是模拟器短周期观察，不是真机性能门禁。 [证据 1](../../../.runweave/native-ui-runner/image-diff-fixed.xcresult) [证据 2](../../../.runweave/native-ui-runner/image-memory-diff-delete.xcresult) [证据 3](../../../.runweave/ios-native-evidence/readonly-fixture-verification.json)   |
| IOSFEATURE-011 诊断记录可关联排障且不泄漏凭据        | 通过 | 开始/停止并收集/导出均通过；修复后 182 条记录全部带 connectionId，未检出测试凭据或命令全文 marker；未开启时未发生 stop/upload。 [证据 1](../../../.runweave/native-ui-runner/diagnostic-export-regression.xcresult) [证据 2](../../../.runweave/ios-native-evidence/diagnostics-after-fix.json) [证据 3](../../../.runweave/native-ui-runner/fixture-events.jsonl)                                                             |
| IOSFEATURE-012 主题选择在原生界面与终端一致持久化    | 部分 | 原生明暗主题在 Home、Composer、终端、预览一致，冷启动保留并恢复原来的深色。未执行：旧 App 主题前后独立 UI 对照；旧端自动化入口受阻。 [证据 1](../../../.runweave/native-ui-runner/connection-isolation-theme-recovered.xcresult)                                                                                                                                                                                               |
| IOSSESSION-001 独立登录与重开后认证可用              | 通过 | A/B 独立登录和冷启动读取通过；请求包含 X-Auth-Client: app，后续使用 Bearer。测试凭据 marker 未出现在普通文件和日志；认证保存在独立 Keychain。 [证据 1](../../../.runweave/native-ui-runner/fixture-login.xcresult) [证据 2](../../../.runweave/native-ui-runner/connection-isolation-theme-recovered.xcresult) [证据 3](../../../.runweave/native-ui-runner/fixture-events.jsonl)                                              |
| IOSSESSION-002 并发读取只执行一次有效刷新            | 通过 | access 过期后的并发读取仅产生 1 次 refresh，读取恢复、保持登录，未出现刷新风暴。 [证据 1](../../../.runweave/native-ui-runner/network-refresh-valid.xcresult) [证据 2](../../../.runweave/native-ui-runner/network-refresh-valid.swift) [证据 3](../../../.runweave/native-ui-runner/fixture-events.jsonl)                                                                                                                     |
| IOSSESSION-003 明确认证撤销只清理所属连接            | 通过 | 只撤销测试连接 A：A 要求重新登录，切到 B 仍能读取项目，未发生全局登出。 [证据 1](../../../.runweave/native-ui-runner/revocation-events-diagnostics.xcresult) [证据 2](../../../.runweave/native-ui-runner/fixture-events.jsonl)                                                                                                                                                                                                |
| IOSSESSION-004 删除本地连接不清理其他连接            | 部分 | 原生删除 A 配置后 B 可访问，服务端 fixture 资源仍在，未发起远端删除。未执行：旧 App 连接配置前后完整 UI 对照。 [证据 1](../../../.runweave/native-ui-runner/pty-cleanup-unicode.xcresult) [证据 2](../../../.runweave/native-ui-runner/edit-cleanup-probe.xcresult) [证据 3](../../../.runweave/ios-native-evidence/goal-doctor.log)                                                                                           |
| IOSSESSION-005 切换电脑拒绝旧响应和旧终端路由        | 通过 | A/B 具有相同资源 ID 和路径；切换 B 后延迟 12 秒的 A 响应不覆盖 B，也未打开 A 的旧路由，B 文件内容正确。 [证据 1](../../../.runweave/native-ui-runner/fixture-login.xcresult) [证据 2](../../../.runweave/native-ui-runner/connection-isolation-theme-recovered.xcresult) [证据 3](../../../.runweave/native-ui-runner/fixture-events.jsonl)                                                                                    |
| IOSSESSION-006 网络不可达保留认证与已加载内容        | 通过 | 控制协议服务的不可达故障使原生显示 Offline，保留已加载 Home、草稿及认证，恢复后无需重新登录。未操作真实后端网络。 [证据 1](../../../.runweave/native-ui-runner/network-refresh-valid.xcresult) [证据 2](../../../.runweave/native-ui-runner/network-refresh-valid.swift) [证据 3](../../../.runweave/native-ui-runner/fixture-events.jsonl)                                                                                    |
| IOSSESSION-007 HTTP 服务错误与权限错误不冒充登出     | 通过 | 分别注入 403、503，显示对应错误、保留认证；恢复成功响应后能继续读取。 [证据 1](../../../.runweave/native-ui-runner/network-refresh-valid.xcresult) [证据 2](../../../.runweave/native-ui-runner/network-refresh-valid.swift) [证据 3](../../../.runweave/native-ui-runner/fixture-events.jsonl)                                                                                                                                |
| IOSSESSION-008 已删除终端显示资源不存在              | 通过 | 终端 ticket 404 显示资源不存在并停止重复获取，Home 和其他资源仍可用，未清理认证。 [证据 1](../../../.runweave/native-ui-runner/network-refresh-valid.xcresult) [证据 2](../../../.runweave/native-ui-runner/network-refresh-valid.swift) [证据 3](../../../.runweave/native-ui-runner/fixture-events.jsonl)                                                                                                                    |
| IOSSESSION-009 离线操作不会恢复后自动执行            | 通过 | 离线状态下原生写操作禁用、草稿保留；恢复后无自动输入，显式再次发送才出现 1 次 input。协议服务记录未出现离线业务写请求。 [证据 1](../../../.runweave/native-ui-runner/network-refresh-valid.xcresult) [证据 2](../../../.runweave/native-ui-runner/network-refresh-valid.swift) [证据 3](../../../.runweave/native-ui-runner/fixture-events.jsonl)                                                                              |
| IOSSESSION-010 设备状态与 Agent 状态独立展示         | 通过 | 延迟健康/connected 时 raw socket open 不直接取得可写状态；权威连接和 Agent 事件分别更新，设备离线未把 Agent 改成 idle。 [证据 1](../../../.runweave/native-ui-runner/network-refresh-valid.xcresult) [证据 2](../../../.runweave/native-ui-runner/network-refresh-valid.swift) [证据 3](../../../.runweave/native-ui-runner/fixture-events.jsonl)                                                                              |
| IOSSESSION-011 同一事件流的重放与去重正确            | 通过 | 不透明事件 ID 9007199254740993 重复投递不回退状态；重连请求保留字符串游标，未转成有损数值。 [证据 1](../../../.runweave/native-ui-runner/revocation-events-diagnostics.xcresult) [证据 2](../../../.runweave/native-ui-runner/fixture-events.jsonl)                                                                                                                                                                            |
| IOSSESSION-012 Backend 重启后的事件流重新同步        | 部分 | 新 streamId 后重读权威 overview 通过，隔离协议进程重启后亦恢复。未完整执行：按正式 Backend 重启后创建新资源并观察事件的全流程；没有重启用户正式后端。 [证据 1](../../../.runweave/native-ui-runner/revocation-events-diagnostics.xcresult) [证据 2](../../../.runweave/native-ui-runner/fixture-events.jsonl)                                                                                                                  |
| IOSSESSION-013 原生资源创建打开删除形成完整生命周期  | 通过 | 真实后端：原生 UI 创建项目和终端、重开；取消删除后会话仍在，再确认删除后 Home 为空且 rw 独立确认 session 消失。剩余测试资源已清理。 [证据 1](../../../.runweave/native-ui-runner/fixture.xcresult) [证据 2](../../../.runweave/native-ui-runner/fixture-open.xcresult) [证据 3](../../../.runweave/native-ui-runner/delete-owned-terminal-confirmed.xcresult)                                                                  |
| IOSSESSION-014 原生连接配置与旧安装态隔离持久化      | 部分 | 测试 HTTP 地址前缀规范化、移除 query/hash、拒绝 FTP，以及编辑名称和冷启动持久化通过。未完整执行：已登录连接修改目标地址后的全链路，以及旧 App 配置前后 UI 对照。 [证据 1](../../../.runweave/native-ui-runner/pty-cleanup-unicode.xcresult) [证据 2](../../../.runweave/native-ui-runner/edit-cleanup-probe.xcresult) [证据 3](../../../.runweave/ios-native-evidence/goal-doctor.log)                                         |
| IOSSESSION-015 原生网络权限与 TLS 连接结果准确       | 未测 | 按用户范围排除真机：原生网络权限与 TLS 连接结果准确                                                                                                                                                                                                                                                                                                                                                                            |
| IOSTERM-001 独立原生 App 可以在模拟器与旧 App 并存   | 部分 | 原生 doctor、Debug/Release 构建、安装启动和旧 Bundle 独立启动通过。未完整执行：旧 App 连接列表与默认连接的前后 UI 对照；独立容器和可启动不能代替此子项。 [证据 1](../../../.runweave/native-ui-runner/pty-cleanup-unicode.xcresult) [证据 2](../../../.runweave/native-ui-runner/edit-cleanup-probe.xcresult) [证据 3](../../../.runweave/ios-native-evidence/goal-doctor.log)                                                 |
| IOSTERM-002 tmux attach 实时流可驱动原生终端         | 通过 | 真实 5001 ticket/WS/tmux/SwiftTerm 链路显示 ANSI 和光标重绘 TUI；退出恢复 shell，唯一 marker 仅执行一次，未以 capture 轮询替代实时输出。 [证据 1](../../../.runweave/native-ui-runner/real-tui-recovery.xcresult) [证据 2](../../../.runweave/native-ui-runner/landscape-history-screen.xcresult) [证据 3](../../../.runweave/ios-native-evidence/remote-pty-sizes.jsonl)                                                      |
| IOSTERM-003 视口变化与远端行列数保持一致             | 通过 | 键盘、横竖屏稳定布局和真实远端 stty 采样通过；列数 46↔86。tmux 开启 1 行状态栏，原生外层 31/9 行对应 shell pane 30/8 行；未发现零尺寸、持续重复 resize 或永久错位。 [证据 1](../../../.runweave/native-ui-runner/real-tui-recovery.xcresult) [证据 2](../../../.runweave/native-ui-runner/landscape-history-screen.xcresult) [证据 3](../../../.runweave/ios-native-evidence/remote-pty-sizes.jsonl)                           |
| IOSTERM-004 Unicode 与分包控制序列保持正确           | 部分 | 最新原生 Debug Probe 已逐字节重放并导出字符/光标。旧 xterm Playwright 对照环境无法附着，尚无本轮新旧同 fixture 完整对照。 [证据 1](../../../.runweave/native-ui-runner/edit-cleanup-probe.xcresult) [证据 2](../../../.runweave/ios-native-evidence/unicode-current.json)                                                                                                                                                      |
| IOSTERM-005 tmux 历史滚动能正确回到实时输出          | 未测 | 按用户范围排除真机：tmux 历史滚动能正确回到实时输出                                                                                                                                                                                                                                                                                                                                                                            |
| IOSTERM-006 网络断开后的 TUI 恢复不依赖完整输出尾部  | 部分 | 超过 64 KiB 初始化输出的 TUI 在客户端后台暂停 socket 后恢复当前画面，服务端持续运行。未执行：独立网络故障而不触发 scene 生命周期的同等恢复；后台恢复不替代该子项。 [证据 1](../../../.runweave/native-ui-runner/real-tui-recovery.xcresult) [证据 2](../../../.runweave/native-ui-runner/landscape-history-screen.xcresult) [证据 3](../../../.runweave/ios-native-evidence/remote-pty-sizes.jsonl)                            |
| IOSTERM-007 真机锁屏返回后恢复同一个会话             | 未测 | 按用户范围排除真机：真机锁屏返回后恢复同一个会话                                                                                                                                                                                                                                                                                                                                                                               |
| IOSTERM-008 App 进程重新启动不会破坏远端会话         | 通过 | 终止原生 App 再启动后重新打开相同 tmux session，TUI PID 与启动次数不变，更新继续，后续输入可用且不重放旧命令。 [证据 1](../../../.runweave/native-ui-runner/real-tui-recovery.xcresult) [证据 2](../../../.runweave/native-ui-runner/landscape-history-screen.xcresult) [证据 3](../../../.runweave/ios-native-evidence/remote-pty-sizes.jsonl)                                                                                |
| IOSTERM-009 Metal 渲染路径真实可用且降级明确         | 未测 | 按用户范围排除真机：Metal 渲染路径真实可用且降级明确                                                                                                                                                                                                                                                                                                                                                                           |
| IOSTERM-010 持续输出满足原生渲染性能预算             | 未测 | 按用户范围排除真机：持续输出满足原生渲染性能预算                                                                                                                                                                                                                                                                                                                                                                               |
| IOSTERM-011 原生客户端退出只释放自己的连接           | 未测 | 未执行新旧客户端共用 session 的只读附着/退出隔离。旧端 Playwright 报 No terminal browser target available，无法建立要求的旧端唯一输入/resize 所有者；不以两个写客户端替代。 [证据 1](../../../.runweave/ios-native-evidence/legacy-browser-blocker.txt)                                                                                                                                                                        |
| IOSTERM-012 协议未知扩展与已知字段错误可区分         | 通过 | 合法 output 的未知可选字段及未知事件可忽略；必需 data 缺失与类型错误分别触发明确协议错误并停止可写状态，无失控重连。连接切换的旧实例隔离另见 IOSSESSION-005。 [证据 1](../../../.runweave/native-ui-runner/fixture-input-stop-protocol-valid.xcresult) [证据 2](../../../.runweave/native-ui-runner/fixture-events.jsonl) [证据 3](../../../.runweave/native-ui-runner/protocol-missing-data-final.xcresult)                   |
| IOSTERM-013 声明的最低 iOS 版本能实际运行            | 未测 | 无 iOS 15 runtime。宿主现为用户设置的最低 iOS 18.6，Swift package 仍声明 iOS 15；无法用 iOS 26.5 冒充最低版本运行验证。 [证据 1](../../../packages/app-ios/ios/RunweaveNative.xcodeproj/project.pbxproj) [证据 2](../../../packages/app-ios/Package.swift)                                                                                                                                                                     |
| IOSTERM-014 原生终端保留普通 PTY 会话兼容性          | 通过 | 原生 App 通过隔离协议服务连接真实 node-pty shell：runtimeKind=pty、输出/raw 输入、Ctrl-C、shell exit 收敛通过，无 tmux 专属操作。该结果验证客户端 PTY 合同，不宣称测试了正式后端 PTY 创建流程。 [证据 1](../../../.runweave/native-ui-runner/pty-cleanup-unicode.xcresult) [证据 2](../../../.runweave/native-ui-runner/edit-cleanup-probe.xcresult) [证据 3](../../../.runweave/ios-native-evidence/goal-doctor.log)          |

## 关键量化证据

- 历史复制：520 行，0001–0520 连续且有序，见 [校验](../../../.runweave/ios-native-evidence/history-copy-final-verification.json)。
- 图片：1206×2622 PNG，10 次开关，26.576 秒内 49 个 RSS 样本；439.95→432.56 MiB，区间 432.47–440.06 MiB。只说明本轮短周期未持续增长，不证明长期不存在泄漏。见 [采样汇总](../../../.runweave/ios-native-evidence/image-memory-verification.json)。
- 只读审阅：14 项文件与 Git 索引内容哈希前后一致，见 [校验](../../../.runweave/ios-native-evidence/readonly-fixture-verification.json)。
- 尺寸：tmux 启用一行状态栏；原生外层行数与 shell pane 的 stty 行数相差一行属于不同测量层。横竖屏列数 46↔86，外层 31/9 行对应 pane 30/8 行。
- 测试 runner 曾因隐藏列表、异步断言、popover 无独立取消按钮及横屏局部截图裁切失败。保留原失败产物，不能把整批失败报告当作整批通过。删除取消/确认已在独立 [重跑](../../../.runweave/native-ui-runner/delete-owned-terminal-confirmed.xcresult) 通过；图片/Diff 的早期成功步骤另由截图、采样及哈希佐证。

## 构建与清理

- [Debug 构建](../../../.runweave/ios-native-evidence/goal-diagnostic-fix-build.log)、[Release 构建](../../../.runweave/ios-native-evidence/goal-final-release-build.log)、[映射检查](../../../.runweave/ios-native-evidence/goal-mapping.log)。
- 原生 App 保留安装，已恢复正式连接、原登录态和未过滤的 Home；测试连接全部移除，原主题恢复。
- 仅清理本轮拥有的终端 `8d6d746d`、`7f2680d1` 和空项目 `601d769a-01b8-4b2f-b7f9-6f589c78e87e`。真实后端独立确认无残留，其他终端保留。见 [清理结果](../../../.runweave/ios-native-evidence/cleanup.json)。
- 临时协议服务和旧 Web 预览进程已停止。未提交、未推送，也未修改正式 Backend。
- 三份 YAML 是验收合同；本页是本次候选的状态入口，完整机器记录见 [41 项明细](../../../.runweave/ios-native-evidence/goal-results.json)。
