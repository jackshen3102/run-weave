# iOS 原生重构 P2 阶段记录

日期：2026-09-06。基线 `26a3d821d1206d389518859bf82650b55648cd7a`。
用户已手动验证上一阶段并授权继续 1 比 1 业务迁移；此记录不改写
[P0/P1 历史结果](./2026-09-06-ios-native-p0-p1-execution.md)。
本阶段仍在执行，尚未完成全部业务迁移或 P2 的完整验收。

## 实现和待决策

当前实现范围及运行命令见 [候选客户端入口](../../packages/app-ios/README.md)。
[映射文件](../../packages/app-ios/docs/legacy-map.json) 的 MAP-02～08 更新为 implemented，
无新增 verified；其余未完成范围继续保留 planned。

源码对照确认：旧 `use-app-terminal-actions.ts` 的发送命令 401 分支调用认证失效回调后正常返回，
`composer.tsx` 随即清空草稿，无法据此确认命令已经被接受。
已询问用户是否采用“认证失败或结果不明时保留草稿，仅明确接受后清空，不自动补发”；
等待决定期间暂停完整 Composer 的迁移，继续独立的登录、首页和构建工作。
旧 App 源码没有修改。

## 真实冒烟证据

这是定向冒烟，不是按 YAML 顺序完成所有 required case。
没有把下述局部步骤换算成 IOSSESSION-001～015 全例 pass。

专用环境为 Dev Session `dvs-907ffc`，本 worktree、electron profile，Backend/App Server/Electron
均为 dedicated。模拟器 `C0C57398-F27A-4462-83D9-4889BEA4F401`，iOS 26.2。
候选 Bundle ID 为 `com.runweave.app.native`，连接到该专用 Backend `http://127.0.0.1:5005`。
测试使用任务专用账号，无需读取用户真实密码。

已通过原生 UI 实际执行：

- 添加 Native P2 Fixture 连接；健康检测显示 Online 与 8 ms。
- 登录后显示 Default Project 首页。
- 终止并冷启动候选进程，直接恢复已登录首页，无需重新输入密码。
- 首页点击创建终端，自动打开原生终端并显示已连接与真实 zsh 提示符。
  Backend overview 读取确认创建了 `b3be118d`；再次冷启动后首页仍显示这条远端会话。
- 清理远端测试会话后，不操作原生首页，列表自动移除终端并将数量从 1 更新为 0；
  这是正常删除事件同步的冒烟证据，不覆盖 gap/乱序/重连场景。
- 最终 Release 冷启动恢复登录态并显示首页，没有内部终端验证标签。
- 检查候选 UserDefaults 的连接数据，不含 accessToken、refreshToken 或测试密码；
  Keychain 持久化由实现及真实冷启动复用共同支撑，但未覆盖全部隔离/删除场景。

证据保存在 Git 忽略的 `.runweave/ios-native-evidence/`：
`p2/home-after-login.png`、`p2/created-terminal.png`、
`p2/overview-after-native-create.json`、`p2/storage-inspection.json`、
`p2/home-after-remote-delete.png`、`p2/release-home.png`。
原始证据仅在当前 checkout，异地复核需保留或导出该目录。

## 未完成的验收

- 原生自动化工具的坐标点击返回 `Computer Use server error -10005: noWindowsAvailable`；
  AX 元素点击仍可用，但部分 SwiftUI 导航栏控件未出现在 AX 树。
  新增项目、删除确认/取消、完整连接编辑/切换流程未取得 UI 证据。
- 旧 Ionic production bundle 已通过 resolver 返回的 task-owned desktop CDP 加载。
  Login 输入框填入 fixture 账号后按钮仍 disabled；未注入认证状态或强制启用按钮，
  新旧首页的同期 UI 对照未完成，见 `p2/legacy-login-blocked.txt`。
- 尚未实测并发 401/刷新单飞、403/5xx/超时、切换连接中的晚到响应、gap/streamId 恢复、
  真机前后台与最低 iOS 15；代码审阅和编译不代替这些用例。
- 完整 Composer、快捷键/手势、历史、图片/录音、Files/Changes/预览、诊断与主题仍待迁移。

## 构建、静态检查与清理

最终 Debug/Profile/Release 模拟器构建均成功；最终 Release 已安装并启动。
Release 主二进制的 TerminalProbe 符号数量为 0。
21 条源码映射、docs:check、Swift 格式、Node 脚本语法、git diff --check 均通过；
session YAML 格式校验通过（15 required case），不代表执行通过。
构建日志为 `p2-{debug,profile,release}-build.log`，最终 Swift 源码指纹与符号检查结果在
`p2/final-candidate.json`。认证、创建、冷启动等冒烟发生在本阶段修订过程中；
最后的候选代码另有 Release 冷启动/首页证据，未重新执行全部早期步骤。

任务测试终端 `b3be118d` 已通过 Backend DELETE 返回 204 删除，随后 overview 的 sessions 为空，
见 `p2/fixture-cleanup.json`；临时认证文件已删除，Playwright 已 detach。
`dev:stop --session dvs-907ffc --json` 返回 state=stopped，见 `p2-dev-stop.json`。
服务停止后的补充原生 UI 读取返回 `cgWindowNotFound`，未取得离线横幅的最终截图证据。
候选 App 保留 Native P2 Fixture 本地连接方便查看；专用 Backend 停止后该地址不再可用。
没有新增单元测试、Git 提交或推送。
不修改已有无关的 `electron/src/terminal-browser-proxy-preferences.ts`。

## 后续：401 认证链路核查与 Composer 决策落实

用户已批准失败保留草稿，之前的待决策暂停解除。文本 Composer 已接入统一 APIClient，
认证不可恢复时由 AppSession 处理登录状态；Controller 不再吞掉发送失败。
草稿存放在当前连接的 AppSession，认证过期导致页面关闭后，重新登录并打开同一终端可取回；
只在 Backend 明确接受且草稿未被继续修改时清空。此为代码行为，尚未取得完整原生 UI 故障验收。

旧端 `sendTerminalInput` 确实带 Authorization Bearer；缺口是终端发送的 401 分支不走
首页使用的 refreshStoredSession，而直接 resetSession 并正常 return，Composer 随即清空。
Backend 默认 access token 有效期 24 小时、refresh token 30 天，可通过环境变量覆盖。

真实独立 HTTP 实验：Dev Session `dvs-ccbf3f`，本 worktree，electron profile，Backend 为 dedicated，
任务配置 access token TTL 为 2 秒，不改变现有用户服务。未创建终端或发送可执行命令，
input 目标使用不存在的 fixture ID。

| 场景                                        | HTTP                            |
| ------------------------------------------- | ------------------------------- |
| 无凭据访问 overview                         | 401                             |
| 登录、有效 Token 访问 overview              | 200、200                        |
| 等待过期后请求 input                        | 401                             |
| 有效 Refresh Token 刷新、重新访问 overview  | 200、200                        |
| 新 Token 访问不存在终端的 input             | 404（已通过认证并到达资源查询） |
| 注销 fixture、使用已撤销 Refresh Token 刷新 | 204、401                        |

证据 `.runweave/ios-native-evidence/auth-http-results.json` 不含 Token。
这说明正常登录后仍可能因过期收到 401，并验证本地直连 Backend 的刷新协议正常；
不代表 Swift 并发刷新或实际用户远程接入已经通过完整验收。
另查到入口隧道认证可返回 401 + `Tunnel token required`，APIClient 已单独分类，
避免错误提示密码不对或清理 App 登录态；该分支本轮仅做源码与构建验证。

本次认证跟进的最终 Debug/Release 模拟器构建、Swift 格式、21 条映射及 docs:check、
git diff --check 均通过；日志为 `auth-{debug,release}-build.log`，源码指纹见 `auth-candidate.json`。
Profile 未重跑，最新 Composer 尚未安装并执行原生 UI 故障场景；不以 Backend HTTP 实验替代该验收。
fixture 登录已注销，`dev:stop --session dvs-ccbf3f --json` 返回 stopped，见 `auth-dev-stop.json`。
没有修改旧 App 或 Backend 源码，没有新增单元测试或提交代码。
