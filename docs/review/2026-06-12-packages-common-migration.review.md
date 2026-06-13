# packages/common 迁移 review

日期：2026-06-12

范围：当前工作区未提交变更，重点覆盖新增 `packages/common`、App/Web/terminal-renderer 对 terminal utilities 的迁移，以及计划文档 `docs/plans/2026-06-12-packages-common-migration.md`。

## 架构 / 策略发现

### P3：`common` 的浏览器前端边界主要依赖计划文档，包自身约束偏弱

- 当前决策：新增通用包名为 `@runweave/common`，并从根导出 `.` 与 `./terminal`，但包内实际依赖 DOM 类型，语义上只服务 App/Web 前端公共层。
- 为什么它在系统层面可能是错的：计划明确说 `packages/common` 不替代 `packages/shared`，只放 App/Web 前端公共层代码；但包名和根导出都很宽，未来容易把 backend/electron/CLI 共享协议、App-only UI helper 或 Web-only terminal 行为误迁进去，逐步制造第二个“shared”。这不是当前实现 bug，但会增加长期边界漂移风险。
- 证据：
  - `docs/plans/2026-06-12-packages-common-migration.md:5` 说明 common 只应接收 App/Web 都复用的前端组件、样式或浏览器端纯逻辑。
  - `docs/plans/2026-06-12-packages-common-migration.md:7` 说明 `packages/shared` 才负责跨 backend/frontend/app/electron/CLI 的协议与 DTO。
  - `packages/common/package.json:2` 使用宽泛包名 `@runweave/common`。
  - `packages/common/package.json:9` 到 `packages/common/package.json:12` 暴露根导出和 `./terminal` 子路径。
  - `packages/common/tsconfig.json:3` 到 `packages/common/tsconfig.json:7` 引入 DOM lib，实际边界是浏览器前端。
- 更好的候选方案：
  1. 轻量方案：保留包名，但在 `packages/common` 下增加短 README/AGENTS 边界说明，并约定只从明确子路径导入；后续新增导出必须能列出 App/Web 双边调用方。
  2. 更强方案：将根导出收窄为空或仅保留显式子路径，例如 `@runweave/common/terminal`、`@runweave/common/styles/*`，避免 `@runweave/common` 成为杂物入口。
  3. 平台/工具链方案：如果后续频繁漂移，可用 lint/import rule 限制 backend/electron/CLI 不能依赖 `@runweave/common`，并要求新增 common 导出经过 allowlist。
- 迁移/过渡风险：轻量文档方案成本最低但依赖人工遵守；收窄根导出会产生 import 调整成本；lint allowlist 增加维护成本，但能在 CI 阶段阻断错误依赖。当前阶段建议采用轻量方案或至少在提交说明中明确边界，不建议现在扩大迁移范围。

## 代码 / 实现发现

未发现 P1/P2/P3 级别的代码实现问题。

已核对：

- `fileToBase64`、`shellQuote` 已从 App/Web 原重复实现迁入 `@runweave/common/terminal`，调用方包括 `app/src/pages/AppTerminalPage.tsx:6`、`frontend/src/components/terminal/use-terminal-emulator.ts:2` 到 `frontend/src/components/terminal/use-terminal-emulator.ts:7`。
- `isTerminalAutoResponse`、`isShiftEnterLineFeed` 已由 Web 旧路径和 `packages/terminal-renderer` 共同复用，调用方包括 `frontend/src/components/terminal-page.tsx:2` 到 `frontend/src/components/terminal-page.tsx:5`、`packages/terminal-renderer/src/TerminalRenderer.tsx:8` 到 `packages/terminal-renderer/src/TerminalRenderer.tsx:11`。
- `TerminalRenderer` 组件和 `terminal-renderer.css` 未迁入 common，符合计划中“阶段 1 不拆 renderer/CSS owner”的边界。
- `rg` 未发现旧 `terminal-input-assets` / `terminal-surface-utils` 中被迁移函数的残留调用。

## 验证

已运行并通过：

- `git diff --check -- . ':(exclude)docs/review'`
- `pnpm --filter @runweave/common typecheck`
- `pnpm --filter @runweave/terminal-renderer typecheck`
- `pnpm --filter @runweave/app typecheck`
- `pnpm --filter @runweave/frontend typecheck`

## 剩余风险 / 测试缺口

- 本次未做浏览器交互验证；评审范围是代码与类型检查。若要验证 terminal 输入、Shift+Enter、粘贴图片、auto-response 过滤等运行时行为，必须按仓库约束使用 `$playwright-cli`。
- `packages/common/node_modules/` 当前被 git ignore，未进入待提交变更；提交前仍建议确认只提交 package 源码、package.json、lockfile 和计划/报告等预期文件。
