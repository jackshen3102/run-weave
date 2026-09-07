# 原生 iOS P3/P4 执行记录（2026-09-06）

本轮继续独立 `packages/app-ios` 的业务迁移。旧 `app/`、Backend 和 Electron 均未修改。
这是实现与定向冒烟记录，不是三份 YAML 全量通过报告；没有映射升级为 verified。

## 候选与环境

- 源码 worktree：`.worktree/agent-team-2`，基线 `26a3d821d1206d389518859bf82650b55648cd7a`。
- 独立 Bundle ID：`com.runweave.app.native`，SwiftTerm 1.19.0；最低部署声明仍为 iOS 15。
- 实测：Runweave Build iPhone / iPhone 16 Pro，iOS 26.2，UDID `C0C57398-F27A-4462-83D9-4889BEA4F401`。
- 本轮专用 Dev Session `dvs-7b826c`，planner 选择 Electron profile，Backend `http://127.0.0.1:5003`。
  状态与所有权证据在 `.runweave/ios-native-evidence/p3-final-dev-status.json`。
- 测试项目为忽略目录内的独立小 Git 仓库，通过 HTTP 创建项目、原生 Home 创建终端。
  原生连接配置由 CLI 准备，不把这一步作为连接管理 UI 通过证据。

## 新增实现

- Composer 使用 UITextView 关闭智能引号和自动纠错；业务输入和 Stop 校验接受响应及 operationId。
  快捷键走原有 WS，Stop 走 interrupt API，不根据 HTTP 接受响应伪造进程结束状态。
- Chat / Changes / Files、只读终端历史与复制、系统图片选择及上传、24 kHz WAV 录音与转写。
  媒体成功只追加草稿；取消、后台、中断和离开 Chat 会清理录音，业务写不自动重试。
- 原生文件列表/搜索、源码/轻量 Markdown、Git 分组和 Diff、图片缩放、隔离 SVG 预览。
  搜索/刷新结果通过任务取消和请求 ID 避免旧结果覆盖；Diff 沿用旧算法的降级阈值。
- 主题持久化与原生终端同步；诊断 start/stop、当前连接本地记录导出/清空、复制后端日志路径。
  本地诊断目前是有界内存记录，跨进程保留尚未实现。

具体源码与旧端映射以 [legacy-map.json](../../packages/app-ios/docs/legacy-map.json) 为准。

## 已执行的原生交互

以下均操作安装的 Debug 候选 App，使用 CUA 的原生 AX 控件；后端只负责 fixture 和结果取证。

| 定向检查         | 实际动作和结果                                                                                                    | 证据                                                       |
| ---------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 登录与创建终端   | 实际填写专用 Backend 凭据登录，从原生 Home 创建终端并显示 shell                                                   | 本轮 CUA 操作记录；`p3/terminal.json`                      |
| 正常发送         | 发送写入固定 marker 的命令，文件只有一行，接受后草稿清空                                                          | `p3/input-results.json`                                    |
| 真实认证失效     | Debug loopback 按钮只撤销本次原生远端登录，保留本地凭据；下一次 Send 触发 401 与刷新失败，回登录页；marker 不存在 | `p3/expired-login.png`、`p3/input-results.json`            |
| 重新登录不重发   | 再次原生登录并打开同一终端，原草稿完整保留，marker 仍不存在；手动 Send 后只产生一行并清空草稿                     | `p3/draft-after-login.png`、`p3/input-results.json`        |
| 最终接受字段     | 最终 operationId 校验实现下发送 `ACCEPTANCE_ID_OK`，终端回显且草稿清空                                            | `p3/history-final.json` 与 CUA 操作记录                    |
| Files 搜索和源码 | Files 的四项列表搜索 example，得到唯一 example.swift；点击后显示 fixture 源码；关闭仍保留搜索词                   | 本轮 CUA 操作记录                                          |
| Markdown         | README.md 显示原生标题 Native fixture 与 Edited line                                                              | 本轮 CUA 操作记录                                          |
| Changes / Diff   | 四项 Git 变更；README 第三行显示 Original line 删除、Edited line 新增，双侧行号正确；关闭后有已看标记             | `p3/diff-final.png` 与 CUA 操作记录                        |
| 横屏软件键盘     | 发现新增工具栏挤没终端，修复紧凑布局后重复操作；键盘展开时终端可见，发送 LANDSCAPE_OK 成功并清空草稿              | `p3/landscape-keyboard-final.png`、`p3/history-final.json` |
| 图片选择入口     | 点击原生图片按钮，系统 PHPicker 打开并显示照片网格；未完成选择/上传                                               | 本轮 CUA 操作记录，仅入口冒烟                              |

证据路径相对仓库根 `.runweave/ios-native-evidence/`，属于本机忽略产物。
`history-final.json` 仅保存本轮专用终端的固定无敏感输出，不包含认证令牌。

## 后端协议验证

另以专用 fixture 登录调用本轮拥有的终端 interrupt：operationId 回传一致，
inputAccepted、inputEnqueued、interruptAccepted 均为 true。
专用 Backend 的诊断 start 返回 recording，stop 确认收集到了固定客户端 fixture 记录。
证据为 `p3/protocol-results.json`。这不代替原生 Stop 或诊断界面验收。

## 仍未完成的门禁

- IOSFEATURE-001 的 Codex slash、多行、响应丢失；完整 Stop、快捷键、历史选择复制和媒体上传/转写。
- 项目隔离、文件错误、超大 Diff、图片缩放、主题切换及诊断导出/清空的完整 UI 对照。
- 完整 tmux 手势、终端输出图片打开、缓存等价性与跨进程诊断保存尚待迁移或对照。
- 这次只重跑了新增 Composer 的横屏键盘/发送冒烟，没有把 IOSTERM-003/004/005 全部标为通过。
- 当前 CUA AX 不暴露 iOS 导航栏菜单和 PHPicker 网格，坐标点击持续返回 noWindowsAvailable。
  因此部分界面动作无法取证；没有新增 XCTest、伪造 UI pass 或修改产品入口绕过。
- 未执行旧 Web App 的 Playwright 对照；未完成真机、iOS 15、性能与所有恢复门禁。
  P0/P1 历史结果保留在原记录，不能用本轮构建覆盖历史证据。

## 复测

在仓库根执行：

```bash
pnpm --filter @runweave/app-ios ios:run -- --simulator C0C57398-F27A-4462-83D9-4889BEA4F401
```

安装后选择自己可达的 Backend 并正常登录，重点复测 Stop、历史复制、图片、录音、
文件/Changes、主题和诊断。本轮专用 Backend 在收尾停止，不能继续使用它的 5003 地址。
正式验收仍执行三份 [原生测试计划](../testing/app/ios-native-features.testplan.yaml)。

## 最终检查与清理

- Debug、Profile、Release 的 simulator 构建全部成功；最新 Debug 已安装。
  日志为 `p3-debug-build.log`、`p3-profile-build.log`、`p3-release-build.log`。
- 二进制符号检查：Profile 有 TerminalProbe；Release 没有 TerminalProbe；
  Profile/Release 均无 revokeRemoteLoginForValidation。候选二进制及源码 SHA-256 在 `p3/candidate.json`。
- Swift 格式严格检查、21 项 mapping:check、ios:doctor、docs:check 通过。
  三份 YAML schema 校验通过（14 + 15 + 12 = 41 条 required），没有将 schema 校验当作运行验收。
- 本轮创建的终端、项目已分别 DELETE 204；fixture API 登录已 logout 204，私有 token 文件已删除。
  模拟器只移除本轮 fixture 连接，保留此前连接配置并恢复原选择。
- `dvs-7b826c` 已停止；其他 Session、旧 App 数据和无关 Electron 文件均保留。
  清理证据为 `p3/cleanup.json` 和 `p3-dev-stop.json`。
