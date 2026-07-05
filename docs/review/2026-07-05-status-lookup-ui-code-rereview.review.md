# Web Terminal 状态查询入口代码复审

## 结论

**Pass**。本轮复审未发现 P0/P1 阻断问题，`case_3` 通过。

实现已覆盖计划要求的主要链路：Web Terminal `More actions` 菜单新增 `状态查询`，dialog 支持 `Thread ID` / `Terminal ID` 查询、候选排序、详情展示和 `复制给 Agent`；backend 新增受保护的 App Server ThreadRef 查询代理，前端不直接接触 App Server token。

## 审查范围

- `docs/plans/2026-07-05-status-lookup-ui.md`
- `docs/testing/runbooks/status-lookup-ui.md`
- `backend/src/index.ts`
- `backend/src/routes/app-server-state.ts`
- `frontend/src/services/app-server-state.ts`
- `frontend/src/components/terminal/terminal-status-lookup-dialog.tsx`
- `frontend/src/components/terminal/terminal-workspace-shell.tsx`
- `frontend/src/components/terminal/terminal-history-drawer.tsx`
- `backend/src/routes/terminal-route-payloads.ts`
- `backend/src/terminal/*`
- `packages/shared/src/terminal-protocol.ts`

## 发现

### P2 一般：App Server stale/down 时代理可能返回 500 而不是 503（已修复）

`backend/src/routes/app-server-state.ts:88` 的 `requestAppServer()` 在 `discoverAppServer()` 找不到连接时会返回 503，但如果 lock/token 存在而 App Server 进程已退出，`fetch()` 会抛出网络异常，外层 catch 走 `next(error)`，最终可能变成 backend 500。计划要求 “App Server 未发现、不可用或 App Server 返回非 2xx：返回 503”。这不阻断主查询路径，但会让 stale App Server 场景下 UI 错误语义不稳定。

已在 `requestAppServer()` 内捕获 fetch 网络异常并返回 `new Response(null, { status: 503 })`。

## 已确认

- `backend/src/index.ts` 已在 `requireAuth` 后挂载 `/api/app-server` 状态代理。
- `backend/src/routes/app-server-state.ts` 只转发 ThreadRef 轻量状态，并用 App Server token 在后端侧访问 App Server；App Server 不可达时返回 503。
- `frontend/src/components/terminal/terminal-workspace-shell.tsx` 已新增 `状态查询` 菜单项并挂载 `TerminalStatusLookupDialog`。
- `frontend/src/components/terminal/terminal-status-lookup-dialog.tsx` 使用 `useMemoizedFn`，未引入 `useCallback`，且未展示 `Raw JSON` / `复制 JSON`。
- `Terminal ID` 查询按 `running -> starting -> failed -> idle -> completed -> unknown` 排序，同状态按 `updatedAt` 新到旧。
- `复制给 Agent` 生成的是排查指令文本，不是 JSON dump。

## 验证

- `pnpm --filter @runweave/shared typecheck`：通过。
- `pnpm --filter @runweave/backend typecheck`：通过。
- `pnpm --filter @runweave/backend lint`：通过。
- `pnpm --filter ./frontend typecheck`：通过。
- `pnpm --filter ./frontend lint`：通过。
- `pnpm app-server:verify-state-sync`：通过，输出 `app-server state sync verification passed`。
- `git diff --check -- backend frontend packages/shared docs`：通过。

未执行 Playwright：本轮是 `code_review` gate 复审；code pane 已在其 outbox 中提供浏览器验收证据，后续端到端行为仍由 `behavior_verify` 负责。

## Gate 结果

- `case_3`：pass。Code Review 未发现 P0/P1 阻断问题；仅保留 1 个非阻断 P2。
