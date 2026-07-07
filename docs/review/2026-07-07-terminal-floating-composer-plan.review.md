# Terminal Floating Composer 计划审查

## 结论

Pass。计划范围清晰、文件落点明确，实施顺序能从 helper、emulator、surface props、状态机、layout UI 到命令和 Playwright 验收形成闭环。没有发现 P0/P1 阻断问题。

## 检查范围

- 计划文件：`docs/plans/2026-07-07-terminal-floating-composer.md`
- 配套用例：`docs/testing/terminal-floating-composer-test-cases.md`
- 关键源码落点：
  - `frontend/src/components/terminal/terminal-surface.tsx`
  - `frontend/src/components/terminal/terminal-surface-layout.tsx`
  - `frontend/src/components/terminal/use-terminal-emulator.ts`
  - `frontend/src/components/terminal/terminal-workspace-shell.tsx`
  - `packages/common/src/terminal/terminal-scroll.ts`
  - `packages/shared/src/terminal-protocol.ts`

## 发现

- P3 informational：复用已有 `TerminalBottomState` 类型。计划第 176-187 行写成在 `TerminalSurface` 侧定义 `TerminalBottomState`，但 `packages/common/src/terminal/terminal-scroll.ts:13-21` 已经导出同名结构和 `getTerminalBottomState(...)`。实现时应优先复用 common 导出，避免重复定义造成后续漂移。

- P3 informational：supported TUI allowlist 与实际验收环境需要收敛。计划第 378-382 行要求每个 supported TUI 都有 Playwright 验收，而测试用例第 349-352 行允许环境缺少 Trae/Claude 时不适用，并只硬性要求 Codex 真实取证。实现阶段建议把首期实际启用范围收敛到能取证的 Codex；Trae-family / Claude 若无法稳定启动和识别，应先保持不启用或在验收中明确不适用，避免 allowlist 先于证据扩大。

## 更简单方向

更短路径是首期只把 floating composer 对 Codex TUI 打开，同时保留 helper 的 allowlist 结构，等 Trae-family / Claude 有稳定 `activeCommand` 与本机 Playwright 取证后再启用。这样减少环境依赖和 replay 兼容性风险；代价是首期覆盖面小于计划文案中的完整 supported TUI 范围。

## 验收闭环判断

- `plan_case_1`：Pass。计划限定 Web desktop terminal，列出不覆盖 App/mobile/Electron/后端协议；实施顺序覆盖新增 helper、emulator callback、workspace props、surface 状态机、layout UI 和最终验证；测试文档提供 TFC-001 至 TFC-012，并有通过标准。
- `plan_case_2`：Pass。计划没有要求新增单测/TDD，没有引入后端 API、协议、storage、App terminal 或 Electron 打包改动；验证方式使用 `pnpm --filter ./frontend typecheck`、`pnpm --filter ./frontend lint`、`git diff --check` 和 `$playwright-cli`，与仓库约束一致。
