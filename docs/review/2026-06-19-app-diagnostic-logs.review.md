# App Diagnostic Logs 代码评审

日期：2026-06-19

范围：当前 live worktree 相对 `origin/main` 的改动，排除 `docs/review`。包含 App support logs 改为服务端 diagnostic logs 上报、backend diagnostic log 持久化、terminal tmux scroll 迁移到 `packages/common`、以及 `app/src/pages/LoginPage.tsx` 改动。

## 结论

仍存在 1 个 P1 问题，当前不建议进入 `human_verify`。主要风险是登录失败场景的诊断入口被移除。此前发现的 backend `/stop` 持久化失败覆盖日志风险、App 重载后上传全部 retained logs 风险，当前 staged 代码已加入幂等 stop 与 `startedAt` 恢复窗口处理。

## Findings

### P1 登录失败/未认证场景无法再上报 App 诊断日志

新的 App 日志上报依赖 `uploadTarget`，而 `uploadTarget` 只在 `session.isAuthenticated && session.accessToken` 时设置；未登录时 `SupportLogSheet` 直接提示“请先登录并连接本地电脑后再上报日志”。同时 `LoginPage` 删除了原来的“日志上报”按钮，当前只剩一个未使用的 `openSupportLogs` 解构。结果是用户名密码错误、auth API 异常、后端不可达、连接配置错误这些最需要登录页诊断的场景，用户无法从 App 内打开日志上报，也无法像旧实现那样本地分享/下载脱敏日志。

定位：`app/src/App.tsx:21`、`app/src/features/support-logs/SupportLogSheet.tsx:226`、`app/src/pages/LoginPage.tsx:38`

修复方向：保留登录页日志入口，并为未认证场景提供不依赖服务端 token 的本地导出/分享路径；或者明确新增一个 unauthenticated diagnostic flow，至少能导出登录页已有的 support log store 内容。若服务端上报必须认证，则登录页按钮应提示本地导出，而不是完全移除。

## 已复查项

- backend `/status` / `/start` 当前返回 `startedAt`，App 会用 backend 的 recording start 边界恢复上传窗口。
- `DiagnosticLogRecorder.stop()` 当前对重复 stop 做了幂等处理，已有 `latestResult` 时不会生成空结果覆盖本轮日志。
- App 在 stop 失败后会刷新 backend 状态，并提示可重试。

## 已检查命令

- `git diff --check origin/main -- . ':(exclude)docs/review'`：通过，无输出
- `pnpm typecheck`：通过
- `pnpm lint`：通过
- `pnpm --filter app typecheck`：通过

## 未执行

未执行浏览器/页面验证。本轮是 `$toolkit:review-only` 静态评审；如后续需要打开页面复现，必须按仓库约束使用 `$playwright-cli`。
