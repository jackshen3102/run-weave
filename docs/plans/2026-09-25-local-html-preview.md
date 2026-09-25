# 本地 HTML 文件预览方案

## 目标与范围

桌面端和原生 iOS 手机端在 Terminal 的 Files/Explorer 中打开本地 `.html`/`.htm` 时，都提供 `Preview` 与 `Source` 切换。Preview 显示完整页面布局、CSS、图片与 JavaScript 交互。桌面端 Source 保留现有 Monaco 编辑、保存、冲突和只读规则；iOS Source 保留现有只读文本及行列定位。项目内文件和显式打开的项目外绝对路径都按现有文件权限读取。此次不改变 Prototype Gallery 的发现范围，也不让普通 Browser 接受 `file://`。

## 代码现状

- `backend/src/terminal/preview/paths.ts` 已将 `.html` 识别为 HTML；`readPreviewFile` 将其按 1 MiB 文本返回。`packages/shared/src/terminal/preview-core.ts` 仍将 HTML 归为 `text`。
- `frontend/src/components/terminal/preview/files/view.tsx` 因此只显示 Monaco。`panel/shell.tsx` 仅为 Markdown、SVG 提供视图切换。
- Prototype Gallery 已使用短期票据、受限静态文件路由和 `sandbox="allow-scripts"` iframe，在 `docs/prototypes` 与 `docs/architecture-flows` 内运行 HTML。普通 Browser 导航限于 HTTP(S) 和 about:blank。
- 原生 iOS 的 `packages/app-ios/Sources/RunweaveIOS/Features/Preview/FilePreview.swift` 从同一 Backend 读取文件，但只有 Markdown、SVG 可以切换 Preview/Source；HTML 落入只读源码视图。终端路径点击经 `TerminalFilePreview.swift` 进入同一 `FilePreview`。iOS 已在图片预览中使用 `WKWebView`，但尚无 HTML 文件及相对资源的隔离加载链路。

## 实施任务

1. **定义共用合同与桌面状态。** 在 shared preview-core 增加 HTML 类型及预览票据响应 DTO；在 `frontend/src/features/terminal/preview/store-types.ts`、`store.ts` 增加 HTML `preview/source` 模式。普通打开默认 Preview；带行列定位的终端链接默认 Source。桌面端切换时保留编辑草稿和行定位，文件切换与丢弃草稿继续走现有确认流程。
2. **提供两端共用的隔离资源。** 在 `backend/src/terminal/preview/`、`backend/src/routes/terminal/preview/` 和独立静态路由增加针对单个 HTML 文件的短期预览票据及只读 GET/HEAD 服务，复用 Prototype Gallery 的鉴权与文件服务模式。票据绑定项目、HTML 入口及允许访问的资源根；每个资源请求重新做 realpath 包含检查、普通文件检查、大小/MIME 限制和 `no-store`。相对 CSS、JS、图片、字体及其嵌套资源应以 HTML 所在目录解析；禁止 `../`、软链接或绝对 URL 通过本地资源路由越界。项目外绝对路径只允许该文件及其所在目录内的相对资源，不扩大为任意磁盘访问。票据 URL 必须可供 iframe 与 WKWebView 的后续子资源请求使用，无需把 App Bearer 凭据注入页面。
3. **接入桌面端。** 在 `frontend/src/components/terminal/preview/renderers/` 增加 HTML iframe 渲染器，接入 `files/view.tsx` 与 `panel/shell.tsx`。iframe 保持不带 `allow-same-origin` 的 sandbox，并使用 `referrerPolicy="no-referrer"`；不能把原始 HTML 注入主窗口 DOM。加载失败、资源缺失、票据过期均给出可重试提示。保存成功或手动刷新后重新申请票据并重新加载。
4. **接入原生 iOS。** 在 `packages/app-ios/Sources/RunweaveIOS/Services/PreviewService.swift` 增加票据申请，在 `Contracts/Preview.swift` 对照共享 DTO；`Features/Preview/FilePreview.swift` 为 HTML 增加 Preview/Source 切换，预览使用专用 `WKWebView` 包装视图加载 Backend 票据 URL。网页使用非持久化数据存储、限制导航与新窗口，禁止跳转到本地文件或 App 内其它页面；离开预览时停止加载。当前 iOS 文件视图只读，不新增 HTML 编辑器。带行列定位的终端文件链接继续默认显示 Source。
5. **对齐文档与验收。** 更新 `docs/architecture/terminal-code-preview.md`。检查现有 YAML 测试计划覆盖范围；若缺少可独立取证的桌面与 iOS HTML 场景，实施时补充 `docs/testing/**/*.testplan.yaml` 并执行格式校验。遵守仓库约束，不新增单元测试。

## 验收

- 桌面端和 iOS 均可从 Files/Explorer 和终端文件链接打开项目内 `index.html` 及任意命名的 `.html`/`.htm`，切换 Preview/Source；桌面源码保存、冲突与项目外只读语义保持，iOS Source 仍只读，带行列链接定位不丢失。
- 两端的相对样式、脚本、图片、字体可加载，页面交互可运行；缺失资源在预览中表现为加载失败，不错误读取工作区其他路径。
- 项目外绝对路径 HTML 可只读预览；`../`、软链接越界、目录与特殊文件、过期/跨项目票据、非法方法均被后端拒绝。
- 桌面端用真实页面经 `$toolkit:playwright-cli` 验证；iOS 按共享设备池规则申请模拟器，经 `$toolkit:agent-device` 实际点击 Files/Explorer、终端链接、Preview/Source 及页面交互。运行 frontend/backend/shared typecheck 与 lint、`pnpm architecture:check`、iOS 构建，并分别记录构建、安装、启动和 UI 结果；条件允许时补充真机交互验收。静态检查和构建不代替两端 UI 验收。

## 风险与待确认点

原型可能依赖同目录之外的资源，任意放开会扩大本地文件读取范围。建议第一版只解析入口所在目录及其子目录的相对资源；目录外资源需调整原型目录结构。桌面端未保存的 Source 编辑建议先不实时反映在 Preview，保存后自动刷新，避免另建草稿资源服务和混淆磁盘版本。iOS 的 WKWebView 行为与 Web iframe 不可互相代替验收。
