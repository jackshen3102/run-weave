# Web 终端日志上报菜单计划审查

- verdict: approved
- plan_readiness: 可进入 human_plan_approval

## findings

- P2 一般：E2E 的剪贴板断言需要更明确的实现约束。计划在 `docs/plans/2026-06-20-web-terminal-log-report-menu.md:201` 要求断言 clipboard 内容，但没有说明使用 Playwright 权限、secure context 或 mock `navigator.clipboard`。这不会阻断计划进入人工审批，code_agent 实施时应补齐稳定的剪贴板验证方式。
- P3 提示：测试文件选择建议收敛到独立 spec。计划在 `docs/plans/2026-06-20-web-terminal-log-report-menu.md:129` 允许复用 `terminal-preview.spec.ts`，但 `docs/plans/2026-06-20-web-terminal-log-report-menu.md:131` 又建议独立 spec；为避免扩大 Preview 用例职责，实施时优先新增 `frontend/tests/terminal-diagnostic-logs.spec.ts`。

## evidence

- `AGENTS.md:13`-`20`：确认 `packages/shared` 承载跨端协议/DTO，计划把 `DiagnosticLogStatusResponse` 放入 `packages/shared` 符合边界。
- `AGENTS.md:49`-`54`：确认不得新增非 E2E 测试，计划仅新增 `frontend/tests/*.spec.ts` Playwright E2E 并配合 `typecheck`/`lint`。
- `backend/src/routes/diagnostic-logs.ts:32`-`45`：现有 `/status`、`/start` 已返回 `startedAt`。
- `backend/src/routes/diagnostic-logs.ts:48`-`60`：现有 `/stop` 合并前端日志并调用 `persistLatestResult()`，符合复用已有接口的目标。
- `packages/shared/src/diagnostic-logs.ts:1`-`30`：共享类型已有记录、状态、结果和 stop request，但缺少 status/start response 类型，计划补齐合理。
- `frontend/src/services/diagnostic-logs.ts:14`-`38`：Web service 当前把 status/start 响应窄化成 `{ status }`，计划修正为共享 response 可执行。
- `app/src/services/diagnostic-logs.ts:31`-`34`：App 当前本地重复定义 `DiagnosticLogStatusResponse`，迁到 shared 不改变行为。
- `app/src/features/support-logs/SupportLogSheet.tsx:139`-`216`：App 已有开始记录、结束并上报、展示/复制 `logsJsonl ?? dir` 的参考实现。
- `frontend/src/components/diagnostic-log-entry.tsx:105`-`259` 和 `421`-`467`：Web 现有入口是固定浮窗并复制格式化日志正文，计划增加 dialog variant 和服务端路径复制补齐了用户目标。
- `frontend/src/components/terminal/terminal-workspace-shell.tsx:762`-`811`：右上角工具栏已有非移动端 Preview/Orchestrator/History 图标入口，计划在 History 后加入 More actions 位置清晰。
- `frontend/src/components/ui/dropdown-menu.tsx:1`-`83`：项目已有 DropdownMenu primitives，可复用。

## notes_for_orchestrator

- 可进入 `human_plan_approval`。
- 后续 code_agent 应保持计划的前端为主范围：不新增后端接口、不改 APP 行为、不引入 `packages/common` 根导出或不真实复用的 common 迁移。
- 浏览器操作验证本轮未执行，因为当前阶段是计划审查；若后续做浏览器验证，必须使用 `$playwright-cli`。
