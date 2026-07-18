# Terminal Browser 页面评论代码评审

## 结论

**不通过。** 未发现 P0；存在 2 个 P1、2 个 P2。类型检查、Lint 与静态格式门禁通过，但当前实现仍会在发送并发窗口中丢失未发送修改，并且不会真正保留多行评论格式。

## 评审范围

- 评审对象：当前工作区相对 `HEAD` 的全部未提交改动（16 个已跟踪文件，以及 `frontend/src/components/terminal/terminal-browser-annotations-panel.tsx` 和 `docs/prototypes/terminal-browser-annotations/` 下的新增文件）。
- 基线：`b13d801027f66484409ab2963eda467a655b4e11`（`feat: refine terminal worktree status and lifecycle reconciliation (#365)`）。
- 重点链路：BrowserView annotation runtime → Electron IPC/截图 → Renderer 草稿面板 → terminal `prompt_paste` → 成功清理/失败重试。
- 只读边界：除本报告外未修改源码、配置、测试或其他文档。

## 发现

### P1 严重：发送期间草稿仍可修改，成功后会把未进入发送快照的新修改一起清空

`submitTab` 在读取 Electron 快照后继续等待截图保存和 terminal 输入，成功后无条件停止整个 runtime（`frontend/src/components/terminal/use-terminal-browser-annotations.ts:50`、`:72`、`:101`、`:106`）。这段期间 UI 只禁用了发送按钮和“放弃全部”，列表的定位/编辑、删除和“继续添加”仍可用（`frontend/src/components/terminal/terminal-browser-annotations-panel.tsx:148`、`:166`、`:177`、`:202`、`:216`），BrowserView 中的 marker 也始终可编辑。于是用户在网络等待期间新增、编辑或删除的内容不会进入已经捕获的 `submission`，却会被成功回调的 `stop` 一并清掉；这与冻结记录要求的“发送中冻结本批次”相反（`docs/prototypes/terminal-browser-annotations/README.md:63`、`:75`）。修复方向：在 Electron/runtime 层建立真正的提交锁或版本化批次，发送开始时禁止所有草稿变更；只有当前 runtime 版本仍等于已发送快照时才整体清理，否则只归档该批次并保留后续修改。仅在 React 按钮上加 `disabled` 不足以阻止 BrowserView marker/edit 路径。

### P1 严重：多行 textarea 保存时仍通过 `trimText` 折叠全部换行

新建与编辑保存都调用 `trimText(input.value, 4000)`（`electron/src/terminal-browser-annotation-runtime.ts:382`、`:422`），而 `trimText` 会用 `\s+` 替换为单个空格。用户在新 textarea 中输入的换行因此只在编辑时可见，保存到面板和发给 Agent 的评论会静默变成单行，直接违背“普通 Enter 换行”和多行评论验收目标（`docs/prototypes/terminal-browser-annotations/README.md:82`、`:119`）。修复方向：把目标标签用的单行归一化与评论归一化拆开；评论只做首尾裁剪和长度限制，并保留内部换行（必要时只统一 `CRLF`）。

### P2 一般：编辑器高度从 52px 增到 104px，但边缘翻转仍按 56px 计算

新建评论编辑器的最小高度已改为 104px（`electron/src/terminal-browser-annotation-style.ts:44`），但 `showEditor` 仍向定位算法传入 56（`electron/src/terminal-browser-annotation-runtime.ts:267`、`:276`）。例如视口高 800px、点击 y=720px 时，算法会判断 56px 高度可以向下放置，实际 104px 编辑器底部会超出视口。修复方向：显示后读取编辑器真实 `getBoundingClientRect().height` 再定位，或至少让定位常量与 CSS 最小高度保持单一来源；textarea 可纵向 resize 时还应有视口内最大高度约束。

### P2 一般：旧原生菜单仍保留批量提交入口，绕过新面板的唯一提交心智

新面板新增了明确的 `Send N to Agent` 动作，但更多工具菜单仍把 `Submit Browser Comments` 作为可执行 action（`electron/src/terminal-browser-tool-menu.ts:56`），Renderer 也继续直接调用提交（`frontend/src/components/terminal/terminal-browser-navigation-bar.tsx:132`、`:171`）。因此批量发送并非原型定义的“只存在于评论面板”，用户仍可在选择/编辑上下文未收束时从原生菜单提交，继续保留两套入口和错误恢复心智。修复方向：删除原生菜单的 submit action/合同，或把该 action 改为仅打开评论面板，由面板承担确认与发送。

## 验证摘要

- `pnpm typecheck`：通过（9 个 workspace project）。
- `pnpm lint`：通过（9 个 workspace project）。
- `git diff --check`：通过。
- `pnpm --filter ./electron exec tsx -e '<build runtime + new Function>'`：通过，生成的注入脚本可被 JavaScript 解析（23565 bytes）。
- 未执行真实 Electron / Playwright 行为验收：本次是只读代码评审，未启动 Dev Session；因此发送并发、BrowserView 边缘定位和双入口行为仍需在修复后用真实 `terminal-browser` surface 验证。

## 残余风险 / 待确认项

- 当前方案已明确把导航/切 tab 草稿保护、滚动或布局变化后的 marker 重定位、整页/逐评论截图留到后续阶段；本次未把这些已声明边界升级为缺陷。
- 现有 `terminal-browser-core.testplan.yaml` 没有 Browser comments 的事务与多行输入案例。按仓库约束本次未新增测试文件，但修复后至少应在真实 Electron 路径覆盖：多行保存、发送中禁止变更、发送失败原样重试、成功只清理已发送批次、底部边缘输入框不溢出。
