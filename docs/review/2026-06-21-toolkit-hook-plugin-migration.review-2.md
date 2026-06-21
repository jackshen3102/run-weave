# Toolkit Hook Plugin Migration 复审

## 结论

本轮复审未发现 P0/P1/P2 问题。上一轮指出的 Trae 插件级 hook 与全局 TOML hook 双注册风险已被修正：`installTraeHooks()` 当前只清理旧 TOML 条目，不再写入新的 Runweave TOML block。

## 评审范围

- 当前工作区实时 diff，包含 staged 文件和已加入索引的新增文件；`docs/review/2026-06-21-toolkit-hook-plugin-migration.review.md` 视为上一轮归档产物，不作为被评审实现的一部分。
- 重点文件：
  - `electron/src/hooks/hook-installer.ts`
  - `plugins/toolkit/hooks.json`
  - `plugins/toolkit/hooks/runweave-hook-dispatch.cjs`
  - `plugins/toolkit/hooks/runweave-hook-bridge.cjs`
  - `scripts/sync-toolkit-plugin.mjs`
  - `scripts/verify-toolkit-hooks.mjs`
  - `package.json`

## 发现

- **P3 提示：Codex 未标记旧 launcher 条目的回归覆盖还可以更直接**。当前实现会通过 `isRunweaveHookObject()` 按 `runweave-hook-bridge` / `browser-viewer-hook-bridge` 命令片段清理旧 hook（`electron/src/hooks/hook-installer.ts:1151`），不仅依赖 `_runweaveManaged`；但新增验证 fixture 主要覆盖了 `_runweaveManaged`、`browser-viewer-hook-bridge` 和旧 notify 脚本（`scripts/verify-toolkit-hooks.mjs:71`）。影响是未来如果清理逻辑收窄，未标记的 `~/.runweave/bin/runweave-hook-bridge --source codex` 旧条目可能缺少直接回归保护。修复方向：在验证脚本的 Codex hooks fixture 里补一条不带 `_runweaveManaged` 的 `runweave-hook-bridge --source codex`，并断言安装后被清理。

## 验证摘要

- `pnpm toolkit:verify-hooks`：通过。
- `git diff --check -- . ':(exclude)docs/review'`：通过。
- `pnpm typecheck`：通过。
- `pnpm lint`：通过。
- 手工检查本机实际插件缓存路径：
  - Codex 缓存路径可推断 `source=codex`。
  - Trae 缓存路径可推断 `source=trae`。

## 残余风险

- 未执行 `pnpm toolkit:sync`，因为该命令会重装本机插件并可能改动工作区/本机插件状态，不适合 review-only 模式。
- 未做浏览器操作验证；本次变更是 hook/插件/脚本路径，验证集中在脚本与类型/lint。
