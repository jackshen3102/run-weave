# Browser Annotation Mode 代码评审

日期：2026-06-20

评审范围：13 个文件，+495 / -7 行，覆盖 shared 协议、Electron 注释引擎、preload IPC、backend prompt_paste 模式、前端 controller/UI/prompt 构造。

同时评审了设计计划文档 `docs/plans/2026-06-20-browser-annotation-mode.md`。

---

## 计划评审

### P3 提示：设计文档已落地，仍需补齐的条目可精简

计划文档 508 行，含大量已完成的逆向记录和备选方案。对于已经进入实现阶段的功能，建议把"仍需补齐"和"开放问题"精简为实际 TODO，删掉不再适用的备选方案描述，降低后续维护成本。

---

## 代码评审

### P1 严重

#### 1. 轮询 effect 依赖 `annotationTabId` 导致 IPC listener 反复注册/销毁

`use-terminal-browser-controller.ts:410-422` 中 `onTerminalBrowserAnnotationUpdated` 的 effect 将 `annotationTabId` 放在依赖数组中。每次 `annotationTabId` 变化（开始/停止/切 tab），effect 会卸载旧 listener 再注册新 listener，中间可能丢失事件。更关键的是，listener 闭包内通过 `annotationTabId === tabId` 过滤，但首次 start 时 `annotationTabId` 还是 `null`（state 更新是异步的），可能导致首条 annotation-updated 事件被忽略。

**影响**：注释模式刚启动时，BrowserView 侧发出的第一个 annotation-updated 可能被丢弃，导致前端 state 不同步。

**修复方向**：用 `useRef` 存储 `annotationTabId`，或把 listener 注册提到组件生命周期级别（不依赖 `annotationTabId`），在 listener 内通过 ref 判断。

#### 2. 750ms 轮询 `annotationList` 产生不必要的 IPC 开销

`use-terminal-browser-controller.ts:424-455` 在注释 active 期间以 750ms 间隔轮询 `terminalBrowserAnnotationList`。每次轮询都会 `executeJavaScript` 到 BrowserView 里取状态。但 annotation runtime 的变化（新增/删除 annotation）已经由用户操作触发，且 `onTerminalBrowserAnnotationUpdated` 已经可以推送状态。

**影响**：性能浪费；在弱设备上可能导致 BrowserView 卡顿。如果 runtime 内存状态与 Electron 侧 session map 不一致，轮询还可能覆盖掉更新鲜的 push 状态。

**修复方向**：移除轮询，完全依赖 IPC push（annotation-updated）。如果确实需要兜底，拉长到 5-10 秒。

#### 3. `closeTab` effect 依赖 `annotationTabId` 导致不必要的重建

`use-terminal-browser-controller.ts:379-387` 在 `closeTab` 的 `useMemoizedFn` 返回的 effect 中依赖了 `annotationTabId`。这意味着每次 `annotationTabId` 变化，`onTerminalBrowserTabClosed` listener 也会重注册。listener 只是清理逻辑，应该通过 ref 访问 `annotationTabId`，避免 effect 频繁重跑。

**影响**：tab-closed listener 频繁卸载/注册，可能丢失事件。

**修复方向**：用 ref 访问 `annotationTabId`，从 deps 中移除。

### P2 一般

#### 4. `clearTerminalBrowserAnnotation` fire-and-forget 没有等待 stop 完成

`electron/src/terminal-browser-annotation.ts:546-549`：`clearTerminalBrowserAnnotation` 用 `void stopTerminalBrowserAnnotation(key)` fire-and-forget 调用 stop。如果 `executeJavaScript` 抛异常或耗时较长，`sessions.delete(key)` 已经执行，后续 stop 回调找不到 session 会静默失败。这在 `did-navigate` 和 `did-navigate-in-page` 清理路径上可能导致页面内 annotation runtime 残留（DOM overlay 没被清理）。

**影响**：导航后页面内可能残留 annotation overlay DOM。

**修复方向**：先 `sessions.delete(key)` 再 `stopTerminalBrowserAnnotation`，或者改为 `await` 并包 try/catch。当前 `clearTerminalBrowserAnnotation` 是同步签名，调用方用 `void` 调用，建议改为 async 或只做 session map 清理，stop 由导航本身（页面重载）自然清理。

#### 5. `submitAnnotations` 中截图保存失败会导致 prompt 中 `screenshotPath` 为 null

`use-terminal-browser-controller.ts:593-600`：如果 `createTerminalSessionClipboardImage` 抛异常，整个 `submitAnnotations` 会走 catch 路径并显示错误，但用户的评论草稿已经被 `terminalBrowserAnnotationSubmit` 清掉了（annotation runtime 已 stop）。这意味着截图保存失败时，用户既丢失了草稿，也没有成功提交。

**影响**：截图保存失败 = 评论全部丢失，不可恢复。

**修复方向**：在调用 `terminalBrowserAnnotationSubmit` 之前先 `list` 获取当前 annotations 作为备份，或者把 submit 改为不自动 stop（先拿数据，成功发送后再 stop）。

#### 6. `prompt_paste` 模式的 `promptPasteSubmitKey` 变量声明与 `codexSlashSubmitKey` 重复

`backend/src/routes/terminal-input-dispatcher.ts:163-164`：`promptPasteSubmitKey` 的值与 `codexSlashSubmitKey` 完全相同（`agent_running ? "Tab" : "C-m"`），但声明了一个独立变量。当前没有场景需要两者不同。

**影响**：可维护性，多一个需要同步的变量。

**修复方向**：复用 `codexSlashSubmitKey` 或提取为共享的 `resolveSubmitKey()`。

#### 7. Bracketed paste 分块发送后立即发 submit key，可能在终端缓冲区未消化完时提交

`backend/src/routes/terminal-input-dispatcher.ts:104-113` `buildPromptPasteSequence` 把 `BRACKETED_PASTE_START + text + BRACKETED_PASTE_END` 按 3000 字符分块，然后追加一个 submit key。第一个 chunk 包含 `\x1b[200~` 前缀，最后一个 chunk 包含 `\x1b[201~` 后缀，中间 chunk 是纯文本。如果 tmux 的 `send-keys` 在多个 chunk 之间有竞争，中间 chunk 可能被终端误解释为非 paste 内容。

**影响**：超长 prompt（> 3000 字符）在 tmux 下可能被拆散，导致终端显示或解释异常。

**修复方向**：确认 `sendKeySequence` 是串行发送的；或者不分块，改用 `tmux load-buffer` + `paste-buffer`。

#### 8. Annotation runtime 注入未使用 Shadow DOM 或 CSS 隔离

`electron/src/terminal-browser-annotation.ts:116-196`：annotation overlay 直接 `document.createElement("div")` 挂到 `document.documentElement`，CSS 用全局 class。目标页面的 CSS reset（`* { box-sizing: border-box; margin: 0; }`）、`pointer-events` 覆盖、或高 z-index 元素可能干扰 overlay 显示。

**影响**：在 CSS 侵入性强的页面上（如 Tailwind preflight、各种 reset），annotation UI 可能显示异常。

**修复方向**：用 Shadow DOM 包裹 annotation root，隔离样式。计划文档中也提到了这个风险。

### P3 提示

#### 9. `buildAnnotationRuntimeScript()` 是 382 行的内联字符串，难以调试和维护

`electron/src/terminal-browser-annotation.ts:18-382`：整个 annotation runtime 作为一个模板字符串内联在 Electron 主进程代码中。没有 sourcemap、没有类型检查、没有 lint。后续修改和调试成本高。

**修复方向**：考虑把 runtime 提取为独立 `.js` 文件，通过 `fs.readFileSync` 加载或 esbuild 打包，获得独立的编辑和调试体验。

#### 10. 截图只截一张全 viewport 图，多条 annotation 共用同一张截图

`electron/src/terminal-browser-annotation.ts:527-544`：submit 时只 `capturePage()` 一次，所有 annotation 共用同一张截图。如果用户在不同滚动位置标注了多个元素，某些标注可能不在截图视口内。

**修复方向**：计划文档已标注为已知限制。后续可考虑每条 annotation 独立截图或截全页。

#### 11. `Check` 图标（Submit 按钮）语义不够明确

`terminal-browser-navigation-bar.tsx:173-201`：Submit 按钮用 `Check`（勾号）图标，和常规"确认/完成"含义有歧义。用户可能以为是"确认当前选择"而非"提交所有评论到终端"。

**修复方向**：可考虑 `Send` 或 `ArrowUpFromLine` 图标，或添加文字标签。

#### 12. `TerminalBrowserAnnotationSubmission.screenshot` 的 `mimeType` 硬编码为 `"image/png"` 联合类型

`packages/shared/src/terminal-browser-annotation.ts:37-39`：`mimeType: "image/png"` 作为字面量类型没问题，但如果后续支持 JPEG，需要改类型。当前可接受。

---

## 总结

整体实现完整度高，架构清晰，协议/IPC/UI/backend 链路完整。计划文档详尽。主要风险集中在：

1. **Effect 依赖管理**（P1）：IPC listener 和轮询 effect 的依赖数组包含可变 state，可能导致事件丢失和不必要的 re-subscribe。建议用 ref 模式。
2. **轮询 vs 推送**（P1）：750ms 轮询与 IPC push 并存，建议移除或大幅降频轮询。
3. **Submit 时草稿不可恢复**（P2）：截图保存失败会导致评论丢失，建议拆分 submit 和 stop。
4. **Bracketed paste 分块**（P2）：超长 prompt 的分块发送在 tmux 下有竞争风险。

无安全性阻断问题。`untrusted page evidence` 标记到位，页面内容与用户指令的边界在 prompt 中明确区分。

## 检查范围

- `packages/shared/src/terminal-browser-annotation.ts`（新增）
- `packages/shared/src/terminal-protocol.ts`
- `packages/shared/src/index.ts`
- `electron/src/terminal-browser-annotation.ts`（新增）
- `electron/src/terminal-browser-view.ts`
- `electron/src/preload.ts`
- `backend/src/routes/terminal-input-dispatcher.ts`
- `backend/src/routes/terminal-session-route-helpers.ts`
- `frontend/src/App.tsx`
- `frontend/src/components/terminal/terminal-browser-annotation-prompt.ts`（新增）
- `frontend/src/components/terminal/terminal-browser-navigation-bar.tsx`
- `frontend/src/components/terminal/terminal-browser-tool.tsx`
- `frontend/src/components/terminal/terminal-preview-panel-shell.tsx`
- `frontend/src/components/terminal/terminal-preview-panel.tsx`
- `frontend/src/components/terminal/terminal-workspace-shell.tsx`
- `frontend/src/components/terminal/use-terminal-browser-controller.ts`
- `docs/plans/2026-06-20-browser-annotation-mode.md`
