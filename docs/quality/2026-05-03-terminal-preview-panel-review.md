# Terminal Preview Panel Review

日期：2026-05-03

范围：

- `frontend/src/components/terminal/terminal-preview-panel-content.tsx`
- `frontend/src/components/terminal/terminal-preview-panel-shell.tsx`

## Architecture / Strategy Findings

### P3 - 目录树逻辑内联到大组件，后续边界会继续变重

当前决策：在 `terminal-preview-panel-content.tsx` 内直接实现 `buildChangeTree`、递归渲染、折叠状态和 diff 预览渲染。

系统层面风险：`TerminalPreviewPanelContent` 已同时承担文件预览、Markdown/SVG/Image 预览、diff 预览、Git 变更导航、目录树状态。这个仓库前端正式验证偏 E2E，不补前端单测，树构建的边界场景会比较难被低成本覆盖。

更好的候选方案：把变更树拆成纯展示组件，例如 `TerminalChangeTree`，输入仍是当前 `staged/working` flat list，不引入新状态源。更简单的候选方案是保留 flat list，只优化宽度和 basename/dirname 展示。

迁移风险：拆分本身风险低，但不要顺手改 preview-store 或后端协议；先保持现有 props 和交互语义不变。

## Code / Implementation Findings

### P2 - 文件路径和目录路径冲突时，变更项会被覆盖丢失

风险：`buildChangeTree` 假设某个 segment 不是目录就可以被新目录覆盖。Git 状态里存在真实场景：一个文件 `a` 被删除，同时新增目录下文件 `a/b.ts`。当前逻辑先把 `a` 放成 file，后处理 `a/b.ts` 时会发现 existing 不是 directory，然后用 directory 覆盖原 file，导致 `a` 这条删除变更从 UI 消失。

证据：

- `frontend/src/components/terminal/terminal-preview-panel-content.tsx:216`
- `frontend/src/components/terminal/terminal-preview-panel-content.tsx:228`

修复方向：树模型需要支持同名 file/dir 冲突，或者在冲突时把文件节点保留为特殊 child，例如显示 `a` 文件和 `a/` 目录两个独立节点。至少要用真实 Git 场景做一次 E2E/手工回归：删除文件 `a`，新增 `a/b.ts`，确认两条变更都可选择和打开 diff。

### P3 - 目录折叠状态缺少可见状态与 ARIA 状态

风险：目录按钮没有 `aria-expanded`，而 chevron 默认 `opacity-0`。目录折叠后，非 hover/focus 状态下用户很难判断这是“空目录/折叠目录/普通目录”，键盘和读屏路径也不清晰。

证据：

- `frontend/src/components/terminal/terminal-preview-panel-content.tsx:313`
- `frontend/src/components/terminal/terminal-preview-panel-content.tsx:325`

修复方向：目录按钮增加 `aria-expanded={!collapsed}`；chevron 保持低可见度而不是完全隐藏，或者仅 hover 提升透明度。这个改动不需要引入新组件。

### P3 - “Read only” 可见提示被移除，预览面板意图变弱

风险：原 header 有显式 `Read only`，当前 preview header 只显示 mode tab 和项目名。这个面板包含文件内容、diff 和预览，移除只读提示会让用户更难判断这里是否会修改文件，尤其是未来如果加入更多 preview 操作。

证据：

- `frontend/src/components/terminal/terminal-preview-panel-shell.tsx:176`

修复方向：如果空间紧张，可以保留更轻量的只读标识或放在 selected path 行，而不是完全删除。

## Verification

已执行：

- `git status --short --branch`
- `git diff --stat`
- `git diff --check`
- `pnpm exec eslint frontend/src/components/terminal/terminal-preview-panel-content.tsx frontend/src/components/terminal/terminal-preview-panel-shell.tsx`

结果：`eslint` 和 `diff --check` 未报错。未执行会改写产物或缓存的命令。由于这是前端 UI 改动，剩余风险主要需要 Playwright E2E 或手工浏览器回归覆盖。
