# Web Terminal 状态查询入口实现计划

## 目标

基于原型 `docs/prototypes/thread-state-lookup/`，在 Web Terminal 右上角 `More actions` 菜单中增加 `状态查询` 入口，让用户能用 `threadId` 或 `terminalSessionId` 查询 App Server 投影出的轻量 ThreadRef 状态，并一键复制给 Agent 继续排障。

完成后用户可见行为：

1. 在 Web Terminal 顶栏右上角 `...` 菜单看到 `状态查询`。
2. 点击后打开居中 dialog。
3. `Thread ID` 模式输入 threadId，显示单条 ThreadRef 摘要。
4. `Terminal ID` 模式输入 terminalSessionId，显示该终端下的候选 ThreadRef 列表；多条结果时默认选中最可能相关的一条。
5. 点击候选行可切换下方详情。
6. 点击 `复制给 Agent`，复制一段包含最小状态和排查指令的文本。

## 非目标

- 不做完整诊断中心。
- 不展示 Raw JSON。
- 不提供 `复制 JSON`。
- 不查询 Slot、Port、Browser page、完整事件链或完整 Codex/Trae thread 正文。
- 不让前端直接读取 App Server 文件或直接连接 App Server token。
- 不改变 App Server 的 ThreadRef projection 规则。
- 不新增单元测试文件。本仓库仍按项目约束使用 typecheck、lint、Playwright E2E 和实际行为核对。

## 原型依据

- 原型目录：`docs/prototypes/thread-state-lookup/`
- 原型截图：`docs/prototypes/thread-state-lookup/prototype-preview.png`
- 关键交互：
  - 菜单项名：`状态查询`
  - dialog title：`状态查询`
  - 查询模式：`Thread ID`、`Terminal ID`
  - terminal 多候选排序：`running`、`starting` 优先，其次按 `updatedAt` 新到旧
  - 操作按钮：只保留 `复制给 Agent`

## 当前代码事实

- `frontend/src/components/terminal/terminal-workspace-shell.tsx` 已有 Web Terminal 顶栏 `More actions` 菜单，现有菜单项包括 `Preview`、`Terminal History`、`日志上报`。
- `frontend/src/components/diagnostic-log-entry.tsx` 已使用 Radix Dialog，可作为“菜单打开受控 dialog”的相邻实现参考。
- `packages/shared/src/app-server-events.ts` 已定义：
  - `AppServerThreadRef`
  - `AppServerThreadListResponse`
  - `AppServerThreadResponse`
- `app-server/src/http-server.ts` 已提供：
  - `GET /threads?projectId=&terminalSessionId=&terminalPanelId=&agent=&status=&limit=&after=`
  - `GET /threads/:threadId`
- `app-server/src/state-store.ts` 的 `listThreads` 当前按 `lastEventId` 升序返回；UI 多候选默认选择所需的 active-first 排序必须在前端处理。
- `backend/src/app-server/client.ts` 已有 `listThreads()` 和 `getThread()`，但 Web 前端现在通过 backend `apiBase` 访问 `/api/...`，不应直接请求 App Server。
- `backend/src/index.ts` 当前只在启动时初始化 App Server event consumer，没有面向 Web 前端暴露状态查询代理路由。
- `docs/testing/app-server-state-sync-test-cases.md` 已覆盖 App Server 状态 API 本身，包括鉴权、过滤、降级 thread key 和 projection。

## API 与安全边界

### Backend 新增代理路由

新增 backend 受保护路由，放在现有 backend auth 之后：

```text
GET /api/app-server/threads?terminalSessionId=&projectId=&terminalPanelId=&agent=&status=&limit=&after=
GET /api/app-server/threads/:threadId
```

返回类型沿用 shared：

```ts
AppServerThreadListResponse;
AppServerThreadResponse;
```

错误语义：

- App Server 未发现、不可用或 App Server 返回非 2xx：返回 `503 { "message": "App Server unavailable" }`。
- `GET /api/app-server/threads/:threadId` 未找到：返回 `404 { "message": "Thread not found" }`。
- query 参数非法：返回 `400 { "message": "Invalid query" }` 或复用 backend 现有参数校验错误格式。

安全要求：

- 该 backend 路由必须挂在 `requireAuth` 后。
- 前端只带 backend token，不接触 App Server token。
- 后端转发时使用 `discoverAppServer()` / `AppServerClient` 持有的 App Server token。
- 返回体只能是 ThreadRef 轻量状态，不返回 App Server token、lock path、事件日志文件路径或完整 thread 正文。

### Frontend service

在 `frontend/src/services/terminal.ts` 或单独 `frontend/src/services/app-server-state.ts` 增加：

```ts
listAppServerThreads(apiBase, token, filters): Promise<AppServerThreadListResponse>
getAppServerThread(apiBase, token, threadId): Promise<AppServerThreadResponse>
```

建议单独文件 `frontend/src/services/app-server-state.ts`，避免 `terminal.ts` 继续膨胀；再由需要的组件直接 import。

## 前端实现方案

### 新组件

新增：

```text
frontend/src/components/terminal/terminal-status-lookup-dialog.tsx
```

职责：

- 管理 dialog open 内部查询状态。
- 提供 `Thread ID` / `Terminal ID` 两种模式。
- 调用 backend 代理 API。
- 渲染候选列表、状态摘要、空态、加载态、错误态。
- 生成并复制 Agent 上下文。

Props 建议：

```ts
interface TerminalStatusLookupDialogProps {
  apiBase: string;
  token: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  activeProjectId: string | null;
  activeSessionId: string | null;
  activePanelId: string | null;
}
```

实现约束：

- 稳定函数优先使用 `ahooks` 的 `useMemoizedFn`。
- 不引入 `useCallback`，除非实现时明确说明现有组件 API 强制要求。
- 不显示 Raw JSON。
- 不显示 `复制 JSON`。
- 默认输入：
  - `Terminal ID` 模式优先填充当前 `activeSessionId`。
  - `Thread ID` 模式不强行猜测；若当前 active session metadata 可拿到 threadId，可预填，否则为空。
- dialog 打开后默认聚焦输入框。
- `Esc` / overlay / close button 按现有 Radix Dialog 行为关闭。

### 查询规则

`Thread ID` 模式：

1. 输入为空时只显示提示文案。
2. 点击查询或按 Enter 调用 `GET /api/app-server/threads/:threadId`。
3. 命中后显示单条 ThreadRef 摘要。
4. 404 显示 `未找到该 thread`。

`Terminal ID` 模式：

1. 输入为空时只显示提示文案。
2. 点击查询或按 Enter 调用 `GET /api/app-server/threads?terminalSessionId=<id>&limit=100`。
3. 0 条结果显示 `未找到该 terminal 的 ThreadRef`。
4. 1 条结果直接选中并显示详情。
5. 多条结果先展示候选列表，再显示选中详情。

候选排序在前端完成：

```text
running -> starting -> failed -> idle -> completed -> unknown
同状态按 updatedAt 新到旧
```

说明：`failed` 排在 `idle` 前面，因为排障视角下失败比空闲更需要关注。

### 显示字段

状态详情只显示以下字段：

- `status`
- `threadId`
- `agent`
- `terminalSessionId`
- `terminalPanelId`
- `projectId`
- `runId`
- `lastEventId`
- `lastHookEvent` 或 `lastCompletionReason`
- `updatedAt`
- `cwd`
- `sourceInstanceId`

空值统一显示 `null`，不要隐藏字段，避免用户误判“字段不存在”和“字段为空”。

### 复制给 Agent

复制内容必须是可直接粘给 Agent 的排查指令，不是 JSON dump。

单条结果模板：

```text
请帮我排查这个 Runweave App Server thread 当前状态：
threadId: ...
agent: ...
status: ...
projectId: ...
terminalSessionId: ...
terminalPanelId: ...
runId: ...
cwd: ...
lastEventId: ...
lastHookEvent: ...
lastCompletionReason: ...
updatedAt: ...

请优先读取 App Server projection/latest thread 状态和相关 JSONL 事件，再判断是否需要继续查终端、hook 或日志。
```

terminal 多候选时追加：

```text
同一个 terminalSessionId 下命中了 N 条 ThreadRef：
- status agent threadId panel=... updatedAt=...
```

复制成功显示短反馈；复制失败显示可手动选择文本的提示。

## Backend 实现落点

新增：

```text
backend/src/routes/app-server-state.ts
```

职责：

- 解析和校验 query。
- 使用 `discoverAppServer({ env: process.env })` 获取当前 App Server 连接，或复用已有连接提供者。
- 用 `AppServerClient.listThreads()` / `getThread()` 转发请求。
- 将 App Server 不可用统一转成 503。

`backend/src/index.ts`：

- import `createAppServerStateRouter`。
- 在 `createHttpApp()` 内挂载：

```ts
app.use("/api/app-server", requireAuth, createAppServerStateRouter());
```

可选优化：

- 如果实现时担心每次请求都 `discoverAppServer()` 带来重复文件读取，可在 `RuntimeServices` 中保存 `appServerClient`，启动成功后设置；但必须保留 lazy rediscover fallback，否则 App Server 晚于 backend 启动时状态查询会永久不可用。

## Frontend 实现落点

新增：

```text
frontend/src/components/terminal/terminal-status-lookup-dialog.tsx
frontend/src/services/app-server-state.ts
```

修改：

```text
frontend/src/components/terminal/terminal-workspace-shell.tsx
```

修改点：

- 增加 `statusLookupOpen` state。
- `More actions` 菜单新增 `状态查询`。
- 菜单图标使用 lucide 中现有合适图标，例如 `Search` 或 `Activity`；不要把文字 `search` 直接渲染成图标。
- 在 shell 底部挂载 `TerminalStatusLookupDialog`。
- 传入 `apiBase`、`token`、`activeProjectId`、`activeSession?.terminalSessionId`、当前 active panel id。

## 测试与验收

### 静态验证

必跑：

```bash
pnpm --filter @runweave/shared typecheck
pnpm --filter @runweave/backend typecheck
pnpm --filter @runweave/backend lint
pnpm --filter ./frontend typecheck
pnpm --filter ./frontend lint
git diff --check -- backend frontend packages/shared docs
```

如果 shared 类型未改，可仍保留 `@runweave/shared typecheck`，确保类型消费没有漂移。

### App Server 状态 API 回归

必跑：

```bash
pnpm app-server:verify-state-sync
```

预期：

- ASTS-022 状态查询 API 鉴权仍通过。
- ASTS-023 过滤能力仍通过。
- ASTS-020 缺失 threadId 的降级 key 仍通过。

### 浏览器验收

实现前新增或更新 repo-local runbook：

```text
docs/testing/runbooks/status-lookup-ui.md
```

runbook 至少覆盖：

1. `More actions -> 状态查询` 打开 dialog。
2. `Thread ID` 模式查询已存在 thread，显示状态摘要。
3. `Thread ID` 模式查询不存在 thread，显示未找到。
4. `Terminal ID` 模式查询命中多条，显示候选列表并默认选择 active-first 结果。
5. 点击候选行后，下方详情切换。
6. `复制给 Agent` 文本包含当前选中 ThreadRef；多候选场景包含候选列表。
7. 页面不出现 `复制 JSON` 和 `Raw JSON`。

完成实现后必须实际执行 `$playwright-cli` 验证 runbook 中的浏览器步骤，并在结果中给出关键证据。若缺少可复现的 App Server ThreadRef 数据，先用 App Server verify 脚本或临时真实事件写入构造数据，再打开 Web 页面验收；不要只靠静态代码阅读。

如仓库恢复或存在 frontend Playwright specs，可补充执行：

```bash
pnpm --filter ./frontend exec playwright test tests/smoke.spec.ts
```

当前 checkout 未发现 `frontend/tests` 或 `frontend/tests/*.spec.ts` 文件，不能把不存在的路径写成已执行验证。

## 风险与处理

- **App Server 晚于 backend 启动**：backend 代理必须支持 lazy rediscover，不能只依赖启动时连接结果。
- **多候选误选**：默认 active-first 只是排障便利，UI 必须保留候选列表和手动选择。
- **状态排序来源不一致**：App Server `/threads` 按 `lastEventId` 升序返回，UI 必须自行排序，不要求后端为一个展示场景改变全局语义。
- **敏感信息泄漏**：复制内容和 UI 只包含 ThreadRef 轻量字段，不包含 bearer token、App Server token、文件路径之外的日志内容。
- **诊断中心膨胀**：本计划不加入 Slot/Port/事件链等功能；后续需要时另写计划。

## 执行顺序

1. 增加 backend App Server 状态代理路由。
2. 增加 frontend App Server state service。
3. 新增 `TerminalStatusLookupDialog`。
4. 在 `TerminalWorkspaceShell` 菜单接入 `状态查询`。
5. 写 `docs/testing/runbooks/status-lookup-ui.md`。
6. 运行静态验证和 App Server 状态 API 回归。
7. 用 `$playwright-cli` 按 runbook 做浏览器验收并保存关键证据。

## 完成标准

- `More actions` 中出现 `状态查询`，且没有 `search Thread 状态` 这类占位图标文本。
- dialog 中没有 `复制 JSON` 和 `Raw JSON`。
- Thread ID 与 Terminal ID 两种查询都可用。
- Terminal ID 多候选时能选择不同 ThreadRef。
- `复制给 Agent` 的内容可直接用于后续 Agent 排障。
- 所有必跑命令通过，或明确记录未执行的阻塞原因。
