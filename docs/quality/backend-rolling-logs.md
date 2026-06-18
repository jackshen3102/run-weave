# 后端滚动日志

Runweave 后端默认写入持续滚动的 JSON Lines 日志，用于 AI 和工程师回溯最近三天的后端异常、降级、恢复和可疑分支。

## 目录与保留

- 默认目录：`${browserProfileDir}/logs/backend/`
- 覆盖目录：`RUNWEAVE_BACKEND_LOG_DIR=/tmp/runweave-backend-logs`
- 文件名：`backend-YYYY-MM-DD.jsonl`
- 保留策略：`maxFiles: "3d"`，单文件 `maxSize: "50m"`，不压缩
- 默认级别：`RUNWEAVE_LOG_LEVEL` 未设置时为 `info`
- 关闭文件日志：`RUNWEAVE_LOG_TO_FILE=false`

`browserProfileDir` 来自后端 storage path 解析。开发模式和 Electron 后端子进程使用同一套目录规则，不依赖 Electron 转发 stdout/stderr。

## 格式

每行是一条 JSON：

```json
{
  "timestamp": "2026-06-07T12:00:00.000Z",
  "level": "warn",
  "event": "terminal.tmux.session-missing.rebuild",
  "component": "terminal",
  "message": "Tmux terminal session missing; rebuilding",
  "terminalSessionId": "..."
}
```

常见字段：

- `timestamp`：ISO 时间。
- `level`：`debug`、`info`、`warn`、`error`。
- `event`：稳定点分事件名。
- `component`：`backend`、`session`、`browser`、`viewer-ws`、`terminal`、`terminal-ws`、`devtools`、`tunnel-auth` 等。
- `requestId`、`method`、`path`：来自 Express 请求上下文；不会自动记录每个成功请求。
- `sessionId`、`terminalSessionId`、`durationMs`：按场景写入。
- `error`：脱敏后的错误对象，可能包含 `name`、`message`、`stack`、`code`。

## 排查命令

```bash
find ~/.runweave/browser-profile -path '*/logs/backend/backend-*.jsonl' -mtime -3 -print
tail -n 200 <log-file>
rg '"event":"terminal\\.' <log-file>
rg '"level":"error"' <log-file>
```

临时指定目录验证：

```bash
RUNWEAVE_BACKEND_LOG_DIR=/tmp/runweave-backend-logs pnpm --filter ./backend start -- --host 127.0.0.1 --port 5017
tail -n 50 /tmp/runweave-backend-logs/backend-$(date +%F).jsonl
```

## 脱敏边界

后端滚动日志不记录 token、cookie、authorization header、密码、完整敏感 URL、本地文件内容、终端输入正文、终端输出正文、截图或剪贴板图片正文。

终端相关日志只记录长度、是否包含换行、序号、耗时、runtime 类型、session id、tmux session 名等元数据。文件预览日志只记录错误、相对路径或 mtime 等元数据，不记录文件正文。

## 与 AI 诊断日志的区别

后端滚动日志：

- 持续运行，默认低噪声。
- 保留最近三天。
- 记录后端启动、关闭、异常、降级、恢复和可疑状态。
- 不需要显式 start/stop。

AI 诊断日志：

- 需要显式 start/stop。
- 只收集 AI 临时插入的诊断日志工具函数输出。
- 适合复现窗口内合并前端、后端证据。
- 不包装全局 `console.*`，不采集 stdout/stderr，也不扫描后端滚动日志。
