# 原生 iOS 实现收尾与验收阻塞（2026-09-06）

本轮按用户确认补齐剩余实现，再推进非真机验收。旧 `app/`、Backend、Electron 源码未修改；
候选仍是独立 `packages/app-ios` / `com.runweave.app.native`，没有替换正式 App。

## 范围纠正

此前把“终端输出图片点击打开”列为旧端迁移缺口有误。检查旧 `panels.tsx`、
`TerminalRenderer.tsx` 与 onTerminalReady 链路，实际只有触摸扩展，没有图片 addon / 打开能力。
旧图片功能来自 Files/Changes 的 ZoomableImage / ImageLightbox。
已向用户说明，并按推荐的 1:1 范围推进；没有额外新增终端图片解析或远程资源加载。
MAP-16 的来源列表已缩小到真实图片预览实现，保留已核对的旧源码哈希。

## 新增实现

| 范围       | 落地行为                                                                                                                       | 主要入口                                                    |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| 终端手势   | 单指纵向拖动、3 倍滚动系数、左侧 24 pt 避让；普通缓冲本地滚动，tmux alternate screen 使用 SGR 滚轮；有选区时让原生选择控件接管 | `TerminalGestures.swift`、`SwiftTermSurface.swift`          |
| 回到底部   | 根据本地位置和 tmux 滚动距离展示入口，明确接受 exit-copy-mode 后才更新状态，不自动重复发送                                     | `SessionController.swift`、`TerminalScreen.swift`           |
| 预览缓存   | 15 秒有效期、30 分钟闲置回收、32 MiB LRU 上限；相同请求合并，强制刷新取消旧请求；连接/登录/凭据生命周期清理                    | `ScopedCache.swift`、`PreviewService.swift`                 |
| 缓存 UI    | 文件列表/搜索/Changes 可先显示已有缓存，再更新；下拉刷新绕过缓存                                                               | `FilesView.swift`、`ChangesView.swift`、`FilePreview.swift` |
| 诊断持久化 | 独立 App Support，有界串行写入，2,000 条 / 2 MiB，按连接导出/清空，损坏文件保留并报告降级                                      | `DiagnosticStore.swift`、`DiagnosticsView.swift`            |
| 已看标记   | Diff 成功加载后再标已看，失败不标记                                                                                            | `ChangesView.swift`、`FilePreview.swift`                    |

路径及合同见 [映射](../../packages/app-ios/docs/legacy-map.json)。21 项状态为 implemented，
没有任何一项标为 verified。实现状态不代表测试通过。

## 已执行检查

- Simulator destination：iPhone 16 Pro / iOS 26.2，UDID `C0C57398-F27A-4462-83D9-4889BEA4F401`。
- Debug、Profile、Release 均构建成功；Swift 严格格式检查通过。
- 二进制符号核验：Profile 保留 TerminalProbe，Release 排除 Probe；Profile/Release 都排除认证故障注入方法。
- 旧 App 的 Vite build 成功。仅用于准备对照，不视为旧端 UI 通过。
- 三份原生 YAML 格式校验通过（14 + 15 + 12 条 required）。本轮未取得完整原生用例通过证据。
- 证据根目录：`.runweave/ios-native-evidence/`，源码/二进制指纹为 `p5/candidate.json`，
  编译日志为 `p5-debug-build.log`、`p5-profile-build.log`、`p5-release-build.log`。

## 实际环境与阻塞

第一轮专用 Session 为 `dvs-ba7705`，30 秒测试 Token 有效期。Desktop 正常登录后立即触发刷新，
refresh 返回 401 并回到登录页。该故障配置影响准备对照环境，未据此宣布正式登录缺陷。
清理该轮项目、API 登录并停止 Session 后，以默认 86,400 秒有效期新建 `dvs-eaff1d`。
第二轮通过 Playwright 在专用 Desktop 实际完成连接添加、登录、选择测试项目、创建终端。

旧 App 对照继续遇到明确环境错误：Browser 1 显示
`Error invoking remote method 'terminal-browser:resolve-profile': Error: Whistle runtime entrypoint is missing`。
终端浏览器 CDP 最初附着也报告 `No terminal browser target available`。未附着无关浏览器或更改全局代理绕过。
已运行仓库固定的 playwright cli，证据为 `p5/desktop-browser-blocker.txt`；这不是旧移动 App 页面通过证据。

原生端：候选 App 已安装/启动，simctl 确认设备 Booted、候选进程存在，但 CUA 获取 Simulator
窗口返回 `noWindowsAvailable`，重置会话后为 `timeoutReached`。未能进行原生登录、触摸、
缓存请求计数或重启后导出等动作。已异步请用户恢复可操作的模拟器窗口，未收到恢复证据。
不能用进程存活、构建成功、代码阅读或准备好的代理当作原生运行验收。

手工故障代理仅监听本次分配的 loopback 端口，控制文件及请求计量位于 `p5/`；
未更改系统网络或全局代理，不记录 Token、Authorization 内容、请求正文或 WS ticket。
由于原生 UI 阻塞，没有声称它已覆盖 native 403/503、断网或迟到响应行为。

## 恢复后优先验收

1. 原生登录与进程重启，确认独立 Keychain 和已落盘日志可读。
2. 缓存命中/15 秒更新、手动刷新、相同 ID 跨连接隔离和迟到响应丢弃。
3. 普通历史/tmux alternate screen 滚动、文字选择、回到底部与 marker 输入。
4. 已有 Stop、历史复制、文件错误、图片预览及诊断导出/清空的完整操作。
5. 专用协议环境的 403/503、断网恢复、事件去重与 Backend 重启；之后补完整新旧 UI 对照。

真机和最低 iOS 版本等历史门禁仍保持原状态，未用本轮结果覆盖。

## 收尾

- 21 条源码映射、Swift 严格格式、docs:check 和 git diff --check 通过。
- `dvs-ba7705`、`dvs-eaff1d` 均已停止；已从 Playwright detach，手工故障代理与旧 App Vite 服务已停止。
- 两轮创建的测试项目及所属终端已删除，API fixture 登录已注销，私有 Token 文件已移除。
- 模拟器只移除本轮测试连接，保留原配置和选择；最新 Debug 候选已安装并启动。
- 清理证据：`p5/cleanup.json`、`p5-dev-stop-first.json`、`p5-dev-stop-normal.json`。
  本轮未执行的原生和旧移动 App UI 验收需要在控制环境恢复后继续，不能作为已完成事项。
