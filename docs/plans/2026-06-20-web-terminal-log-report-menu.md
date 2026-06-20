# Web 端右上角日志上报入口实施计划

## 背景与现状

APP 端已经有显式的日志上报入口和完整流程：

- `app/src/pages/HomePage.tsx` 的更多菜单包含「日志上报」。
- `app/src/pages/AppTerminalPage.tsx` 的终端页更多菜单也包含「日志上报」。
- `app/src/features/support-logs/SupportLogSheet.tsx` 支持开始记录、结束并上报、展示服务端日志文件路径、复制路径、清除本地日志。

Web 端原有诊断日志能力，但旧入口和体验不满足这次目标：

- 旧版 `frontend/src/App.tsx` 通过 `window.runweaveDiagnosticLogs.enable()` 或 localStorage 渲染 `DiagnosticLogEntry` 浮窗；该入口已删除。
- 旧版 `frontend/src/components/diagnostic-log-entry.tsx` 是固定浮窗，偏调试入口；结束后可查看/复制日志正文、下载日志，但没有以「服务端路径」为核心的上报结果展示。当前组件只保留右上角菜单使用的受控 dialog 形态。
- `backend/src/routes/diagnostic-logs.ts` 的 `/api/diagnostic-logs/stop` 已经调用 `recorder.persistLatestResult()`，因此后端已具备“保存到服务端目录”的能力，不需要新增后端接口。
- 截图对应的 Web 端右上角工具栏在 `frontend/src/components/terminal/terminal-workspace-shell.tsx`，现有按钮包含 `TerminalSubmitPopover`、`TerminalPreviewMenu`、Orchestrator、History 等。

## 目标

在 Web 端终端工作区右上角增加一个「...」更多按钮，点击后出现更多选项，其中包含「日志上报」。点击「日志上报」后打开一个显式的 Web 日志上报面板，体验对齐 APP 的核心能力：

1. 用户不用在控制台执行方法，也能从界面进入日志上报。
2. 支持「开始记录」。
3. 支持「结束并上报」，调用已有 `/api/diagnostic-logs/stop`，把前端诊断日志与后端诊断日志合并并持久化到服务端目录。
4. 上报完成后展示服务端日志文件路径，优先展示 `result.files.logsJsonl`，没有时 fallback 到 `result.files.dir`。
5. 支持一键复制日志路径，复制内容为 `logsJsonl ?? dir`。

## 非目标

- 不新增后端日志接口；沿用 `/api/diagnostic-logs/status`、`/start`、`/stop`、`/result`、`/download`。
- 不改 APP 的 `SupportLogSheet` 行为和视觉。
- 不扩大诊断日志采集范围；仍然只收集 `aiDiagnosticLog(...)` / Web 前端 recorder 明确写入的诊断日志，不包装 `console.*`、stdout、stderr 或本地文件内容。
- 不新增单元测试、Vitest、Node test 或 coverage 门槛；本仓库该类验证只走 Playwright E2E、typecheck、lint。
- 删除旧的 `window.runweaveDiagnosticLogs` 控制器和全局浮窗入口；Web 端只保留右上角「日志上报」入口。

## 推荐方案

采用 L2 范围的前端为主改造：

1. 复用并增强现有 `DiagnosticLogEntry` 组件，让它支持从右上角菜单显式打开，并补齐服务端日志路径展示/复制能力。
2. 在 `TerminalWorkspaceShell` 右上角添加更多菜单按钮，菜单项先只接入「日志上报」，后续扩展其它动作。
3. 将 `/api/diagnostic-logs/status` 的 `startedAt` 响应类型补齐到共享协议，避免 Web 端继续把记录窗口边界当成隐式信息。

## 文件范围

- `packages/shared/src/diagnostic-logs.ts`
  - 新增 `DiagnosticLogStatusResponse`：

```ts
export interface DiagnosticLogStatusResponse {
  status: DiagnosticLogStatus;
  startedAt?: string | null;
}
```

- `app/src/services/diagnostic-logs.ts`
  - 删除本地重复的 `DiagnosticLogStatusResponse` 定义，改从 `@runweave/shared` 导入。
  - 保持 APP 行为不变。

- `frontend/src/services/diagnostic-logs.ts`
  - `getDiagnosticLogStatus`、`startDiagnosticLogs` 返回 `DiagnosticLogStatusResponse`。
  - 保持 `stopDiagnosticLogs` 返回 `DiagnosticLogResult`。

- `frontend/src/components/diagnostic-log-entry.tsx`
  - 复用现有组件，不新增平行的日志上报组件。
  - 删除旧的固定浮窗、拖拽位置、本地入口开关逻辑。
  - 保留受控打开能力，供右上角「日志上报」菜单直接打开。Props：

```ts
interface DiagnosticLogEntryProps {
  apiBase: string;
  token: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}
```

- 不要把现有 `DiagnosticLogEntry` 的 recorder/service 逻辑复制到新文件；只在这个组件里抽出少量内部 render helper，降低重复。
- UI 状态：
  - `status: DiagnosticLogStatus`
  - `result: DiagnosticLogResult | null`
  - `recordingStartedAt: Date | null`
  - `serverPath: string | null`
  - `busyAction: "start" | "stop" | "refresh" | null`
  - `message: string | null`
  - `copied: boolean`
- 行为：
  - 打开弹窗时加载 status/result；如果后端正在 recording 且有 `startedAt`，同步为当前记录窗口。
  - 点击「开始记录」继续调用现有 `startDiagnosticLogs` + `frontendDiagnosticLogRecorder.start()`；触发来源从右上角进入时可写入 `aiDiagnosticLog("diagnostic recording started", { trigger: "terminal_more_menu" })`。
  - 点击「结束并上报」继续复用现有 `stopDiagnosticLogs(apiBase, token, frontendDiagnosticLogRecorder.getBufferedLogs())` + `frontendDiagnosticLogRecorder.finish(result)`。
  - 结束后设置 `serverPath = result.files?.logsJsonl ?? result.files?.dir ?? null`。
  - 如果没有 `serverPath`，仍显示日志条数和失败提示，避免误导用户认为已经有可复制路径。
  - 点击「复制日志路径」使用 `navigator.clipboard.writeText(serverPath)`。
  - 保留现有「下载日志」能力，但右上角入口的主路径是“结束并上报后复制服务端路径”。
- 文案建议：
  - 标题：「日志上报」
  - 说明：「开始记录后复现问题，结束时会把本轮 Web 与服务端诊断日志保存到服务端目录。」
  - 主按钮：「开始记录」/「结束并上报」
  - 路径标签：「服务端日志文件」
  - 复制按钮：「复制日志路径」

- `frontend/src/components/terminal/terminal-workspace-shell.tsx`
  - 引入 `MoreHorizontal` 图标和 `DropdownMenu` 系列组件。
  - 在右上角工具栏末尾添加更多按钮，位置建议在 History 按钮之后，保持截图右上角图标组的操作入口一致。
  - 仅在 `!isMobileMonitor` 时显示，和现有 Preview/Orchestrator/History 保持一致。
  - 点击「日志上报」时设置本地 `diagnosticLogOpen=true`，并渲染：

```tsx
<DiagnosticLogEntry
  apiBase={apiBase}
  token={token}
  open={diagnosticLogOpen}
  onOpenChange={setDiagnosticLogOpen}
/>
```

- 避免依赖 `window.runweaveDiagnosticLogs.enable()`；该控制器和旧浮窗入口已删除。
- 按钮样式对齐现有图标按钮：

```tsx
className =
  "h-6 w-6 shrink-0 rounded-md px-0 text-slate-300 hover:bg-slate-800 hover:text-slate-100";
```

- `frontend/tests/terminal-preview.spec.ts` 或新增 `frontend/tests/terminal-diagnostic-logs.spec.ts`
  - 只新增 Playwright E2E。
  - 优先新增独立 spec，避免扩大 Preview 既有用例的职责。

## 用户可见行为

### 默认态

- 用户进入 Web 终端工作区后，右上角能看到「...」更多图标。
- 鼠标悬浮或辅助技术可读 label：`More actions`。
- 点击后下拉菜单包含「日志上报」。

### 记录态

- 点击「日志上报」打开对话框。
- 状态显示「可记录」时，主按钮为「开始记录」。
- 点击「开始记录」后，状态变为「记录中」，对话框提示用户复现问题。
- 记录中主按钮变为「结束并上报」。

### 上报完成

- 点击「结束并上报」后，后端保存结果到服务端目录。
- 对话框展示本轮日志条数和服务端日志文件路径。
- 「复制日志路径」复制 `logsJsonl ?? dir`。
- 不强制下载日志；下载仍可保留在旧浮窗或作为次要按钮，但本计划核心验收是服务端路径复制。

### 错误态

- 后端不可用时显示「开始记录失败：后端不可用」或「结束并上报失败：后端不可用」。
- token 失效时沿用现有 request 层错误，不在该组件内新增认证流。
- 结束后如果 `result.files` 缺失，显示「已结束记录，但未返回服务端日志路径」，并禁用复制按钮。

## 验证计划

### 静态验证

1. `pnpm typecheck`
   - 预期：无 TS 错误，尤其是 `DiagnosticLogStatusResponse` 在 APP/Web/后端类型使用一致。

2. `pnpm lint`
   - 预期：无 lint 错误。

### Playwright E2E

必须使用 `$playwright-cli`，禁止使用其它浏览器自动化方案。

建议新增用例覆盖：

1. 显式入口可见
   - 进入 Web 终端工作区。
   - 断言右上角存在 `More actions` 图标按钮。
   - 点击后能看到「日志上报」菜单项。

2. 日志上报 happy path
   - 拦截或连接测试后端的 `/api/diagnostic-logs/status`、`/start`、`/stop`。
   - 点击「日志上报」。
   - 点击「开始记录」，断言 UI 进入「记录中」。
   - 点击「结束并上报」，mock `/stop` 返回：

```json
{
  "startedAt": "2026-06-20T00:00:00.000Z",
  "stoppedAt": "2026-06-20T00:00:05.000Z",
  "logs": [],
  "files": {
    "dir": "/tmp/runweave/diagnostic-logs/run-2026",
    "logsJsonl": "/tmp/runweave/diagnostic-logs/run-2026/logs.jsonl",
    "redactionReportJson": "/tmp/runweave/diagnostic-logs/run-2026/redaction-report.json"
  }
}
```

- 断言对话框展示 `/tmp/runweave/diagnostic-logs/run-2026/logs.jsonl`。
- 点击「复制日志路径」，断言 clipboard 内容为该路径。

3. 无服务端路径降级
   - `/stop` 返回合法 `DiagnosticLogResult` 但没有 `files`。
   - 断言复制按钮禁用，并显示未返回路径的提示。

### 手工验证

1. 启动本地开发服务：`pnpm dev`。
2. 用 `$playwright-cli` 打开 Web 终端页。
3. 在右上角点击「...」→「日志上报」。
4. 开始记录、执行一次终端/浏览器操作、结束并上报。
5. 复制路径后，在本机确认路径指向后端持久化目录下的 `logs.jsonl`。

## 风险与注意事项

- 记录窗口边界：Web 旧浮窗没有使用 `startedAt`；本次补齐 status/start 返回类型后，应避免页面刷新后上传错误范围。Web recorder 本身是内存态，页面刷新后前端日志会丢失，这是当前 Web 诊断日志设计限制，本计划不扩展持久化。
- 后端全局 recorder：诊断日志 recorder 当前是后端进程级全局状态，不是按用户/终端 session 隔离。本次只暴露已有能力，不改变隔离语义。
- APP 行为不能回退：共享类型变更后必须确认 APP `SupportLogSheet` 编译通过，尤其是 `startedAt` 仍可用。
- 右上角空间：截图中的工具栏高度紧凑，新增按钮必须固定 `h-6 w-6`，不要引入文字按钮或导致 Preview 按钮挤压。
- 安全边界：不要把 token、Authorization、cookie、本地文件内容、完整敏感 URL 写入诊断日志，也不要新增 console 全量采集。

## 验收标准

- Web 终端工作区右上角有显式「...」更多入口。
- 更多菜单包含「日志上报」。
- 用户可以从该入口完成开始记录、结束并上报、查看服务端日志路径、复制日志路径。
- 上报仍使用已有 `/api/diagnostic-logs/*` 接口，后端日志文件由 `/stop` 持久化生成。
- APP 现有日志上报入口和流程不变。
- `pnpm typecheck`、`pnpm lint` 通过。
- `$playwright-cli` 驱动的 E2E/浏览器验证覆盖显式入口和路径复制。
