# Runweave Beta 自举通道代码复审（round 9）

## 结论

`case_12` 通过。本轮未发现未修复的 P0/P1。round 8 的 RWB-007 失败输出缺口已补齐：健康超时会保留最后一次 status 中的不健康组件，自动恢复后同时向 stderr 与本次 update log 输出故障组件、日志路径、上一 App/Runtime/App Server release、恢复状态和原始原因。

## 已解决：RWB-007 失败输出合同

- `BetaHealthError` 携带超时前最后一次 status 推导出的不健康组件；App Server 仅在本轮要求其健康时纳入判断：`scripts/runweave-beta.mjs:11-17`、`scripts/runweave-beta.mjs:522-555`。
- formatter 只选择诊断所需字段，输出 `component`、`unhealthyComponents`、绝对 `logPath`、三个上一 release、`recovery` 和 `reason`，未序列化 token、认证配置或完整 state：`scripts/runweave-beta.mjs:558-577`。
- shared updater 非零退出和后置健康超时两条失败路径都会先执行自动恢复，再把同一诊断写到 stderr 与权限为 `0600` 的 update log，并记录失败 state：`scripts/runweave-beta.mjs:391-416`、`scripts/runweave-beta.mjs:647-665`、`scripts/runweave-beta.mjs:694-718`。
- 独立同 realm formatter 探针输出了 `component=beta-update`、`unhealthyComponents=app-server`、`logPath=/tmp/update.log`、上一 App/Runtime/App Server release、`recovery=automatic-restore-applied` 和 `reason=health timeout`。
- round 8 的实际证据已证明恢复链路本身有效：Beta 回到 App `0.127.0`、Runtime `local-1783708419971`、App Server `local-app-server-1783708440601` 并恢复四项健康，Stable 全程未变化。

## Remaining P2

### 1. 仅 freshness 失败时组件诊断会退化为 `unknown`

`waitForHealthyBeta()` 同时要求 desktop status 时间不早于本轮开始，但超时后的组件列表只检查四个 `healthy` 布尔值。若旧进程和旧 status 仍显示全健康、唯一失败是 status 不够新鲜，`unhealthyComponents` 会是空数组，最终输出 `unknown`，不能指出 `desktop-status-stale`。

- 定位：`scripts/runweave-beta.mjs:522-555`、`scripts/runweave-beta.mjs:568`
- 修复方向：把 freshness 作为明确诊断维度，或在组件均健康但 `fresh=false` 时输出 `desktop-status-stale`。

### 2. 既有 tmux pane 在 backend 动态端口变化后仍可能保留旧 CLI 地址

`RUNWEAVE_BASE_URL` / `RUNWEAVE_BACKEND_PORT` 只在创建 tmux session 时注入，复用 session 不刷新；CLI 又优先采用 env 地址。

- 定位：`backend/src/terminal/runtime-launcher.ts:203-225`、`packages/runweave-cli/src/config/profile-store.ts:135-158`

### 3. Beta 主窗口 CDP 固定端口缺少冲突降级

主窗口 CDP 固定监听 `127.0.0.1:9335`。status 不会误报健康，但端口被占用时更新只能等待超时并回滚。

- 定位：`electron/src/main.ts:91-104`、`scripts/runweave-beta.mjs:170-227`

### 4. auth store 迁移早于 orphan backend 回收，存在窄并发覆盖窗口

若旧 backend 恰在迁移后、被回收前写回其内存中的旧 auth record，可能覆盖迁移并使崩溃恢复再次出现 CLI 401。round 8 的干净首启和普通更新已通过，不影响当前主路径。

- 定位：`electron/src/main.ts:1148-1158`、`electron/src/backend-runtime.ts:447-485`、`electron/src/backend-runtime.ts:526-538`、`backend/src/auth/lowdb-store.ts:59-66`

## 验证

- 通过：`pnpm typecheck`（9 个 workspace 项目）。
- 通过：`pnpm lint`。
- 通过：`pnpm runweave:update:test-cases`（17 cases）。
- 通过：`pnpm runweave:beta:verify`（`ok=true`，当前 Beta 四项健康）。
- 通过：`node --check scripts/runweave-beta.mjs`、`pnpm exec prettier --check scripts/runweave-beta.mjs`、`git diff --check`。
- 通过：同 realm formatter 合同探针。
- 未重跑 RWB-007 故障注入；本轮只判定代码审查用例 `case_12`，真实失败输出由后续 `behavior_verify` 验证。
