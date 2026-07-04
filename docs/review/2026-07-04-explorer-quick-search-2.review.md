# Explorer Quick Search 代码评审

## 检查范围

- 评审对象：当前 live worktree（`HEAD` vs 工作区），包含 quick search 的 shared 协议、backend 路由/搜索实现、frontend UI/hook、Playwright E2E，以及相关未跟踪新文件。
- 评审类型：代码评审；本次只读评审，未修改源码、配置、测试或计划文档。

## 发现

- **P1 严重：内容搜索把用户输入当正则，普通文本查询会失败。** `buildRgContentArgs()` 直接把 quick search 输入作为 `rg` pattern 传入，没有 `--fixed-strings` 或转义；因此用户搜索 `[`、`(`、`*`、部分路径/代码片段时会触发 ripgrep regex parse error，接口被包装成 500，搜索框显示失败而不是无结果/字面量匹配。定位：`backend/src/terminal/preview-content-search.ts:134`。修复方向：内容搜索默认按字面量搜索，给 `rg` 增加 `--fixed-strings`，或显式提供 regex 模式切换；补充特殊字符查询的 E2E/API 覆盖。

- **P1 严重：`rg --json` 的 match offsets 是字节偏移，当前按 JS 字符索引使用会导致多字节文本高亮和跳转列错误。** `submatches.start/end` 被直接用于 `lineText.slice()` 和 `column = start + 1`，但 ripgrep JSON 对 `中文abc` 中 `abc` 返回 `start=6,end=9`，不是 JS 字符索引 2/5；含中文、日文、emoji 等文件中，snippet 高亮会错位或为空，Monaco reveal column 也会偏移。定位：`backend/src/terminal/preview-content-search.ts:109`、`backend/src/terminal/preview-content-search.ts:128`。修复方向：在后端把 byte offsets 转成 JS/Monaco 可用的 UTF-16 列与 range，或保存原始 byte offsets 但在前端按 UTF-8 解码映射；补充多字节内容搜索用例。

- **P3 提示：快捷键说明在非 macOS 上显示错误。** 实际快捷键逻辑按平台在测试里区分 `Meta+P` / `Control+P`，但 UI footer 固定显示 `Cmd+P` 和 `Cmd+Shift+F`，Windows/Linux 用户会看到错误提示。定位：`frontend/src/components/terminal/terminal-preview-quick-search.tsx:369`。修复方向：根据平台显示 `Ctrl`/`Cmd`，或写成 `Cmd/Ctrl+P`、`Cmd/Ctrl+Shift+F`。

## 验证

- `git diff --check`：通过。
- `pnpm typecheck`：通过。
- `pnpm lint`：通过。
- `PLAYWRIGHT_HTML_OPEN=never pnpm --filter ./frontend exec playwright test frontend/tests/terminal-preview.spec.ts -g "terminal preview explorer quick search opens files content and folders"`：通过，1 个 Chromium 用例通过。
- `PLAYWRIGHT_HTML_OPEN=never pnpm --filter ./frontend exec playwright test frontend/tests/terminal.spec.ts -g "tmux terminal sessions render UTF-8 filenames"`：通过，1 个 Chromium 用例通过。
- 手工最小复现：`rg --json ... -- '[' file.txt` 返回 regex parse error / exit code 2，验证特殊字符查询会失败。
- 手工最小复现：`rg --json abc file.txt` 对 `中文abc` 返回 `submatches.start=6,end=9`，验证 offsets 是字节偏移。

## 残余风险

- 本次没有执行全量 `pnpm test` / 全量 Playwright E2E，只执行了与本 diff 直接相关的两条聚焦 E2E。
- 未启动真实桌面端联动验证；本 diff 的主要风险可由 backend/frontend/E2E 路径覆盖，但桌面端嵌入场景仍建议在修复 P1 后做一次手工冒烟。
