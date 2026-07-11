# Runweave Dev Session Loop Round 17 代码复审

## 结论

`case_24` 通过。本轮未发现仍未修复的 P0/P1。Round 16 的 DVS-020 manifest/Beta status 身份矛盾已按根因修复：Dev Session 在读取 Beta 状态时，先对实例资源边界和完整 runtime identity 做严格 reconciliation；合法 update/rollback 产生的新 PID、service identity 与 revision 会写回 manifest，任何 session、instance、路径、endpoint、lock、health 或进程身份不匹配仍保持 fail-closed。

存在一项非阻断 P2：`scripts/dev-session/services.mjs` 当前未通过 Prettier 检查。

## 复审依据

- `scripts/dev-session/services.mjs:331-378` 只从 dedicated Beta manifest 的 instance、devSessionId、userData、control cwd 和两个 loopback CDP endpoint 反解 Beta paths，并要求 App、status、userData 与端口精确回到原资源边界。
- `scripts/dev-session/services.mjs:380-559` 要求 Beta Desktop、Backend、App Server 与两个 CDP surface 全部 healthy；同时校验 profile/home、lock、serviceInstanceId、devSessionId、revision、PID 和协议能力，全部匹配后才刷新动态服务身份。
- `scripts/dev-session/services.mjs:1929-2014` 在 reconciliation 后继续执行原有 Backend/App Server/Electron/process identity handshake；`resolveOpenTarget()` 从本次严格检查后的服务视图返回当前 endpoint、PID 与 revision。
- `scripts/dev-session/cli.mjs:263-307` 对 ready 或旧 stale Beta 执行检查；成功时原子持久化当前 services/source、恢复 ready 并清除旧 failure，失败仍生成原 stale recovery。
- dedicated 与 shared 边界未混淆：dedicated Backend/App Server 会刷新动态进程身份；shared 服务保留原 manifest identity，并在后续原有 handshake 中继续严格验证。

## Findings

### P0/P1

无。

### P2

- **P2 open — 本轮目标文件未通过 Prettier。** `pnpm exec prettier --check scripts/dev-session/services.mjs scripts/dev-session/cli.mjs` 报告 `scripts/dev-session/services.mjs` 存在格式差异；差异包含本轮新增 import、CDP port 解析和同文件相邻既有改动。建议代码 pane 在下一次提交前对该目标文件执行项目 Prettier。

### 已修复

- **P1 resolved — 合法 Beta update/rollback 后 manifest 保留旧进程身份并误判 stale。** 严格 Beta reconciliation 在资源边界与 runtime identity 全匹配后刷新 Desktop/Backend/App Server/frontend/CDP 的 PID、revision、service identity 与 process signature。
- **P1 resolved — rollback 丢失实例 launch env，Backend 回退默认 profile。** 实例 executable 直启与 baseline revision 环境恢复保持有效。
- **P1 resolved — 空 shared App Server PID 阻断实例 lock PID fallback。** 正整数 PID 与旧状态 lock fallback 保持有效。

## 验证证据

- 独立真实监听正向 fixture：旧 manifest PID 全部过期，但当前 Beta Desktop/Backend/App Server、lock、health 和双 CDP 身份一致；结果为 `reconciled=true`、`stale=false`，三类 PID 与 revision 全部刷新。
- 同 fixture 仅把 manifest devSessionId 改为其他 Session；结果为 `reconciled=false`、`stale=true`，证明未按“端口健康”宽松接管。
- `pnpm dev:session:verify`：21 项 checks 全部通过。
- `pnpm runweave:update:test-cases`：18 项全部通过。
- `pnpm runweave:beta:verify`、`pnpm typecheck`、`pnpm lint`、目标 ESLint、Node syntax 与 `git diff --check -- . ':(exclude)docs/review'`：全部通过。
- 目标 Prettier：失败，仅构成上述非阻断 P2。

## 残余验证边界

本轮是只读代码复审，没有替代后续 `behavior_verify` 对 DVS-020 的真实双 Beta update/rollback、`dev:status → dev:open`、Playwright attach、stop 和 Stable 不变性复验。该运行时复验属于后续验收，不构成当前未修复的 P0/P1。
