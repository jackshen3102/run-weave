# Toolkit Hook Plugin Migration 评审

## 结论

当前 diff 不建议直接上线。Codex 旧全局 hook 清理方向基本成立，但 Trae 迁移到插件级 `hooks.json` 后，Electron 安装器仍会继续写入全局 `~/.trae/traecli.toml` Runweave hook，存在同一次 Stop 被插件 hook 和全局 TOML hook 双重上报的风险。

## 评审范围

- 当前工作区实时 diff，包含 staged、unstaged 和 untracked 文件。
- 重点文件：
  - `electron/src/hooks/hook-installer.ts`
  - `plugins/toolkit/hooks.json`
  - `plugins/toolkit/hooks/runweave-hook-dispatch.cjs`
  - `plugins/toolkit/hooks/runweave-hook-bridge.cjs`
  - `scripts/sync-toolkit-plugin.mjs`
  - `scripts/verify-toolkit-hooks.mjs`
  - 相关架构文档与 README

## 发现

- **P1 严重：Trae 插件级 hook 与全局 TOML hook 会并存，可能导致完成事件和通知双发**。本次变更在 `plugins/toolkit/hooks.json:27` 为 `Stop` 配置插件级 dispatcher，同时文档说明 `~/.trae/traecli.toml` 只作为历史兼容/清理层；但 `electron/src/hooks/hook-installer.ts:589` 仍调用 `installTraeHooks()`，该函数在 `electron/src/hooks/hook-installer.ts:817` 到 `electron/src/hooks/hook-installer.ts:824` 继续向 `~/.trae/traecli.toml` 写入新的 Runweave fenced block。后端 `backend/src/routes/terminal-completion.ts:125` 到 `backend/src/routes/terminal-completion.ts:151` 对通过 source gate 的 completion 请求会逐条记录，未看到按同一 Stop 做幂等去重的逻辑。因此 Trae 同时加载插件 hooks 与 TOML hooks 时，同一次 Stop 可能产生两次 desktop/Feishu 通知和两条 completion event。修复方向：如果 Trae 已迁到插件级，`installTraeHooks()` 应只清理旧 fenced/legacy Runweave TOML 条目并在有变更时写回，不再 upsert 新 block；验证脚本也应断言 TOML 不再包含 Runweave hook。

- **P2 一般：新增验证脚本在仓库现有依赖下无法直接运行，容易形成失效的验收资产**。`scripts/verify-toolkit-hooks.mjs:15` 直接从 `.mjs` 导入 `../electron/src/hooks/hook-installer.ts`，但根 `package.json` 没有 `tsx`、`ts-node` 或对应脚本；实测 `node scripts/verify-toolkit-hooks.mjs` 报 `ERR_UNKNOWN_FILE_EXTENSION ".ts"`，`pnpm exec tsx scripts/verify-toolkit-hooks.mjs` 也因 `tsx` 不存在失败。修复方向：把验证脚本接到仓库已有可运行方式，例如先使用已构建 JS、改成 TypeScript 编译可覆盖的脚本、增加明确 package script 和依赖，或拆出纯 JS 可导入的 hook 安装核心。

## 验证摘要

- `git diff --check -- . ':(exclude)docs/review'`：通过。
- `pnpm typecheck`：通过。
- `pnpm lint`：通过。
- `pnpm exec tsx scripts/verify-toolkit-hooks.mjs`：失败，仓库未安装 `tsx`。
- `node scripts/verify-toolkit-hooks.mjs`：失败，Node 无法直接导入 `.ts` 源文件。

## 残余风险

- 未做浏览器操作验证；本次评审对象是 hook 安装/插件脚本和后端上报链路，未涉及页面复现。
- 未执行 `pnpm toolkit:sync`，因为该命令会修改插件缓存/版本/可能变更工作区状态，不适合 review-only 模式。
