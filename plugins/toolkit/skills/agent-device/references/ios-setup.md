# iOS 准备与恢复

## 工具与签名

验证基线：agent-device 0.21.3、Node 22.12+、macOS/Xcode。先用已安装 CLI 的 `help physical-device` 和 `help <command>` 核对行为。需要安装时使用 `npm install -g agent-device@0.21.3`；若本机 npm 是内部镜像 shim，检查 `command -v npm` 后可直接调用当前 Node 安装的 `npm-cli.js` 并指定官方 registry，不修改全局 registry。

真机需要信任配对、Developer Mode、可用签名、设备连接与必要的解锁。`DevToolsSecurity -status` 为 disabled 时，按当前任务已有授权处理；启用需要管理员权限，系统密码由用户在系统界面输入。不能把全部连接超时都归因于锁屏或 UI Automation 提示。

从当前工程/有效 provisioning profile 确认 Team ID，**证书名称括号里的 ID 不一定是 provisioning 的 Team ID**。使用独立 runner Bundle ID，基础 App 与 `<id>.uitests.xctrunner` 都需要可用签名；不要改变产品 App 的 Bundle ID 或重签成新安装。

若 CLI `xcodebuild` 报 `No Accounts`，先检查 Xcode Apple Accounts，不能直接断言用户未登录。GUI 已登录而新描述文件缺失时，可复制上游包内 `dist/apple` 到本机任务目录（保留相对 Swift package 路径），仅修改副本的 Team 与基础 Bundle ID，用 Xcode Signing & Capabilities 自动签名，并在指定真机上 Build For Testing。成功后再回到原 CLI 验证；不要修改已安装上游源码。个人签名值只放本机任务配置。

免费开发者签名可能因设备已有 App 数量达到上限而拒绝安装。先列出冲突 App；若要替换旧测试 runner，确认它空闲、找到可恢复安装包并验证签名，依据用户授权再卸载。不能卸载 Runweave/随记来绕过限制，也不能用另一个工具的 Bundle ID 静默覆盖旧 runner。

预检未检查 provisioning 配额/有效期、UI Automation 授权和全部占用者；首次真实 open/快照是必要验证。`check` 输出的 `automationReady: false` 表示尚未在这一预检中证明 UI 可操作，不表示操作必然失败。

## 恢复边界

| 证据                                   | 下一步                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------ |
| devicectl unavailable、网络查找设备    | 重新确认线缆或同一网络、设备解锁，不新建同名模拟器冒充真机               |
| 原生 Mac 窗口工具找不到窗口            | 检查 Mac 是否锁屏，不能混同 iPhone 离线                                  |
| 系统明确提示输入密码启用 UI Automation | 用户在手机完成，保留正在启动的 runner 并等待；没有提示证据时先看日志     |
| open exit 0，但初始 snapshot 失败      | 当前不能算 UI 连接成功；检查任务 state/sessions 下 runner.log 的本次末尾 |
| 点击失败或 settle 超时                 | 先观察动作是否生效；不得自动重试写动作                                   |
| 精简树漏控件                           | 完整 JSON、截图；坐标回退必须基于当前边界并验证后置状态                  |
| 快照显示目标 App，但截图是其他 App     | 以真实前台截图为准，按任务需要返回目标 App                               |
| 回放身份不匹配                         | 留存错误、重读结构或重新录制；不删除元数据强行通过                       |

0.21.3 的本地实测曾出现精简树遗漏、卡片中心误触链接、动作发生后 XCTest 报错、录制祖先层级不匹配。它们是需要识别的失败模式，不是每次启动都必须执行的检查清单，也不能据此自动修改产品代码。
