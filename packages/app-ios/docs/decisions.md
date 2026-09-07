# 原生 iOS 技术决策

当前已进入 P3/P4 业务迁移。用户手动验证通过并授权推进；历史门禁结果与新增代码的验收分别记录。

- 独立包与宿主使用 `com.runweave.app.native`；旧 `app/` 保留运行与排障对照。
- SwiftTerm 1.19.0 固定提交 `464df5207fc2432e16c9a23abe538187196daf5f`。
  使用上游包，不复制或修改依赖源码；最低部署版本维持 iOS 15。
- 默认 CoreGraphics；Metal 仅通过内部入口显式初始化。性能选择需要真机证据。
- SwiftTermBuildInfoPlugin 及其 generator 已检查：读取自身 Git 信息，在构建目录生成版本常量。
  首次使用通过 Xcode 的正常 Trust & Enable 流程，不加入跳过插件校验的构建参数。
- UIKit 和 SwiftTerm parser 在 MainActor；渲染层不拥有 token、socket 或远端会话。
- 当前内部固定流把 UTF-8 和 ANSI 逐字节分割，用于检查 parser 跨 feed 状态。
  消费字节计数不是实际显示延迟，不把它用于性能门禁结论。

- 模拟器也需要 Keychain entitlement。无签名构建实测 SecItemAdd 返回 -34018；因此采用
  ad hoc 签名和仅 simulator 生效的 `local.com.runweave.app.native` entitlement。真机使用
  正常签名，不使用模拟器标识，不扩大或复用旧 App 的 Keychain group。
- 视口日志用 points + displayScale 表达 UIKit 尺寸。早期事件的 pixelWidth/pixelHeight
  实际是 points，历史证据已注明，不能把它当物理像素性能基线。
- 横屏键盘展开时隐藏内部计量和辅助输入行，为终端保留有效高度；收起键盘只结束当前窗口编辑。
- Unicode fixture 中 `👩‍💻` 在 SwiftTerm 占 2 列，在旧 xterm 6 + Unicode 11 占 4 列。
  专用 tmux 3.6a 实测采用 2 列，原生与该 Backend 一致。这不证明所有 tmux/CLI 版本均一致。
- 当前 CoreGraphics 默认仅用于验证，不代表已通过真机性能预算。256 KiB/s、p95、十分钟
  内存和 iOS 15 运行支持都没有实测结论。

[P0/P1 执行记录](../../../docs/review/2026-09-06-ios-native-p0-p1-execution.md) 是本次验证结果入口。
2026-09-06 用户手动验证通过，并明确授权继续业务 1 比 1 迁移；以该推进决定覆盖原来的实现顺序阻断。未执行用例仍不标为 pass，旧 `app/` 继续作为可运行对照。

## 业务迁移边界

- 1 比 1 对齐旧端功能、协议和用户行为，界面采用 SwiftUI/UIKit。
- ConnectionStore 只持久化连接信息；凭据按连接 ID 与规范化 endpoint 存入独立 Keychain。
  切换连接会释放原连接请求/事件/终端视图，旧响应不得写回当前首页。
- 查询和 ticket 的 401 可刷新认证并重试一次；业务写请求不自动补发。网络、403、5xx
  不直接清空凭据；写操作未被明确接受时报告错误。
- 2026-09-06 用户批准修正旧 Composer 的 401 清空草稿问题：仅明确接受后清空，失败保留，
  不自动补发。草稿按当前连接和终端保存在 AppSession 内存中，认证过期关闭页面后仍保留；
  主动退出登录、切连接或删除该终端会清理相应草稿，进程终止不保证保留。
- Backend 另有入口隧道认证，401 + `Tunnel token required` 不等于 App 登录失效；
  原生 APIClient 单独分类，不刷新或清理 App Token。隧道接入配置与远程连通尚未实测。
- P2 阶段历史证据见 [P2 执行记录](../../../docs/review/2026-09-06-ios-native-p2-execution.md)。

## P3/P4 原生能力

- 命令编辑使用 UIKit UITextView，关闭智能引号/破折号和自动纠错；实际验证发现 SwiftUI TextEditor
  会把 shell ASCII 引号替换为弯引号。业务发送校验响应的 operationId、终端 ID 和接受/入队字段。
- 系统 [PHPicker](https://developer.apple.com/documentation/photosui/phpickerviewcontroller)
  提供单张图片选择；上传沿用 clipboard-image，结果正确 shell quoting 后只追加草稿。
- [AVAudioRecorder](https://developer.apple.com/documentation/avfaudio/avaudiorecorder)
  输出 24 kHz、单声道、16-bit PCM WAV；结束时检查实际采样率、声道与非空音频。
  取消、切离 Chat、进入后台和音频中断均停止录音并删除临时文件，不上传或发送。
- 文件浏览、Diff、轻量 Markdown 和图片缩放使用原生视图。SVG 采用局部 WKWebView：
  非持久存储、关闭 JavaScript、CSP 禁止网络，禁止导航，不附带 token 或终端桥接。
- Diff 与旧算法保持 800 总行数 / 180,000 行数乘积阈值，大输入降级为删除/新增；构建在后台任务。
- 诊断使用现有后端 start/stop 协议，HTTP 与终端白名单记录交由 DiagnosticStore 保存。
  仅导出 HTTP 路径、状态、耗时、operationId 和白名单终端计量，不保留命令、Token 或文件正文。
  持久化边界见下文，完整诊断等价性仍待验收。
- Debug 的 loopback 专用撤销登录按钮用于真实 401 验证；Profile/Release 不编入该按钮和方法。
  横屏隐藏该辅助行，媒体和快捷键共享一行；最终软件键盘展开后真实命令发送已成功。

新增证据与限制见 [P3/P4 执行记录](../../../docs/review/2026-09-06-ios-native-p3-p4-execution.md)。

## 实现收尾（2026-09-06）

- 纠正图片范围：旧 `app/src/components/terminal/panels.tsx` 只安装触摸扩展，
  `packages/terminal-renderer/src/TerminalRenderer.tsx` 没有图片 addon 或打开图片扩展。
  MAP-16 对应 Files/Changes 的现有图片预览，终端输出图片打开不是旧端迁移缺口。
- 原生手势处理单指纵向拖动和无障碍滚动。普通缓冲只改变本地 viewport；tmux 的 alternate
  screen 发送旧端同格式 SGR 滚轮，保留 3 倍拖动系数、中央坐标及左侧 24 pt 边缘避让。
  选区存在时让 SwiftTerm 接管拖动。回到底部仅在明确接受后更新状态，沿用不自动重发输入的决定。
- ScopedCache 只归属不可变 endpoint 的 APIClient。保留 15 秒 stale / 30 分钟闲置回收语义；
  同键请求共享结果，手动刷新取消旧请求并重新读取。登录、凭据清理、退出和切连接使旧请求失效，
  迟到结果不能回填。内容不落盘；缓存另加 32 MiB LRU 上限，超过上限的单次响应仍正常返回。
- DiagnosticStore 使用单个串行后台写入器，App Support 文件不参与备份，采用原子替换和首次解锁后
  的文件保护。全局上限 2,000 条 / 2 MiB，按 connectionID 隔离导出和清空；异常时最多
  300 条 / 256 KiB 内存降级。读取失败保留原文件，不以一个连接的清空操作删除其他连接数据。
  写入最多合并 250 ms；进入后台、释放连接或导出时 flush。突然杀进程可能丢失最后一个未提交批次，
  不宣称诊断日志具备事务审计或零丢失保证。
- Changes 仅在 Diff 成功加载后标记已看，避免把打开失败的文件标为已审阅。

最新构建与真实验收状态见 [实现收尾记录](../../../docs/review/2026-09-06-ios-native-completion-execution.md)。
