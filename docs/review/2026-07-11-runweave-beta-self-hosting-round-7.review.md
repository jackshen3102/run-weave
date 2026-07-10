# Runweave Beta 自举通道代码复审（round 7）

## 结论

`case_12` 通过。本轮未发现未修复的 P0/P1；round 6 阻断项“既有 Beta auth store 覆盖新 bootstrap credentials”已被修复。当前 round 5 遗留文件满足自动迁移判定，下一次 Beta 启动会在 backend 读取前统一三项凭据、清空不兼容 refresh sessions，并在 CLI 登录成功后删除临时 bootstrap，后续以 Beta auth store 为单一来源。

## 已解决 P1：持久化认证分叉可自动收敛

- Beta 显式把 `AUTH_STORE_FILE` 固定到独立 `browser-profile/auth-store.json`，不会读取 Stable store：`electron/src/main.ts:97-119`。
- `resolveBetaPackagedBackendAuthConfig()` 同时读取 persisted store 与 `backend-auth.json`；凭据不一致且 persisted 时间不晚于 bootstrap 时，调用原子迁移：`electron/src/main.ts:700-727`。
- 迁移以 `0600` 临时文件替换 store，更新 username/password/JWT secret 并清空旧 secret 对应的 refresh sessions：`electron/src/main.ts:670-698`。
- backend 启动 env 与 CLI 登录均调用同一 resolver；CLI 成功取得 token 后删除 bootstrap，因此后续重启只读取 persisted store：`electron/src/main.ts:793-825`、`electron/src/main.ts:836-865`、`electron/src/main.ts:1148-1171`。
- 当前遗留 `backend-auth.json` 与 `auth-store.json` 三项脱敏指纹仍不一致，但 `persisted.updatedAt=2026-07-10T17:43:19.838Z` 早于 `bootstrap.createdAt=2026-07-10T17:43:19.900Z`，只读判定为 `migrationDecision=true`；未读取或输出原始凭据。
- Stable 分支仍在完整 ambient `AUTH_*` 存在时沿用原行为，Beta 迁移函数不会被 Stable 调用：`electron/src/main.ts:836-857`。

## Remaining P2

### 1. 既有 tmux pane 在 backend 动态端口变化后仍可能保留旧 CLI 地址

`RUNWEAVE_BASE_URL` / `RUNWEAVE_BACKEND_PORT` 只在创建 tmux session 时注入，复用 session 不刷新；CLI 又优先采用 env 地址。新建 terminal 或复用同一端口不受影响。

- 定位：`backend/src/terminal/runtime-launcher.ts:203-225`、`packages/runweave-cli/src/config/profile-store.ts:135-158`

### 2. Beta 主窗口 CDP 固定端口缺少冲突降级

主窗口 CDP 固定监听 `127.0.0.1:9335`。status 会校验 listener PID 和 page target，不会误报健康，但端口被占用时更新只能等待超时并回滚。

- 定位：`electron/src/main.ts:91-104`、`scripts/runweave-beta.mjs:162-219`

### 3. auth store 迁移早于 orphan backend 回收，存在窄并发覆盖窗口

Electron 在构造 `baseEnv` 时先迁移 auth store，随后 `startPackagedBackend()` 才回收仍持有 profile 的 orphan backend。若旧 backend 恰在窗口内处理登录/刷新并由 LowDB 写回其内存中的旧 auth record，可能覆盖刚完成的迁移；新 backend 已读取旧 record 后，CLI 仍可能再次 401。正常更新回滚后的 Beta 进程已停止，不影响当前直接重试，但崩溃恢复路径建议把迁移放到取得 profile 独占权之后。

- 定位：`electron/src/main.ts:1148-1158`、`electron/src/backend-runtime.ts:447-485`、`electron/src/backend-runtime.ts:526-538`、`backend/src/auth/lowdb-store.ts:59-66`

## 验证

- 通过：`pnpm typecheck`（9 个 workspace 项目）。
- 通过：`pnpm lint`。
- 通过：`pnpm runweave:update:test-cases`（17 cases）。
- 通过：`pnpm runweave:beta:verify`（`ok=true`）。
- 通过：`node --check scripts/runweave-update.mjs`、`node --check scripts/runweave-beta.mjs`、`git diff --check`。
- 通过：当前 round 5 遗留认证文件的脱敏只读迁移判定（`matches=false`、`migrationDecision=true`）。
- 未重跑完整 RWB-001；本轮仅判定代码审查用例 `case_12`，真实桌面行为由后续 `behavior_verify` 执行。
