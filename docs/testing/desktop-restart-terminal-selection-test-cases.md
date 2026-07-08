# 桌面端重启恢复项目与终端测试案例

## 需求来源

任务描述：桌面端更新重启后，记住打开的项目和终端；当前表现是打开第一个项目的第一个终端，不方便。

本文档只覆盖本次需求中的桌面端项目/终端恢复选择，不覆盖终端命令执行、Agent Team worker 行为、Terminal Browser tab 恢复、App Ionic 端详情页交互。

## 当前代码事实

- 桌面 Web 入口在 `frontend/src/App.tsx`：已登录时 `/` 和 `/login` 会跳转到 `/terminal`，`/terminal/:terminalSessionId` 进入同一个 `TerminalRoutePage`。
- `frontend/src/pages/terminal-page.tsx` 将路由中的 `terminalSessionId` 作为 `initialTerminalSessionId` 传给 `TerminalWorkspace`，并在 active session 变化后用 `navigate("/terminal/:id", { replace: true })` 同步 URL。
- `frontend/src/components/terminal/terminal-workspace.tsx` 加载 `GET /api/terminal/project` 与 `GET /api/terminal/session` 后，若当前项目/终端不可用，会回退到 `initialTerminalSessionId` 所属项目，否则回退到项目列表第一个；当前项目下没有有效 active session 时，会选择 `resolvePreferredSessionId(...)` 的结果，否则回退到当前项目下第一个终端。
- `frontend/src/components/terminal/terminal-workspace-effects.ts` 的 `usePersistRecentSelection` 会在项目/终端选择稳定后保存最近选择；`resolvePreferredSessionId` 会优先使用指定的 preferred session，再使用 recent selection，再回退到第一个 session。
- `frontend/src/features/terminal/recent-selection.ts` 使用 `localStorage` key `viewer.terminal.recent.<apiBase>` 保存 `{ projectId, terminalSessionId, projectSessionIds }`，按 API base 隔离不同后端连接。
- 终端 tab 按钮带 `data-terminal-session-id`；项目按钮可通过可见项目名和 `aria-pressed` 取证。
- 后端项目/终端列表来自 `backend/src/routes/terminal-project-routes.ts` 与 `backend/src/routes/terminal.ts`；`TerminalSessionManager.listProjects/listSessions` 按 `order` 优先、否则按 `createdAt` 排序，因此“第一个项目/第一个终端”是有序回退，不应覆盖有效的最近选择。
- 本机持久化文件名包含 `terminal-session-store.json`，由 browser profile 目录保存项目、终端、排序、状态等数据。
- 本地更新脚本 `scripts/runweave-update.mjs` 会在需要时退出并重启 `/Applications/Runweave.app`；桌面端页面验证必须使用 `$computer-use` 操作桌面 App，并使用 `$playwright-cli` 对页面 URL、DOM、localStorage 和 API 响应取证。

## 必跑命令

按顺序执行，任一失败即停止：

```bash
pnpm --filter @runweave/shared typecheck
pnpm --filter @runweave/frontend typecheck
pnpm --filter @runweave/electron typecheck
pnpm --filter @runweave/backend typecheck
pnpm lint
pnpm runweave:update --dry-run
git diff --check
```

行为验收必须额外执行真实环境验证：

- 使用 `$computer-use` 打开本机 Runweave 桌面端，准备至少 2 个项目，且目标项目至少有 2 个终端。
- 使用 `$playwright-cli` 连接桌面端对应页面或等价的 Electron dev 页面，读取 URL、`localStorage["viewer.terminal.recent.<apiBase>"]`、项目按钮 `aria-pressed`、终端 tab 的 `data-terminal-session-id`。
- 需要覆盖真实更新重启时，执行 `pnpm runweave:update`，等待 `/Applications/Runweave.app` 重启完成后再用 `$computer-use` + `$playwright-cli` 取证。

## 测试设计方法

- 场景/用例法：覆盖用户“选择非第一个项目/终端 -> 桌面更新重启 -> 回到同一项目/终端”的端到端主路径。
- 状态迁移：覆盖 recent selection 从有效、缺失、损坏、引用已删除对象到重启恢复后的迁移。
- 判定表：按 `route terminalSessionId`、recent selection、后端项目/终端存在性三类条件组合决定恢复结果。
- 等价类划分：有效 recent selection、无 recent selection、损坏 JSON、跨 API base selection、已删除项目/终端分别作为不同等价类。
- 错误猜测：覆盖更新重启时后端尚未 ready、项目/终端排序第一项与最近选择不同、切换项目后保留每项目最近终端等易错点。

## 测试案例

### DRTS-001 有效最近选择在桌面更新重启后恢复到同一项目和终端

标签：desktop-restart update recent-selection playwright computer-use
步骤：

1. 使用已登录桌面端，准备项目 A、项目 B，且后端 `GET /api/terminal/project` 中 A 排在 B 前。
2. 在项目 B 下准备终端 B1、B2，且后端 `GET /api/terminal/session` 中 B1 排在 B2 前。
3. 用 `$playwright-cli` 选择项目 B 的终端 B2，确认 URL 为 `/terminal/<B2>`，并确认 `localStorage["viewer.terminal.recent.<apiBase>"]` 中 `projectId=B`、`terminalSessionId=B2`、`projectSessionIds[B]=B2`。
4. 执行 `pnpm runweave:update`，用 `$computer-use` 等待 Runweave 桌面端退出并重新显示终端工作台。
5. 用 `$playwright-cli` 读取重启后的 URL、项目按钮 `aria-pressed`、终端 tab `data-terminal-session-id`、localStorage、`/api/terminal/project` 和 `/api/terminal/session`。
   期望：
6. 页面 URL 最终为 `/terminal/<B2>`。
7. 项目 B 按钮为 `aria-pressed="true"`。
8. 终端 tab 中 `data-terminal-session-id="<B2>"` 是当前 active session。
9. 页面不会自动切到项目 A 或终端 B1。
   失败判定：
10. 重启后 URL 为 `/terminal/<A 下任一终端>`、`/terminal/<B1>` 或 `/terminal` 且 active session 不是 B2。
11. localStorage 仍指向 B2 但 UI 选择了其他终端。
12. 取不到 URL、DOM、localStorage 或 API 响应证据。

### DRTS-002 桌面端普通退出再打开同样恢复最近项目和终端

标签：desktop-restart quit-reopen recent-selection playwright computer-use
步骤：

1. 使用已登录桌面端，准备项目 A、项目 B，且项目 A 排在项目 B 前。
2. 在项目 B 下准备终端 B1、B2，且 B1 排在 B2 前。
3. 用 `$playwright-cli` 选择项目 B 的终端 B2，确认 URL 为 `/terminal/<B2>`，并确认 recent selection 有效。
4. 使用系统菜单或 `osascript` 退出 Runweave，再用 `$computer-use` 重新打开 `/Applications/Runweave.app`，本用例不执行更新。
5. 用 `$playwright-cli` 读取重新打开后的 URL、项目按钮、终端 tab 和 localStorage。
   期望：
6. 桌面端重新打开后仍进入 `/terminal/<B2>`。
7. 项目 B 为当前项目，终端 B2 为当前 active session。
   失败判定：
8. 普通退出再打开后回到第一个项目或第一个终端。
9. 普通重启恢复正常但 DRTS-001 的更新重启恢复失败。
10. 取不到 URL、DOM 或 localStorage 证据。

### DRTS-003 访问 `/terminal` 且存在有效 recent selection 时不回退到第一个终端

标签：terminal-route recent-selection fallback playwright
步骤：

1. 直接打开 `/terminal`，确保路由中没有 `terminalSessionId`。
2. 写入或保留有效 `localStorage["viewer.terminal.recent.<apiBase>"]`，使其指向项目 B 的终端 B2。
3. 确认项目 A、项目 B、终端 B1、终端 B2 都仍存在，且项目 A/B、终端 B1/B2 的排序能暴露“第一个”回退。
4. 刷新页面或重新加载 Electron 窗口，等待项目和终端列表加载完成。
5. 用 `$playwright-cli` 读取 URL、项目按钮、终端 tab 和 API 响应。
   期望：
6. 页面自动选择项目 B 的终端 B2。
7. URL 使用 replace 导航到 `/terminal/<B2>`。
8. 页面不会停留在 `/terminal`，不会选择项目 A 的第一个终端，也不会选择 B1。
   失败判定：
9. `/terminal` 首次加载后选择列表第一项。
10. 页面选择项目 B 但 active session 是 B1 而不是 B2。
11. 页面停留在 `/terminal` 且没有 active session。

### DRTS-004 路由指定有效 terminalSessionId 时优先使用路由而不是 recent selection

标签：terminal-route route-priority recent-selection playwright
步骤：

1. 准备 recent selection，使其指向项目 B 的终端 B2。
2. 直接打开 `/terminal/<A1>`，其中终端 A1 属于项目 A 并仍存在。
3. 等待页面加载项目和终端列表。
4. 用 `$playwright-cli` 读取 URL、项目按钮、终端 tab 和 localStorage。
   期望：
5. 页面保持或修正为 `/terminal/<A1>`。
6. 项目 A 被选中，active session 为 A1。
7. recent selection 随后更新为项目 A/A1。
   失败判定：
8. 页面忽略有效路由并跳回 recent selection 的 B2。
9. 项目 A 被选中但 active session 不是 A1。
10. recent selection 没有在稳定选择后更新为 A/A1。

### DRTS-005 同一项目下保留各自最近终端，切回项目时恢复该项目最近终端

标签：project-switch projectSessionIds recent-selection playwright
步骤：

1. 准备项目 A 下终端 A1/A2，项目 B 下终端 B1/B2。
2. 用 `$playwright-cli` 依次选择 A2、B2。
3. 确认 recent selection 的 `projectSessionIds` 同时包含 `{ A: A2, B: B2 }`。
4. 点击项目 A，再点击项目 B。
5. 每次点击后读取 URL、active tab 和 localStorage。
   期望：
6. 点击项目 A 后 active session 为 A2。
7. 点击项目 B 后 active session 为 B2。
8. 项目切换不会总是选择每个项目的第一个终端。
   失败判定：
9. 任一项目切换后 active session 变成该项目排序第一项。
10. `projectSessionIds` 被覆盖成只保留最后一个项目。
11. URL 与 active tab 指向不同终端。

### DRTS-006 recent selection 引用已删除终端时只在同项目内回退到可用终端

标签：deleted-session fallback recent-selection playwright
步骤：

1. 准备 recent selection，使其指向项目 B 的终端 B2。
2. 删除 B2，或确认后端 `GET /api/terminal/session` 不再返回 B2。
3. 保持项目 B 仍存在且有终端 B1，同时项目 A 排在项目 B 前。
4. 打开 `/terminal` 或通过桌面端重启加载终端工作台。
5. 用 `$playwright-cli` 读取 URL、项目按钮、终端 tab、API 响应和 localStorage。
   期望：
6. 项目 B 仍被选中。
7. active session 回退到 B1。
8. 页面不会跳到项目 A 的第一个终端。
9. URL replace 为 `/terminal/<B1>`。
   失败判定：
10. 引用的终端不存在时直接回到项目 A。
11. URL 保留不存在的 B2，导致空白或错误状态。
12. localStorage 持续指向已删除的 B2 且没有有效降级。

### DRTS-007 recent selection 引用已删除项目时回退到当前排序第一个项目和终端

标签：deleted-project fallback recent-selection playwright
步骤：

1. 准备 recent selection，使其指向项目 B/B2。
2. 删除项目 B，或确认后端 `GET /api/terminal/project` 不再返回项目 B。
3. 保持后端项目列表只剩项目 A，且项目 A 至少有终端 A1。
4. 打开 `/terminal` 或通过桌面端重启加载终端工作台。
5. 用 `$playwright-cli` 读取 URL、项目按钮、终端 tab、API 响应和 localStorage。
   期望：
6. 页面选择项目 A 和终端 A1。
7. URL replace 为 `/terminal/<A1>`。
8. localStorage 更新为项目 A/A1。
   失败判定：
9. 页面尝试显示已删除项目 B。
10. URL 保留 B2。
11. 没有可恢复的项目/终端时仍显示旧选择。

### DRTS-008 recent selection 缺失或损坏时允许回退到排序第一个项目和终端

标签：invalid-storage fallback compatibility playwright
步骤：

1. 删除 `localStorage["viewer.terminal.recent.<apiBase>"]`，或写入非法 JSON，或写入缺少字符串 `projectId` 的 JSON。
2. 准备项目 A、项目 B，且项目 A 排在项目 B 前；项目 A 下 A1 排在 A2 前。
3. 打开 `/terminal`，等待列表加载完成。
4. 用 `$playwright-cli` 读取 console、URL、项目按钮、终端 tab 和 localStorage。
   期望：
5. 页面选择项目 A 和终端 A1。
6. 页面写入新的 recent selection。
7. 页面不出现白屏、无限跳转或 JS error。
   失败判定：
8. 损坏 localStorage 导致页面报错。
9. active project 或 active session 为空。
10. 写入的 recent selection 仍是损坏内容。

### DRTS-009 不同后端连接的 recent selection 互相隔离

标签：connection-isolation apiBase recent-selection playwright computer-use
步骤：

1. 在桌面端配置连接 C1 和 C2，确保二者 apiBase 不同。
2. 在 C1 中让 recent selection 指向项目 B/B2。
3. 在 C2 中确认不存在项目 B/B2，且 C2 有自己的项目 X/X1。
4. 用 `$computer-use` 切换到 C2 并打开 `/terminal`，再切回 C1。
5. 用 `$playwright-cli` 读取不同 apiBase 对应 localStorage key、URL、DOM 和 API 响应。
   期望：
6. C2 不读取 C1 的 `viewer.terminal.recent.<apiBase>`。
7. C2 只选择 C2 内有效项目/终端。
8. 切回 C1 后仍恢复 C1 的 B/B2。
   失败判定：
9. C2 尝试打开 C1 的终端 id。
10. 切回 C1 后 recent selection 被 C2 覆盖。
11. 两个 apiBase 对应 localStorage key 发生串扰。

### DRTS-010 更新重启时后端暂未 ready 不应把有效 recent selection 覆盖成空或第一个终端

标签：backend-not-ready restart-timing recent-selection playwright computer-use
步骤：

1. 准备 recent selection，使其指向项目 B/B2。
2. 执行桌面端更新重启，让前端经历 loading 或短暂请求失败状态。
3. 等待后端随后恢复，确认项目 B/B2 仍存在。
4. 用 `$playwright-cli` 从 App 重启开始监听 network、console、localStorage 变化和最终 URL。
5. 用 `$computer-use` 确认桌面 App 最终回到终端工作台。
   期望：
6. 终端列表加载完成后仍恢复到 B/B2。
7. 请求失败期间不把 localStorage 改成 `terminalSessionId=null`、项目 A/A1 或其他错误值。
8. 页面在后端 ready 后能重试并进入稳定终端视图。
   失败判定：
9. 短暂失败后 recent selection 被覆盖，导致后端 ready 后进入第一个项目/终端。
10. 页面卡在错误态不重试。
11. console 出现与恢复选择相关的未处理异常。

## 覆盖清单

- 功能正确性：DRTS-001、DRTS-002、DRTS-003 覆盖核心恢复；DRTS-004 覆盖路由优先级；DRTS-005 覆盖每项目最近终端。
- 边界与异常：DRTS-006 覆盖终端删除；DRTS-007 覆盖项目删除；DRTS-008 覆盖缺失/损坏 localStorage；DRTS-010 覆盖后端迟到。
- 状态与时序：DRTS-001、DRTS-002、DRTS-010 覆盖重启/重连恢复；DRTS-005 覆盖项目切换状态迁移。
- 数据与协议：所有用例都通过 `GET /api/terminal/project`、`GET /api/terminal/session` 和 `viewer.terminal.recent.<apiBase>` 取证；不要求新增后端协议。
- 安全与权限：不覆盖鉴权失败。原因：本需求只改变已登录桌面端的选中项恢复；鉴权过期已有登录/连接流程处理。
- 并发：不覆盖多窗口同时写 recent selection。原因：桌面端当前主窗口为本需求目标；多窗口一致性需要单独定义产品契约。
- 幂等与去重：DRTS-001、DRTS-002 多次重启应得到同一结果；不要求新增 dedupeKey。
- 回归与兼容：DRTS-008 明确保留无 recent selection 时回退到第一个项目/终端的兼容行为。
- 可取证性：每条浏览器页面路径均要求 `$playwright-cli` 读取 URL、DOM、localStorage/API；桌面更新/退出/打开均要求 `$computer-use` 取证。

## 验收通过标准

必须同时满足：

- 必跑命令全部通过。
- DRTS-001 到 DRTS-010 的实际行为验证全部通过，且关键证据包含 URL、active 项目、active 终端、recent selection 内容。
- 有效 recent selection 存在时，桌面端更新重启、普通重启、直接打开 `/terminal` 都不会回到排序第一个项目/终端。
- 路由指定有效终端时，路由优先于 recent selection。
- recent selection 缺失、损坏、引用已删除对象时，只按本文档定义的降级路径回退，不产生白屏、无限跳转或错误覆盖。
