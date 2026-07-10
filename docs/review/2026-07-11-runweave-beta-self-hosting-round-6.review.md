# Runweave Beta 自举通道代码复审（round 6）

## 结论

`case_12` 不通过。round 6 已修复 Beta 新进程继承 Stable ambient `AUTH_*` 的问题，但仍有 1 个未修复 P1：已有 Beta `auth-store.json` 会覆盖新的 Beta backend credentials，导致失败后的直接重试继续出现 CLI login 401。

## P1：持久化 auth store 未与 Beta backend-auth 迁移对齐

round 6 把 Beta backend 的启动 env 固定到 `backend-auth.json`，方向正确；`ensureBetaCliProfile` 也读取同一文件。但 backend 启动后，`LowDbAuthStore.initialize()` 只在 store 为空时采用 env 默认值，已有 auth record 会原样返回；`createRuntimeServices()` 随后使用这个 persisted record 创建 `AuthService`。

因此，round 5 失败时已经写入的旧凭据不会被 round 6 修复覆盖：backend 实际认证仍使用旧 auth store，CLI 登录仍提交 `backend-auth.json` 中的新凭据，401 会继续发生。只有手工删除 Beta userData 才会绕过该问题，这不满足失败后可直接重试和自恢复的目标。

- 定位：`electron/src/main.ts:637`、`electron/src/main.ts:687`、`backend/src/index.ts:160`、`backend/src/auth/lowdb-store.ts:25`
- 当前实证：`~/Library/Application Support/Runweave Beta/backend-auth.json` 与 `browser-profile/auth-store.json` 均存在，username/password/jwtSecret 三项脱敏 SHA-256 指纹全部不一致；两个文件均由 round 5 失败启动在 01:43 创建。
- 修复方向：Beta 启动前应检测专属 auth store 与 `backend-auth.json` 是否一致；不一致时原子重置/迁移 Beta auth record 并撤销不兼容 refresh sessions，或消除双份凭据源。不得要求用户手工删除 userData。

## 已解决

- Beta backend 不再继承 Stable terminal 的完整 ambient `AUTH_*`；Stable 仍保持原解析行为。
- round 4 的首启顺序和主窗口 CDP 修复仍有效。
- CLI 独立 config、dirty worktree 部署快照、Stable updater 边界和 Stable App Server 顺序均未回归。

## Remaining P2

### 1. 既有 tmux pane 在 backend 动态端口变化后保留旧 CLI 地址

既有 shell 不会随 backend 新端口刷新 `RUNWEAVE_BASE_URL`，且该 env 优先于 CLI profile；新建 terminal 或复用同一端口不受影响。

- 定位：`backend/src/terminal/runtime-launcher.ts:203`、`packages/runweave-cli/src/config/profile-store.ts:148`

### 2. Beta 主窗口 CDP 固定端口缺少冲突降级

主窗口 CDP 固定监听 `127.0.0.1:9335`；端口被占用时 status 会正确拒绝误判，但更新只能等待超时并回滚。

- 定位：`electron/src/main.ts:91`、`scripts/runweave-beta.mjs:162`

## 验证

- 通过：Electron、frontend、backend、CLI、shared typecheck。
- 通过：`pnpm lint`。
- 通过：`pnpm runweave:update:test-cases`（17 cases）。
- 通过：`pnpm runweave:beta:verify`。
- 通过：两个 updater 脚本 `node --check` 与 `git diff --check`。
- 通过：Beta terminal 环境下 Stable dry-run 仍全部指向 Stable。
- 失败证据：当前 Beta backend-auth 与 persisted auth store 的三项脱敏指纹全部不一致，且源码明确保留 persisted record。

本轮未重跑完整 RWB-001；真实行为验收应在 P1 修复后由 `behavior_verify` 执行。
