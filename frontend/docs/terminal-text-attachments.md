# Terminal 长文本粘贴

Web 和 Electron renderer 共用这项能力。先通过所属 Backend 的 capability 确認当前
panel/thread 可用，且 apiBase 为 loopback 地址时拦截用户 DOM paste。
已确认空闲 Codex 的 panel/thread 在新 scope capability 查询期间也先保留长文本；
取得同一目标的肯定结果后才创建附件。等待期间目标、输入或 surface 生命周期改变则停止，
查询失败或拒绝时保留可复制原文，不异步回放正文。已知不支持的上下文仍走原生输入。首版只支持已实测
macOS Backend 的直接连接；远端、代理、旧 Backend 或未确认上下文保持原生输入。
Backend 的执行环境、投递与文件生命周期合同见
[`Terminal 文本附件`](../../backend/docs/terminal-text-attachments.md)。

## 两个入口

纯文本长度达到 5000 UTF-16 单元时创建 txt，保留 CRLF、空白、制表符和所有字符。
短文本、含图片或文件的剪贴板、程序化 Preview 注入继续走既有分支。
终端容器在 capture 阶段截断长文本事件，不向隐藏 textarea 重复发送正文。

浮动输入框保留已有草稿，按顺序显示附件；支持认证回读的纯文本预览、移除和按当前选区
恢复全文。仅附件可以发送；保存中、失败或结果未确认时禁止发送和排队。
请求提交附件 ID，客户端不拼路径。成功响应后只消费这一次提交的草稿；失败保留原文。

直接 TUI 粘贴不打开浮动输入框。独立提示显示保存中、已插入、未插入或结果未确认，支持
预览、复制原文和关闭。关闭只隐藏提示，不撤回路径或删除文件。继续输入、切换目标或
thread 变化会取消尚未发出的插入；响应归原 scope。服务端 accepted 后不再调用
`terminal.paste()` 或 WebSocket 重发。

发起 TUI 路径投递前就禁用浮动覆盖发送；pending、unknown、切走 scope 或关闭提示都不能
解除保护。TUI 光标镜像无法可靠合并附件路径，明确提示核对真实 TUI 后在其中提交。
原生 Enter 或 Ctrl-U 建立新的空草稿后恢复镜像。这个状态随目标隔离。

## 草稿与恢复边界

附件集合按 apiBase / session / panel 隔离，在同一页面生命周期中保留原文，包括终端
surface 卸载后。首版不承诺跨刷新恢复；有未保存或未确认正文时离开页面提示。
每客户端 scope 最多 20 份 pending / saved 附件；超限保留原文并说明原因。
挂载 draft 每 24 小时续期，已引用文件不会随卡片关闭而释放。

复制原文使用保留的本地正文，文件过期或创建失败时仍可恢复。已保存附件的预览与“放回
输入框”从认证接口读取，验证 UTF-16 长度、UTF-8 大小与 SHA-256；不会执行 HTML。
异步恢复期间输入、DOM 或 scope 改变时停止覆盖，要求重新选择位置。

网络失败只查询原 operationId，不自动重复创建或投递。查询 accepted 只更新原 scope，
unknown 提示核对真实 TUI；不能用新 operationId 盲目重试。

源码入口：[`状态与代际`](../src/features/terminal/input/text-attachments.ts)、
[`附件 UI`](../src/components/terminal/input/text-attachments.tsx)、
[`浮动草稿`](../src/components/terminal/input/use-floating-draft-controller.ts)。
验收入口：[`长文本`](../../docs/testing/terminal/runtime/text-attachments.testplan.yaml)、
[`既有浮动输入回归`](../../docs/testing/terminal/runtime/activity-composer.testplan.yaml)。
