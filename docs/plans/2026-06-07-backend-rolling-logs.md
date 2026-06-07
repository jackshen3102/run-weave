# 后端滚动日志方案

日期：2026-06-07

状态：计划稿，尚未实施

## 背景

当前后端已经有少量 `console.error` / `console.warn`，主要分布在异常 catch 分支。问题是这些日志没有统一格式、没有稳定文件留存、缺少请求/会话上下文，也没有三天滚动保留机制。现有 `docs/quality/ai-diagnostic-logging.md` 描述的是显式 start/stop 的 AI 诊断日志录制系统，只适合临时复现窗口，不适合作为后台持续保留日志。

本计划目标是新增一套后端持续日志 utility：默认低噪声、结构化、落本地文件、保留最近三天，让后续 AI 排查问题时可以先读日志时间线，而不是只能靠猜测和临时加日志。

## 当前扫描结论

扫描范围：`backend/src/` 下所有非测试 TypeScript 文件。

已发现的日志和高风险区域：

- 现有 `console.*` 主要在 `session/manager.ts`、`routes/session.ts`、`routes/terminal.ts`、`ws/server.ts`、`ws/terminal-server.ts`、`terminal/tmux-service.ts`、`terminal/runtime-launcher.ts`、`terminal/pty-service.ts`、`routes/devtools.ts`、`ws/devtools-proxy.ts`、`routes/terminal-preview-routes.ts`。
- `backend/src/diagnostic-logs/recorder.ts` 已有 AI 诊断日志工具函数，但它只在记录窗口内收集显式调用，不收集普通后端运行日志。
- `backend/src/terminal/perf-logging.ts` 已有 `TERMINAL_PERF_LOGS=true` 控制的终端性能日志，但它是高频性能诊断，不适合作为默认持续日志。
- Electron 打包后端由 `electron/src/backend-runtime.ts` 以子进程启动，当前只把后端 stdout/stderr 转发到 Electron 进程；新方案需要确保后端自己写入稳定日志目录，否则桌面端问题仍然难以追溯。

## 推荐开源方案

首选：`winston` + `winston-daily-rotate-file`。

原因：

- `winston` 适合 Node/Express 后端的结构化日志、子 logger、level、transport 组合。
- `winston-daily-rotate-file` 直接支持按日期滚动、`maxFiles: "3d"`、`maxSize`、`dirname`、`filename`，符合“最近三天 + 滚动机制”的需求。
- 相比 `pino`，`pino` 本体很轻量，但时间滚动需要额外 transport，例如 `pino-roll`。`pino-roll` 能按 daily/hourly/size 滚动，但 retention 更偏文件数量；本需求按天保留，`winston-daily-rotate-file` 更直接。

建议配置：

```ts
new DailyRotateFile({
  dirname: backendLogDir,
  filename: "backend-%DATE%.jsonl",
  datePattern: "YYYY-MM-DD",
  maxFiles: "3d",
  maxSize: "50m",
  zippedArchive: false,
});
```

默认日志级别：

- `RUNWEAVE_LOG_LEVEL` 未设置时为 `info`。
- `RUNWEAVE_LOG_LEVEL=debug` 时允许更细的临时诊断日志，但计划内不默认开启。
- 测试环境可设 `RUNWEAVE_LOG_TO_FILE=false`，避免测试写真实用户目录。

## 日志目录

新增日志目录解析规则：

- 默认：`${browserProfileDir}/logs/backend/`
- 可覆盖：`RUNWEAVE_BACKEND_LOG_DIR`
- `browserProfileDir` 继续来自 `backend/src/utils/path.ts` 的 `resolveStoragePaths(process.env)`。

这样开发模式和 Electron 打包模式都能共用同一套持久目录。后端启动时记录一次 `backend.started`，其中包含 `logDir`、`host`、`port`、`runtimeReleaseId`，方便 AI 快速定位日志文件。

## 日志格式

日志使用 JSON Lines，一行一条，方便 `rg`、`jq` 和 AI 读取。

字段约定：

```ts
{
  "timestamp": "2026-06-07T12:00:00.000Z",
  "level": "warn",
  "event": "terminal.tmux.launch.fallback",
  "component": "terminal",
  "message": "tmux launch failed; falling back to pty",
  "requestId": "req_...",
  "sessionId": "...",
  "terminalSessionId": "...",
  "durationMs": 123,
  "error": {
    "name": "Error",
    "message": "...",
    "code": "..."
  }
}
```

约束：

- `event` 必须稳定，使用点分命名，例如 `session.create.failed`、`terminal.runtime.recreated`。
- 不记录 token、cookie、authorization、密码、完整敏感 URL、本地文件内容、终端输出正文、用户输入正文、截图、剪贴板图片正文。
- 终端输入/输出只允许记录长度、是否包含换行、序号、耗时；必要时可记录已有的短摘要，但不能记录完整内容。
- 错误日志可以带 stack，但必须先经过脱敏 helper。

## 不记录什么

为了避免日志变成噪声，不默认记录：

- 每一个成功 HTTP 请求。
- 每一个普通 400 表单校验失败。
- 每一个普通 401 access token 过期或未登录。
- 每一个普通 404 查询不存在资源。
- 高频终端输出正文、浏览器帧、鼠标移动、光标同步。
- 前端 `src/` 单测相关内容；本计划不新增前端单测。

这些路径只有在“异常但用户不容易定位”时记录，例如持续 websocket 握手失败、ticket resource 不匹配、远端 tunnel 鉴权失败、运行时状态和 store 状态不一致。

## 首批埋点范围

### 1. 日志基础设施

修改文件：

- `backend/package.json`
- `pnpm-lock.yaml`
- `backend/src/logging/logger.ts`
- `backend/src/logging/redaction.ts`
- `backend/src/logging/request-context.ts`
- `backend/src/logging/index.ts`
- `backend/src/utils/path.ts`
- `backend/src/index.ts`

任务：

- 新增 `winston` 与 `winston-daily-rotate-file` 依赖。
- 新增 `createLogger()`，配置 console transport 与 file rotate transport。
- 新增 `logger.info/warn/error/debug` 导出，以及 `logger.child({ component })` 风格 helper。
- 新增错误序列化与脱敏 helper。
- 新增 Express request context middleware，只生成 `requestId` 和基础上下文，不默认记录每个请求。
- logger 初始化必须早于 `createRuntimeServices()`，确保服务创建、存储初始化、浏览器初始化、tmux 初始化、端口绑定之前的失败也能落到文件。
- 将入口从裸 `void startRuntime()` 改成带 `.catch()` 的启动边界；`startRuntime().catch(...)` 必须记录 `backend.start.failed`，flush/close logger 后再设置非 0 退出。
- 在启动成功后记录 `backend.started`；端口绑定、service 创建、runtime 初始化阶段失败统一用 `backend.start.failed`，并带 `stage` 字段。
- shutdown 开始和完成记录 `backend.shutdown.started`、`backend.shutdown.completed`。shutdown 必须 await `server.close()`，然后 dispose runtime/session/store，最后 flush/close logger transports，再 `process.exit(0)`。
- 在 `listenWithFallback` 端口降级成功时记录 `server.port.fallback`。

验收：

- 启动后能看到 `${browserProfileDir}/logs/backend/backend-YYYY-MM-DD.jsonl`。
- 文件内有 `backend.started`，包含 `logDir` 和实际监听端口。
- 人为制造 `createRuntimeServices()` 或端口绑定失败时，日志文件内有 `backend.start.failed`，而不是只出现在 stderr。
- 发送 `SIGTERM` 后，日志文件内能看到 `backend.shutdown.started` 和 `backend.shutdown.completed`；`backend.shutdown.completed` 必须在 logger flush/close 前写入。
- `RUNWEAVE_BACKEND_LOG_DIR=/tmp/runweave-logs` 时日志写入覆盖目录。
- `RUNWEAVE_LOG_TO_FILE=false` 时不创建日志文件。

### 2. 替换现有 console 日志

修改文件：

- `backend/src/session/manager.ts`
- `backend/src/routes/session.ts`
- `backend/src/routes/terminal.ts`
- `backend/src/routes/terminal-completion.ts`
- `backend/src/routes/terminal-mobile-overview.ts`
- `backend/src/routes/terminal-preview-routes.ts`
- `backend/src/routes/session-favicon.ts`
- `backend/src/routes/devtools.ts`
- `backend/src/ws/server.ts`
- `backend/src/ws/terminal-server.ts`
- `backend/src/ws/terminal-server-connection-helpers.ts`
- `backend/src/ws/input-handler.ts`
- `backend/src/ws/devtools-proxy.ts`
- `backend/src/terminal/tmux-service.ts`
- `backend/src/terminal/tmux-orphan-scan.ts`
- `backend/src/terminal/runtime-launcher.ts`
- `backend/src/terminal/pty-service.ts`
- `backend/src/terminal/preview-search-candidates.ts`

任务：

- 将现有 `console.error/warn/info` 替换成统一 logger。
- 保留现有 message 语义，但补充 `event`、`component`、相关 id、错误对象。
- 不改变业务行为、响应状态码和错误文案。

验收：

- `rg "console\\.(error|warn|info)" backend/src --glob '!**/*.test.ts'` 不再命中业务后端日志点；`diagnostic-logs/recorder.ts` 里用于 AI 诊断日志打印的 `console.log` 可以保留。
- 现有后端 typecheck 通过。

### 3. 补齐异常分支和可疑正常分支

按模块新增少量日志。

`backend/src/browser/service.ts`

- `browser.session.launch.started` / `browser.session.launch.failed`
- `browser.session.cdp.connect.failed`
- `browser.session.context.closed`
- `browser.remote-debugging-port.allocate.failed`
- 不记录页面 URL 列表和 headers 原文。

`backend/src/session/manager.ts`

- `session.create.started` / `session.create.completed` / `session.create.failed`
- `session.restore.started` / `session.restore.failed`
- `session.destroy.failed-profile-cleanup`
- `session.connection.changed` 只在状态变化时记录，不记录重复心跳。

`backend/src/ws/server.ts` 与 `backend/src/ws/handshake.ts`

- `viewer-ws.handshake.rejected`：仅记录原因和 sessionId，不记录 token。
- `viewer-ws.connected` / `viewer-ws.closed`：记录 close code、reason、sessionId、连接时长。
- `viewer-ws.invalid-message`：记录 message length 和 sessionId，不记录原始消息。
- `viewer-ws.screencast.failed`、`viewer-ws.tabs.initialize.failed`。

`backend/src/ws/terminal-server.ts` 与 `backend/src/ws/terminal-handshake.ts`

- `terminal-ws.handshake.rejected`
- `terminal-ws.connected` / `terminal-ws.closed`
- `terminal.runtime.recreate.failed`
- `terminal.runtime.missing`
- `terminal.tmux.attach-runtime.disposed`
- `terminal.tmux.metadata-sync.failed`
- `terminal.input.failed`
- 不记录终端输入正文和输出正文。

`backend/src/routes/terminal.ts`

- `terminal.session.create.requested`
- `terminal.session.create.failed`
- `terminal.session.runtime.tmux-unavailable`
- `terminal.session.runtime.tmux-launch-fallback`
- `terminal.session.delete.started` / `terminal.session.delete.failed`
- `terminal.tmux.orphan.scan.failed`
- `terminal.tmux.orphan.cleanup.failed`
- `terminal.clipboard-image.too-large` 只记录 bytes 和 sessionId，不记录图片内容。

`backend/src/terminal/runtime-launcher.ts`

- `terminal.tmux.session-missing.rebuild`
- `terminal.tmux.rebuild-limit.exceeded`
- `terminal.tmux.capture-pane.failed`
- `terminal.pty.fallback.activated`

`backend/src/terminal/pty-service.ts`

- `terminal.pty.spawn.failed`
- `terminal.pty.quick-exit`
- `terminal.pty.fallback.failed`
- `terminal.pty.spawn-helper.prepare.failed`

`backend/src/terminal/tmux-service.ts`

- `terminal.tmux.availability.probe.failed`
- `terminal.tmux.has-session.failed`
- `terminal.tmux.kill-session.failed`
- `terminal.tmux.wait-pane-ready.timeout`
- `terminal.tmux.command.timeout`，仅记录命令类别，不记录完整 shell payload。

`backend/src/routes/terminal-preview-routes.ts` 与 `backend/src/terminal/preview-search-candidates.ts`

- `terminal-preview.request.failed`
- `terminal-preview.search.rg-fallback`
- `terminal-preview.search.timeout`
- `terminal-preview.file.mutation.conflict`，只记录相对路径和 mtime，不记录文件内容。

`backend/src/routes/session.ts`

- `session.default-cdp-endpoint.fallback`
- `session.create.failed`
- `session.ws-ticket.unauthorized` 仅在 session 存在但 ticket 生成请求无效时 warn，不记录 token。
- `session.devtools-ticket.unauthorized` 同上。

`backend/src/routes/devtools.ts` 与 `backend/src/ws/devtools-proxy.ts`

- `devtools.remote-debugging-port.missing`
- `devtools.revision.resolve.failed`
- `devtools.target.resolve.failed`
- `devtools.proxy.upstream.error`
- `devtools.proxy.client.error`

`backend/src/server/tunnel-auth.ts`

- `tunnel-auth.rejected`：记录 path、是否 forwarded、remote address 类型，不记录 token/cookie。
- 不记录每次成功鉴权。

### 4. 保留现有 AI 诊断日志边界

修改文件：

- `docs/quality/ai-diagnostic-logging.md`
- 新增 `docs/quality/backend-rolling-logs.md`
- 更新 `docs/README.md`

任务：

- 不把新 logger 接入 AI 诊断日志 recorder。
- 不包裹全局 `console.*`、`process.stdout`、`process.stderr`。
- 文档明确两者区别：
  - 后端滚动日志：持续保留最近三天，默认低噪声，给 AI 回溯排查。
  - AI 诊断日志：临时 start/stop 录制，适合复现窗口和前后端合并证据。
- 文档给出排查命令：

```bash
find ~/.browser-profile -path '*/logs/backend/backend-*.jsonl' -mtime -3 -print
tail -n 200 <log-file>
rg '"event":"terminal\\.' <log-file>
```

验收：

- `docs/README.md` 有后端滚动日志入口。
- `docs/quality/backend-rolling-logs.md` 写清日志目录、保留策略、常用排查命令和脱敏边界。

## 验证命令

执行实现时建议跑：

```bash
pnpm --filter ./backend typecheck
pnpm --filter ./backend lint
git diff --check
```

手工验证：

```bash
RUNWEAVE_BACKEND_LOG_DIR=/tmp/runweave-backend-logs pnpm --filter ./backend start -- --host 127.0.0.1 --port 5017
```

预期：

- `/tmp/runweave-backend-logs/backend-YYYY-MM-DD.jsonl` 被创建。
- 访问 `/health` 后不产生一条普通成功请求日志。
- 触发一个可疑路径，例如错误的 `/ws/terminal` ticket 或 terminal create fallback，日志出现稳定 `event`。
- 日志中不包含 `Authorization`、`Cookie`、`RUNWEAVE_HOOK_TOKEN`、终端输入正文、文件正文。

滚动验证：

- 通过代码检查和临时 `RUNWEAVE_BACKEND_LOG_DIR` 目录确认 `maxFiles: "3d"`、`maxSize: "50m"` 配置存在；不默认新增单测，除非执行时用户明确要求补测试。
- 不要求真实等待三天；检查 daily rotate transport 配置和 audit file 行为即可。

## 风险与控制

- 风险：日志过多影响磁盘。控制：默认只记录关键异常/可疑分支，`maxFiles: "3d"` + `maxSize: "50m"`。
- 风险：泄露敏感信息。控制：统一脱敏 helper，禁止记录 token/cookie/header 原文、终端正文、文件正文。
- 风险：高频终端路径拖慢运行。控制：默认不记录每个输出 chunk；性能日志继续由 `TERMINAL_PERF_LOGS=true` 控制。
- 风险：开发模式有日志但 Electron 模式没有。控制：日志目录由后端 storage path 解析，Electron 子进程无需依赖 stdout/stderr。
- 风险：计划执行时误改前端测试。控制：本计划不需要新增前端单测；前端 `src/` 仍按 AGENTS 约束只保留 E2E 作为正式自动化验证。

## 非目标

- 不引入远程日志服务、Sentry、Datadog、Loki 或云端上传。
- 不实现日志 UI。
- 不记录所有 HTTP request access log。
- 不自动采集 stdout/stderr、子进程输出、浏览器 console、Playwright trace。
- 不替换现有 AI 诊断日志系统。
- 不新增 Windows 打包或跨平台安装包逻辑。

## 完成标准

- 后端新增统一 logger utility，开发和 Electron 后端都能写入同一规则的滚动 JSONL 文件。
- 默认只记录异常分支、降级分支、状态不一致、关键恢复路径和可疑正常分支。
- 日志保留最近三天，并有单文件大小上限。
- 现有 `console.*` 后端业务日志点已迁移，临时诊断日志保留原边界。
- 文档说明 AI 如何找到和读取最近三天后端日志。
- `pnpm --filter ./backend typecheck`、`pnpm --filter ./backend lint`、`git diff --check` 通过。
