# iOS 原生重构 P0/P1 执行记录

日期：2026-09-06。基线：`26a3d821d1206d389518859bf82650b55648cd7a`。
这是执行中的阶段交付：P0 完成，P1 部分完成；不是整个原生重构完成或发布验收。
[原计划](../plans/2026-09-05-ios-native-app-refactor.md) 保留未完成任务。
[结构化结果](./2026-09-06-ios-native-p0-p1-results.json) 逐条记录全部 41 个 required case。

## 已落地范围

新增 [packages/app-ios](../../packages/app-ios/README.md)，包含独立 Swift package、Xcode host、
shared scheme、Debug/Profile/Release、doctor/build/run、21 行带源码哈希的功能映射。
Bundle ID 为 `com.runweave.app.native`；旧 `com.runweave.app` 保留。
当前 Release 仅显示原生首页占位，不包含 TerminalProbe；还不能替换旧客户端。

原生验证链路已实现：独立 Keychain → 登录/刷新 → WS ticket → connected/snapshot/output →
SwiftTerm 1.19.0；raw 输入走 WS，验证输入与 tmux_exit_copy_mode 走既有 HTTP input API。
Controller 持有自己的连接、generation 和最多 1 MiB 输出队列；停止客户端不删除远端 session，
结果不明的输入不自动重发。恢复、协议异常和长期性能的完整行为仍需后续门禁。

没有修改旧 App、Backend、Electron 的 tracked 源码。已有的
`electron/src/terminal-browser-proxy-preferences.ts` 未纳入本次修改。
`pnpm-lock.yaml` 只增加新 workspace importer。没有新增单元测试、提交或推送。

## 构建与运行环境

- Xcode 26.6 / 17F113，iPhoneSimulator SDK 26.5，实际模拟器运行 iOS 26.2。
- SwiftTerm 1.19.0，固定 commit `464df5207fc2432e16c9a23abe538187196daf5f`。
- 选用已安装 simulator；没有更改系统 Xcode、安装新 iOS runtime 或提高 iOS 15 deployment target。
  编译依赖缺失时安装了 Apple 官方 MetalToolchain 组件。已检查 SwiftTerm 构建插件，
  使用 Xcode 正常 Trust & Enable，没有跳过插件校验。
- 新 App 最终 Debug/Profile/Release 模拟器构建均成功。Release 符号检查未发现 Probe/故障注入类。
  最终真机 Profile 签名构建也成功；构建成功不代表在真机运行。
- 旧 App production Web build、Capacitor sync、原始 Xcode 工程 Debug build 与模拟器启动成功。
  新旧 Bundle 在同一模拟器并存，旧 App 原有空连接列表保持不变。

原始日志位于仓库根 `.runweave/ios-native-evidence/`，产物位于 `.runweave/ios-native-build/`，
按计划均被 Git 忽略。结构化结论留在本记录；在其他 checkout 复核原始证据需保留或导出该目录。
诊断事件不含 token、用户输入或真实终端输出；固定公开 Unicode fixture 允许导出字符单元。

## 必需用例结果

执行模式：独立执行 YAML，按文件内编号顺序核对。三个文件共 41 例，格式校验通过只代表合同有效。
最终 mapping、docs、Swift 格式、Node 语法、plist 和 diff 检查均通过；architecture 旧债门禁通过，
该 TS/JS 检查不覆盖 Swift 运行行为。

| Case                | 结果               | 实际证据                                                                                                                                             |
| ------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| IOSTERM-001         | pass               | 新旧安装/启动及连接列表对照；独立 Bundle ID；新旧构建日志                                                                                            |
| IOSTERM-002         | pass               | 原生 ticket/WS → tmux 真实输出，红色 marker、Vim 进入/退出、唯一输入执行一次                                                                         |
| IOSTERM-003         | pass（修复后）     | 原生 resize 与外层 PTY：竖屏 46×33、键盘 46×14、横屏键盘 86×8、横屏收起 86×16，恢复 46×33；全部正数，无同 generation 连续相同尺寸请求；长行/TUI 恢复 |
| IOSTERM-004         | pass，有已记录差异 | 同一 59 字节流逐字节重放，46×31，中文/组合字符/ANSI 正确，零基光标 (0,4)；真实 Playwright xterm 对照；tmux 宽度实测支持原生结果                      |
| IOSTERM-005         | blocked            | 真机需要密码解锁；专用 Backend 只监听 localhost，尚无手机可达测试地址。不能用模拟器替代真机手势验收                                                  |
| IOSTERM-006～014    | not_run            | 未越过 G1；包含超过 64K 的恢复、锁屏、进程重启、Metal/性能、共享生命周期、协议扩展、iOS 15、普通 PTY                                                 |
| IOSSESSION-001～015 | not_run            | P2 尚未开始                                                                                                                                          |
| IOSFEATURE-001～012 | not_run            | P3/P4 尚未开始                                                                                                                                       |

总计：4 pass、1 blocked、36 not_run。没有将未执行项改为 pass，也没有放宽性能阈值。
IOSTERM-013 另有已知环境缺口：本机没有可运行的 iOS 15 destination。

补充验证不替代 required case：

- 最新 Debug 在冷启动后凭独立 Keychain 连接专用会话，无需再次输入密码。
- 最新 HTTP 验证输入输出 5100 行，marker 文件仅一条。通过独立 tmux 命令令该 fixture
  进入 copy mode，再点击原生“回到底部”：`pane_in_mode` 从 1 变为 0，画面回到 5100。
  后续 marker 仍仅执行一次。事件记录为 line、tmux_exit_copy_mode、line 三次 input.accepted。
  这未覆盖真机触摸滚动、不抢底、完整 Composer 交互，所以 IOSTERM-005 仍为 blocked。
- CoreGraphics/Metal/故障回退在模拟器有早期冒烟记录；没有真机性能结论。

## 发现和修复

1. 原计划禁用模拟器签名可以构建，却使 Keychain 返回 -34018。改用 ad hoc 签名及
   simulator-only entitlement，实际登录、存储和冷启动复用成功。真机仍使用正常签名；
   个人 Team 不写入工程。依据见 [Apple Keychain entitlement 说明](https://developer.apple.com/documentation/security/errsecmissingentitlement)。
2. 横屏键盘展开时，内部诊断和输入行曾把终端压到零高度。compact 布局隐藏辅助行，
   实测终端恢复为 86×8。补独立“收起键盘”按钮，通过当前窗口 endEditing 同时支持
   SwiftTerm 和 SwiftUI 输入框；最新构建已补验。
3. `👩‍💻` 在 SwiftTerm 是一个 2 列单元，旧 xterm 6 + Unicode 11 是两个共 4 列单元。
   同一第一行在 tmux 3.6a 的光标为 (9,0)，与 SwiftTerm 一致；不能据此推断所有旧 tmux
   和所有 CLI 均兼容。两端最终 (0,4) 来自 fixture 的显式光标定位，不用它掩盖 emoji 宽度差异。
4. 早期 resize 事件的 pixelWidth/pixelHeight 实际记录 UIKit points。已改为
   widthPoints/heightPoints/displayScale；旧证据保留原字段并在此注明。
5. tmux 内 shell 的 `stty size` 比外层 attach PTY 少一行，因为状态栏占一行。
   resize 比较对象是 WS 和外层 PTY；另记录 pane 尺寸，不能误判为一行 resize 丢失。

## 环境生命周期与后续

本次专用环境为 Dev Session `dvs-4b4424`，source root 是本 worktree，profile electron，
Backend/App Server/Electron 为 dedicated。旧 xterm 比较通过 resolver 返回的 desktop CDP 9225，
Playwright session 为 `dvs-4b4424-desktop`；没有附着 ambient 或其他 worktree 的页面。

两次早期启动失败分别来自 Electron SQLite staging 和首次 Electron 下载输出混入可执行路径。
前者通过仓库既有准备脚本修复；后者下载完成后新 Session 可启动。失败 Session `dvs-430edc`
的 stop 和明确提示的 cleanup-stale 均因 service identity drift 被工具拒绝；没有删除 manifest/锁或猜测 PID 清理。
收尾：`dvs-4b4424` 已 stopped，4 个专用终端已删除，Playwright 已 detach，临时认证文件已移除。
`dvs-430edc` 失败 manifest 仍残留，须单独修复 Dev Session 恢复流程。

继续实施首先需要可交互的解锁真机与手机可达的专用测试 Backend，然后完整执行 IOSTERM-005；
随后验证恢复、Metal/性能和生命周期门禁。P1 通过后再迁移连接管理、Home、Composer 和预览等业务。
当前没有证据要求放弃 SwiftTerm，也没有证据允许宣布全原生终端方案已完全成立。
