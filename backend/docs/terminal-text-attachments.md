# Terminal 文本附件

Terminal 附件由所属 Backend 保存。身份鉴权沿用 Terminal router，所有附件、操作回执和
内容访问都绑定 session；客户端只提交 ID，不指定文件路径。共享合同入口为
[`text-attachments.ts`](../../packages/shared/src/terminal/runtime/text-attachments.ts)。

## 能力边界

长文本附件适用于当前运行的 tmux 面板，不按 Agent 类型、空闲状态、thread、
Codex 启动参数、操作系统或客户端地址关闭功能。普通 shell 和首次启动、尚未建立
thread 的 Agent 也可以保存和插入文件。沿用终端的登录鉴权，不另加附件权限门槛，
不修改 Agent 的沙箱或审批配置。

文件保存在终端所属 Backend；远程客户端通过同一接口使用附件。路径由 Backend
插入到指定面板，不能据此宣称 SSH 或容器内也能直接访问主机文件。
文件创建成功不代表 TUI 已接收，投递成功也不代表 Agent 已读取。

## 保存与保留

实例数据目录下的 `terminal-text-attachments/<sessionId>/<UUID>/pasted-text.txt` 保存完整
UTF-8 原文，目录 0700、文件 0600。使用原子写入及同步；拒绝路径穿越和符号链接。
metadata version 1 只包含归属、长度、哈希、时间和操作结果，不包含正文。附件正文不进入
快捷输入历史、诊断日志或分析事件。

限制为 5000 UTF-16 单元触发、每份 1 MiB UTF-8、每 session 100 MiB。超限拒绝创建，
不会截断正文或删除已引用文件来腾空间。

未引用 draft 从最后续期起保留 7 天，可由客户端移除；投递前先持久化 referenced。
accepted、排队、未知结果的文件都受保护，关闭提示、session 退出或 Backend 重启不删除。
session 明确删除后再保留 7 天。损坏或归属不明 metadata 跳过清理。
已知临时文件超过 24 小时清理；清理 timer 由 runtime owner 停止并等待。
具体实现见 [`text-attachment-service.ts`](../src/terminal/attachments/text-attachment-service.ts)。

## 投递与恢复

TUI 创建在任何异步工作前固定 panel 与输入 revision。保存期间不锁终端；继续
输入、目标切换或其他客户端输入使旧资格失效。插入在同步复核后取得短时 session 独占权，
退出 copy mode 后再次检查显式 pane，粘贴 `空格 + JSON 字符串路径 + 空格`，不发送
Ctrl-U 或 Enter。独占期间的正常 HTTP / WS 输入固定原目标并按序等待。

浮动提交携带 `textAttachmentIds`，Backend 按 ID 顺序校验归属及文件可读，追加路径说明，
在写入之前保护文件。无附件输入保持旧合同。发送和 Tab 排队使用同一保护入口。

session + operationId + 同一 payload 复用持久化结果；改变 payload 返回 409。
投递先写 dispatching，确认完成后 accepted。重启将残留 dispatching 转为 unknown；
只读查询回执，不自动重放。PTY 与磁盘没有跨进程事务，不承诺 exactly-once。

HTTP 路由见 [`text-attachment.ts`](../src/routes/terminal/input/text-attachment.ts)。400 表示
无效参数，409 表示资格/输入冲突，410 表示附件失效，413 表示大小超限，507 表示磁盘不足。
升级或回滚时保留这个数据目录；旧版本停止创建新附件，但不能删除已有 TUI 引用文件。

真实验收入口：
[`text-attachments.testplan.yaml`](../../docs/testing/terminal/runtime/text-attachments.testplan.yaml)。
格式校验与构建通过不能替代其中的行为验收。
