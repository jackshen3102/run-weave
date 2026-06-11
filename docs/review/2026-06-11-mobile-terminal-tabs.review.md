# 2026-06-11 Mobile Terminal Tabs Review

## 评审范围

- 当前分支：`feat/agent`
- 评审对象：App 端 terminal detail 的 `Chat / Changes / Files` tabs、preview service 封装、移动端 changes/files UI、相关计划文档。
- 只读检查：
  - `git diff --check -- . ':(exclude)docs/review'`：通过，无输出。
  - `pnpm --filter @runweave/app typecheck`：通过。

## 架构 / 策略发现

### P2 App 侧重新实现 preview 的安全与生命周期内核，后续会和 Web preview 分裂

当前决策：

- App 新增自己的文件类型判断：`app/src/lib/terminal-file-format.ts:1-87`。
- App 新增自己的 Markdown 预览器：`app/src/components/TerminalFilePreviewDrawer.tsx:40-209`。
- App 新增自己的 changes/files 请求状态管理：`app/src/components/TerminalChangesTab.tsx:149-231`、`app/src/components/TerminalFilesTab.tsx:171-249`。
- Web 侧已有相同领域的关键内核，例如文件类型判断在 `frontend/src/features/terminal/preview-file-types.ts:1-47`，Markdown 安全渲染在 `frontend/src/components/terminal/terminal-markdown-preview.tsx:49-119`，请求序号防陈旧结果在 `frontend/src/components/terminal/use-terminal-preview-panel-data.ts:105-107`、`frontend/src/components/terminal/use-terminal-preview-panel-data.ts:159-235`、`frontend/src/components/terminal/use-terminal-preview-panel-data.ts:239-308`。

为什么这是系统层面的风险：

- 计划里明确不搬 Web 的桌面分栏、Monaco、`react-complex-tree`，这个方向是对的；但当前实现把不能搬的 UI 和应该复用的领域内核一起分叉了。
- 结果已经出现差异：Web Markdown 会校验链接协议，App Markdown 不校验；Web 请求会丢弃陈旧响应，App 请求不会。以后每次 preview 能力修安全、文件类型、错误映射、请求竞态，都需要双份维护。

更好的候选方案：

- 推荐方案 A：抽出平台无关的 `preview-core` 或 App/Web 共用 hooks，只放文件类型、错误映射、Markdown 链接/资源解析、请求序号/AbortController、preview API client；App 保留移动端列表和布局。
- 可选方案 B：不抽完整 hooks，只先复用 Web 已有纯函数和安全渲染策略，例如文件类型判断、Markdown link validation、request-id guard 模式，避免把 Monaco/tree 依赖带进 App。
- 不推荐方案：继续让 App/Web 各写一套 preview 内核，再靠评审发现差异。这会让安全问题和状态竞态长期反复出现。

迁移/过渡风险：

- 抽公共层时必须先切纯逻辑，不要把 Web sidecar、Monaco、desktop store 直接拖入 App bundle。
- 可以先修 App 当前安全/竞态问题，再逐步把重复逻辑移动到共用层，降低一次性重构风险。

### P3 Changes 数量和文件变更状态由子 tab 分散拉取，底部导航与 Files 标记会出现不一致窗口

当前决策：

- `AppTerminalPage` 只保存 `changesCount`，由 `TerminalChangesTab` 拉取 changes 后回填：`app/src/pages/AppTerminalPage.tsx:212-215`、`app/src/pages/AppTerminalPage.tsx:464-471`、`app/src/pages/AppTerminalPage.tsx:507-510`。
- `TerminalFilesTab` 自己再次拉取 `git-changes` 来显示文件 badge：`app/src/components/TerminalFilesTab.tsx:171-183`、`app/src/components/TerminalFilesTab.tsx:219-225`。

为什么这是系统层面的风险：

- 用户未打开 `Changes` tab 前，底部 `Changes` badge 一直是 0，即使项目已有变更。
- `Changes` 和 `Files` 可以在不同时间点各自拿到不同的 git status；移动端看起来是同一个 preview 功能，但状态源实际分裂。
- 每次进入 Files/Changes 会重复触发 git status，虽不是灾难，但在手机端和大仓库里会放大延迟。

更好的候选方案：

- 推荐方案 A：`AppTerminalPage` 或一个 `useAppProjectPreview(projectId)` hook 统一拥有 changes snapshot、count、refresh，`ChangesTab` 和 `FilesTab` 只消费同一份状态。
- 可选方案 B：复用 Web preview store 的项目级状态模型，但裁掉桌面 UI 依赖，只保留 project-level preview state。
- 不推荐方案：让每个 tab 独立请求和缓存 git changes，再用局部回调同步 badge；这会继续产生状态漂移。

迁移/过渡风险：

- 统一状态后要明确刷新语义：手动 refresh 更新同一份 snapshot，切 tab 不自动覆盖用户正在看的 diff。
- 需要在 `projectId` 变化时清空 snapshot，避免旧项目状态短暂显示到新 session。

## 代码 / 实现发现

### P1 Markdown 预览允许不受限链接协议，项目文件可注入可点击的 `javascript:` 链接

为什么这是风险：

- `MarkdownPreview.renderInline()` 手写解析 markdown link，并直接把 `(...)` 放进 `<a href>`：`app/src/components/TerminalFilePreviewDrawer.tsx:54-77`。
- 该预览会渲染项目内 Markdown 文件：`app/src/components/TerminalFilePreviewDrawer.tsx:352-357`。
- 在 App/WebView 里，项目文件属于不可信内容。`[x](javascript:...)`、`vbscript:` 或 `data:` 这类 href 不应进入可点击链接。Web 侧已有 `validateLink` 明确禁止这些协议：`frontend/src/components/terminal/terminal-markdown-preview.tsx:109-115`。

可执行修复方向：

- 最小修复：在 App 的 link 解析处加入协议白名单或复用 Web 的 `validateLink` 逻辑，禁止 `javascript:`, `vbscript:`, `data:` 等危险协议；无效链接渲染为纯文本。
- 更稳妥：复用 Web Markdown 渲染的安全策略，包括 `html: false`、link validation、DOMPurify/资源解析边界；App 只换移动端样式。
- 补充验证：用包含 `[bad](javascript:alert(1))`、`[data](data:text/html,...)`、相对链接、普通 `https://` 链接的 Markdown 文件做 App 端手工/Playwright 验证。

### P2 preview 请求没有陈旧响应保护，快速切换文件/session 时旧响应可以覆盖新状态

为什么这是风险：

- `TerminalChangesTab` 在 `selectedChange` 变化后直接请求 diff，响应回来就 `setDiff(payload)`，没有 request id、AbortController 或 selected key 校验：`app/src/components/TerminalChangesTab.tsx:193-231`。
- `TerminalFilesTab` 的目录、搜索、changes 请求也没有陈旧响应保护：`app/src/components/TerminalFilesTab.tsx:185-210`、`app/src/components/TerminalFilesTab.tsx:227-249`。
- 文件预览 drawer 只在 unmount/cleanup 时用 `disposed` 防止 setState，但不能区分同一组件生命周期里较旧请求和较新请求的先后顺序：`app/src/components/TerminalFilePreviewDrawer.tsx:238-300`。
- Web 侧同类 preview 请求已经使用 `fileRequestIdRef`、`changesRequestIdRef`、`diffRequestIdRef` 丢弃过期响应：`frontend/src/components/terminal/use-terminal-preview-panel-data.ts:105-107`、`frontend/src/components/terminal/use-terminal-preview-panel-data.ts:159-235`、`frontend/src/components/terminal/use-terminal-preview-panel-data.ts:239-308`。

可执行修复方向：

- 给 App preview 请求补 request id 或 AbortController；响应落地前校验当前 `projectId`、`path`、`kind` 仍匹配。
- `projectId` / `terminalSessionId` 变化时主动清空 selected change、diff、directory、search、previewPath，并递增 request id。
- 对 `TerminalChangesTab` 和 `TerminalFilesTab` 统一抽一个小的 guarded async helper，避免每个 effect 重复写竞态处理。

## 剩余风险 / 测试缺口

- 本次未做浏览器/真机交互验证；如需要打开页面复现或验收，必须按项目约束使用 `$playwright-cli`。
- 未运行 `pnpm app:build`，因为 review-only 下优先保持只读且避免生成构建产物；当前已跑 `@runweave/app` typecheck。
- 没有新增测试，符合当前仓库对 App `src/` 前端变更不新增单测的约束；建议用 E2E 或手工回归覆盖 tab 切换、Markdown 链接、快速切换文件、无 project path、二进制/大文件状态。
