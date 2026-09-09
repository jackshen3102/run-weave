# iOS 技术决策

## 依赖、渲染与签名

- SwiftTerm 固定 1.19.0，使用上游源码和正常插件信任流程，不在构建时补丁依赖。
- 默认 CoreGraphics；Metal 仅在内部实验室显式启用和验证。UIKit 与 parser 在 MainActor，渲染层不拥有认证或网络连接。
- App 使用 `com.runweave.app.native`；保持 Keychain group 与 UserDefaults key，目录或文档整理不得触发安装数据迁移。
- 模拟器使用 ad hoc 签名及 simulator-only entitlement；真机由本机配置正常签名，不提交个人 Team。
- 显示尺寸明确区分 UIKit points 与物理像素。消费字节数、snapshot 接收、UIKit transaction commit 均不能直接当作屏幕呈现时刻。
- tmux 模式下 renderer 自动设备响应不走 pane 输入；用户键盘与快捷键正常发送，普通 PTY 保留设备查询响应。

## 认证与输入

- ConnectionStore 只存连接信息；APIClient 按连接 ID 与规范化 endpoint 隔离安全凭据。
- 查询和 ticket 的 401 可刷新后重试一次；业务写请求不自动补发。网络、403、5xx 不直接清空凭据。
- 隧道入口的 `Tunnel token required` 与 App 登录失效分别处理，不因此刷新或删除 App token。
- 仅在操作 ID、终端 ID 与输入接受字段均匹配后清空未被继续编辑的草稿。输入接受不等于 Agent 完成。
- 草稿属于 AppSession 的连接与终端内存状态；认证过期可保留，主动退出、切连接或删除终端会清理，进程终止不保证保留。
- 命令输入关闭智能引号、破折号和自动纠错，避免改变 shell 原文。离线输入不排队，也不在恢复后补发。

## 媒体、预览与诊断

- PHPicker 选择单张图片，上传结果经过 shell quoting 后只追加草稿。录音生成 24 kHz、单声道、16-bit PCM WAV；取消、切离、后台与音频中断会停止并清理临时文件。
- 媒体的可恢复业务错误由媒体区域展示；认证和网络状态转换仍由 AppSession 处理。
- Files/Changes 只读。目录和搜索按项目隔离，相对越界及越界符号链接由后端拒绝；后端允许显式绝对路径的只读预览，因此 projectId 不是所有文件预览的沙箱承诺。
- SVG 使用非持久 WKWebView，关闭 JavaScript、禁止网络与导航，不带认证或终端 bridge。
- Diff 的 800 总行数 / 180,000 行数乘积预算限制计算成本，大输入降级为删除/新增并在后台计算。
- 预览缓存属于不可变 endpoint 的 APIClient：15 秒 fresh、30 分钟闲置回收、32 MiB LRU；登录、清凭据和切连接使旧请求失效，迟到结果不能回填。
- 终端页的变更徽标、Changes 列表和 Files 状态共用当前连接代次、终端与项目下的摘要。进入终端、恢复前台、电脑恢复在线或终端 socket 连接成功时按上述缓存新鲜度读取；保留进入 Changes/Files 和手动刷新，不定时轮询。
- 变更数量沿用 Staged 加 Working 的条目数；首次未知时隐藏数字，成功读取空列表才显示 0。自动更新保留旧列表、筛选与已打开的 Diff，失败仅在变更区域提示；认证与网络状态仍交由 AppSession 处理。并发刷新合并，离开终端或不可读取时取消当前摘要任务。
- 日常诊断仅保存白名单路径、状态、耗时、operationId 和计量，不保存命令、token 或文件正文。App Support 串行原子写入，2,000 条 / 2 MiB 上限；异常时内存降级并保留损坏原文件。
- 诊断写入最多合并 250 ms，后台、释放或导出时 flush；突然结束进程仍可能丢失最后一批，不作为零丢失审计。

验收结论及尚未关闭的问题只维护在 [验收状态](validation-status.md)，不在技术决策中复制阶段报告。
