# Agent 技能说明与 App Build 信息评审

## 评审范围

- `AGENTS.md`
- `app/src/config/app-build-info.ts`
- `app/src/features/support-logs/SupportLogProvider.tsx`
- `app/src/features/support-logs/SupportLogSheet.tsx`
- `app/src/features/support-logs/support-log-types.ts`
- `app/src/vite-env.d.ts`
- `app/vite.config.ts`
- `package.json`
- `scripts/bump-app-version.mjs`

当前 worktree 还包含 App support log / build 信息相关改动和 `AGENTS.md` 改动；本次按 live diff 一并评审。

## 结论

未发现 P0/P1/P2 级别问题。

## 发现

- **P3 提示：浏览器和真机交互仍需后续验收**
  `AGENTS.md:34` 到 `AGENTS.md:38` 的技能路由说明与现有 `$playwright-cli` 强约束不冲突，`SupportLogSheet.tsx:254` 到 `SupportLogSheet.tsx:260` 也只是展示版本与 build 信息；但本轮只做静态评审、typecheck、lint，没有打开 App 页面确认 Ionic `IonNote slot="end"` 在窄屏下的展示效果，也没有执行真实“开始记录/结束并上报”流程。上线前建议按项目约束用 `$playwright-cli` 或 App 手工流程验证日志上报 sheet 中版本/build 信息可读，并确认上传后的 `details.appVersion` / `details.appBuildId` 出现在服务端日志 JSONL 中。

## 证据

- `computer-use` skill frontmatter 的 `name` 为 `computer-use`，`playwright-cli` skill frontmatter 的 `name` 为 `playwright-cli`；`AGENTS.md` 中使用的技能名成立。
- `SupportLogProvider.tsx` 将 `APP_VERSION` 和 `APP_BUILD_ID` 注入 `SupportLogDefaultContext`，`support-log-recorder.ts` 会把 default context 合并进每条 support log 的 `fields`。
- `toDiagnosticLogRecord()` 会把 support log `fields` 映射到 shared `DiagnosticLogRecord.details`，后端 recorder 的 normalize/redact 流程会保留普通 details 字段。
- `scripts/bump-app-version.mjs` 的 repo root 解析验证为 `/Users/bytedance/Code/browser-hub/browser-viewer/`，会定位到 `app/package.json`。

## 已执行检查

- `git diff --check -- AGENTS.md`
- `git diff --check -- . ':(exclude)docs/review'`
- `pnpm --filter @runweave/app typecheck`
- `pnpm --filter @runweave/app lint`

## 残余风险

- 未运行会写入 `app/dist` 的 App build，避免在 review-only 中产生额外产物。
- 未做浏览器/App UI 验收；如果该 diff 作为发布前 gate，仍需要补真实页面或设备侧验证。
