# iOS App 首页与登录一期 Plan Review

Review target: `docs/plans/2026-06-08-ios-app-home-and-login.md`

Scope: plan-vs-current-code review only. Existing uncommitted App changes were inspected as current checkout context; no implementation correctness review was performed.

## Findings

### High: App auth client 标识不够具体，会导致 refreshToken 拿不到或刷新失败

Plan 多处写的是 App 请求“显式标识非 Web 客户端”，并依赖登录响应返回 `refreshToken`，刷新时也依赖 body 内的 refresh token。但当前后端只把 `x-auth-client: electron` 识别为非 Web 客户端；其他值，包括直觉上的 `ios`、`app`、`mobile`，都会按 Web 处理。Web 登录响应不会返回 `refreshToken`，刷新接口也会从 cookie 而不是 body 读取 refresh token。

这会直接打断 plan 的“登录后本地持久化 refresh token”和“启动时 refresh 后进入首页”路径。

Evidence:

- Plan 只说“非 Web 客户端”，没有固定 header 值：`docs/plans/2026-06-08-ios-app-home-and-login.md:49` to `docs/plans/2026-06-08-ios-app-home-and-login.md:51`.
- 当前后端只认 `x-auth-client === "electron"`，否则就是 `web`: `backend/src/routes/auth.ts:76` to `backend/src/routes/auth.ts:78`.
- 只有非 Web 分支返回 `refreshToken`: `backend/src/routes/auth.ts:176` to `backend/src/routes/auth.ts:199`.
- refresh 接口也只有 `electron` 分支从 request body 读 `refreshToken`: `backend/src/routes/auth.ts:202` to `backend/src/routes/auth.ts:244`.

Recommendation: plan 里明确 App 一期必须发送 `X-Auth-Client: electron`，或者把后端 client type 扩展为 `"web" | "electron" | "app"` 并同步修改认证 route、共享类型和测试。不要只写“非 Web 客户端”。

### High: 真机 iOS API 调用缺少 CORS/Origin 验证方案

Plan 已经识别到真机不能固定 `127.0.0.1`，但没有覆盖当前后端 CORS 的限制。Capacitor iOS WebView 发起跨源 HTTP 请求时通常会带 native/webview origin；当前 CORS 只自动允许 `http://localhost` 和 `http://127.0.0.1`，其他 origin 必须通过 `FRONTEND_ORIGIN` 显式配置。真机访问 LAN/IP 后端时，如果 origin 是 `capacitor://localhost` 或其他非 http localhost，登录页会在浏览器层被 CORS 拦截，甚至到不了 `/api/auth/login` 的业务错误处理。

Evidence:

- Plan 仅要求登录页保留 `apiBase`，没有要求配置/验证 CORS origin：`docs/plans/2026-06-08-ios-app-home-and-login.md:116` and `docs/plans/2026-06-08-ios-app-home-and-login.md:264`.
- 当前 CORS 默认只允许 configured origins 或 `http://localhost` / `http://127.0.0.1`: `backend/src/server/cors.ts:3` to `backend/src/server/cors.ts:31`.
- 允许 header 已包含 `X-Auth-Client` 和 `Authorization`，但 origin 不匹配时不会返回 `Access-Control-Allow-Origin`: `backend/src/server/cors.ts:19` to `backend/src/server/cors.ts:43`.
- 后端只从 `FRONTEND_ORIGIN` 读取 configured origins: `backend/src/index.ts:334` to `backend/src/index.ts:336`.

Recommendation: plan 增加 iOS 真机网络验收：确认 Capacitor 实际 Origin，配置 `FRONTEND_ORIGIN` 或扩展 CORS allowlist，并用真机/模拟器登录接口实际验证。不要只验证 App build。

### Medium: `/api/terminal/mobile/overview` 已存在，新增 `/api/app/home/overview` 的边界没有被论证

Plan 明确禁止调用 Web H5 移动页聚合接口，并新增 `/api/app/home/overview`。但当前代码里已有挂载在通用终端 router 下的 `GET /api/terminal/mobile/overview`，有共享类型和测试，并且已经实现“项目 + 终端 + 受限 live tail”的聚合。这不一定说明 plan 应该复用它；如果 App 需要一个不读 scrollback、只返回 title/status/lastActivityAt 的轻量接口，新增接口是合理的。但 plan 没有对已有接口做迁移/复用/弃用边界说明，容易让实现同时维护两个“移动首页 overview”，字段语义和性能策略分叉。

Evidence:

- Plan 禁止调用 Web H5 移动页专用聚合接口，并新增 App overview：`docs/plans/2026-06-08-ios-app-home-and-login.md:56` to `docs/plans/2026-06-08-ios-app-home-and-login.md:60`, `docs/plans/2026-06-08-ios-app-home-and-login.md:86` to `docs/plans/2026-06-08-ios-app-home-and-login.md:105`.
- 当前 router 已有 `GET /api/terminal/mobile/overview`: `backend/src/routes/terminal.ts:437` to `backend/src/routes/terminal.ts:455`.
- 该接口已有共享类型 `TerminalMobileOverviewResponse`: `packages/shared/src/terminal-protocol.ts:226` to `packages/shared/src/terminal-protocol.ts:235`.
- 该接口实现会为每个 session 读受限 tail，并有 1.5s timeout: `backend/src/routes/terminal-mobile-overview.ts:48` to `backend/src/routes/terminal-mobile-overview.ts:97`.
- 测试已覆盖它不会读完整 history、只读 live tail: `backend/src/routes/terminal.test.ts:962` to `backend/src/routes/terminal.test.ts:1014`.

Recommendation: plan 增加一节“为何不复用 `/api/terminal/mobile/overview`”。可选方案是：扩展现有接口支持 `includeTail=false` 和 App 字段；或明确新 `/api/app/home/overview` 是轻量 App contract，且现有 mobile overview 保持 H5/preview contract，不共享字段演进。

### Medium: `lastActivityAt` 更新策略有写放大风险，排序语义也不明确

Plan 要求在创建、输出追加、cwd/activeCommand 更新、退出时维护 `lastActivityAt`，并在测试里覆盖 `appendOutput()` 更新。当前 `appendOutput()` 是同步热路径，只追加内存 scrollback buffer 并批量 flush scrollback；如果实现时每个输出 chunk 都写低频 metadata JSON，会把高频终端输出变成大量 lowdb 写入，影响终端吞吐和 UI 响应。另一个问题是 plan 的验证项提到 `lastActivityAt 排序`，但当前 `listSessions()` 排序语义是手动 order 优先，否则按 `createdAt`，plan 没有说明 App overview 是否要覆盖这个排序。

Evidence:

- Plan 要求输出追加也更新 `lastActivityAt`: `docs/plans/2026-06-08-ios-app-home-and-login.md:207` and `docs/plans/2026-06-08-ios-app-home-and-login.md:213`.
- 当前 session record 没有 `lastActivityAt` 字段：`backend/src/terminal/store.ts:10` to `backend/src/terminal/store.ts:27`.
- 当前 `appendOutput()` 是同步方法，只更新内存 buffer 并调度 scrollback flush: `backend/src/terminal/manager.ts:446` to `backend/src/terminal/manager.ts:464`.
- 当前低存储层 metadata 写入是整库 enqueue/write，append scrollback 是单独 scrollback write queue: `backend/src/terminal/lowdb-store.ts:253` to `backend/src/terminal/lowdb-store.ts:347`.
- 当前 `listSessions()` 按 order/createdAt 排序，不按活动时间排序：`backend/src/terminal/manager.ts:470` to `backend/src/terminal/manager.ts:480`.
- Plan 测试要求包含 `lastActivityAt 排序`，但接口合同没有声明排序规则：`docs/plans/2026-06-08-ios-app-home-and-login.md:80` to `docs/plans/2026-06-08-ios-app-home-and-login.md:105`, `docs/plans/2026-06-08-ios-app-home-and-login.md:211` to `docs/plans/2026-06-08-ios-app-home-and-login.md:213`.

Recommendation: plan 明确 `lastActivityAt` 的写入策略和排序规则。建议内存中即时更新，持久化按 terminalSessionId 节流/合并，避免每个输出 chunk 写 metadata；App overview 的 session 排序如果要按活动时间，应只在该接口响应层排序，不改变 `TerminalSessionManager.listSessions()` 的既有语义。

## Notes

- Plan 的“不新增前端单测”与当前项目约束一致；后端新增 route/store 测试属于后端测试，不冲突。
- App 目前确实是占位页加主题 store，plan 对 App 独立页面/服务层的方向是合理的。
- No validation commands were run; this was a static plan review against the current checkout.
