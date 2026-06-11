# Mobile Terminal Tabs Review

日期：2026-06-11

## 评审范围

- 当前未提交 diff，排除 `docs/review` 目录。
- 重点文件：
  - `app/src/pages/AppTerminalPage.tsx`
  - `app/src/components/TerminalChangesTab.tsx`
  - `app/src/components/TerminalFilesTab.tsx`
  - `app/src/components/TerminalFilePreviewDrawer.tsx`
  - `app/src/lib/mobile-diff.ts`
  - `packages/shared/src/terminal-preview-core.ts`
  - `frontend/src/components/terminal/use-terminal-preview-panel-data.ts`
  - `docs/plans/2026-06-10-mobile-terminal-detail-tabs.md`

## 架构 / 策略发现

### P2: App 端重新实现 Markdown preview，和 Web 现有 preview 能力开始分叉

- 当前决策：计划声明 App 端把 Web 已有 project preview 能力收敛成移动端只读入口，且 markdown/svg/image 走已有 preview 能力；实现中只抽出了低层路径/文件类型工具到 `packages/shared/src/terminal-preview-core.ts`，但 App 在 `TerminalFilePreviewDrawer` 内新增了独立的简化 Markdown renderer。
- 为什么它在系统层面可能是错的：Web 的 Markdown preview 已经承担了安全净化、markdown-it 插件、mermaid、本地图片加载、内部文件链接跳转、hash 滚动和图片 lightbox 等行为；App 的实现只支持少量正则 inline token 和基础块级语法，且对内部 preview-file 链接直接降级为不可点击文本。后续同一份 README 在 Web 与 App 中会有两套语义，问题会表现为“移动端预览坏了”，但根因是两条渲染链路。
- 证据：
  - 计划目标与边界：`docs/plans/2026-06-10-mobile-terminal-detail-tabs.md:7`、`docs/plans/2026-06-10-mobile-terminal-detail-tabs.md:103`
  - Web 现有 Markdown renderer：`frontend/src/components/terminal/terminal-markdown-preview.tsx:49`、`frontend/src/components/terminal/terminal-markdown-preview.tsx:91`、`frontend/src/components/terminal/terminal-markdown-preview.tsx:250`、`frontend/src/components/terminal/terminal-markdown-preview.tsx:291`
  - App 新增简化 renderer：`app/src/components/TerminalFilePreviewDrawer.tsx:55`、`app/src/components/TerminalFilePreviewDrawer.tsx:69`、`app/src/components/TerminalFilePreviewDrawer.tsx:91`、`app/src/components/TerminalFilePreviewDrawer.tsx:380`
- 更好的候选方案：
  1. 推荐：抽一个 headless/shared Markdown preview adapter，复用 Web 的 `markdown-it` 配置、href/asset 解析和安全策略，App 只替换移动端布局与交互壳。交付速度中等，复杂度中等，但长期一致性最好。
  2. 可接受：本期明确降级为“Markdown source preview”，删除“走已有 preview 能力”的目标描述，避免把简化 renderer 伪装成完整 preview。交付最快，复杂度低，但用户体验弱。
  3. 不推荐：继续维护 App 私有 Markdown parser。短期能跑，但会不断复制 Web 侧修复，安全和渲染一致性风险最高。
- 迁移/过渡风险：抽 shared preview adapter 会把 Web 侧部分依赖带到共享层，需要避免把 DOM/Monaco 桌面组件带入 App bundle；可以先只抽纯解析、净化和资源解析函数，再分别由 Web/App 负责图片点击、滚动和容器样式。

## 代码 / 实现发现

### P2: Files 的 `Show changes` 会把同一路径的 staged 变更覆盖成 working 变更

- 为什么这是风险：后端 preview API 会分别返回 `staged` 和 `working` 两组 changes；同一路径可以同时存在 staged 和 unstaged 修改。`TerminalFilesTab` 用 `Map<string, FileChangeInfo>` 按路径聚合时，先写 staged，再写 working，导致 staged 信息被覆盖。用户从 Files 预览进入 Changes 时，只能打开 working diff，看不到已经 staged 的 diff；badge 也只剩一个状态。
- 具体位置：
  - 后端按 staged/working 分开返回：`backend/src/terminal/preview-git.ts:133`、`backend/src/terminal/preview-git.ts:139`
  - App 覆盖聚合：`app/src/components/TerminalFilesTab.tsx:61`
  - drawer 只接收单个 `changeInfo`：`app/src/components/TerminalFilesTab.tsx:348`
  - `Show changes` 只传一个 kind：`app/src/components/TerminalFilePreviewDrawer.tsx:346`
- 修复方向：不要用单个 `Map<string, FileChangeInfo>` 表示文件变更。改成 `Map<string, FileChangeInfo[]>` 或 `{ staged?: ..., working?: ... }`，UI 上展示双 badge；点击 `Show changes` 时若存在两个 kind，让用户选择 staged/working，或优先跳到 Changes tab 并展开该路径的两个条目。

### P2: Changes 图片预览的 401 被吞掉，不会触发重新登录

- 为什么这是风险：计划要求 preview 请求 401 统一调用 `onAuthExpired()`。文件 drawer 对 asset 401 做了处理，但 Changes tab 的 image preview asset 请求 catch 里吞掉所有错误，只把 `assetUrl` 清空。移动端 token 过期时，用户切到图片 change 的 Preview 只会看到 `Preview unavailable`，不会进入统一登录恢复流程。
- 具体位置：
  - 计划约束：`docs/plans/2026-06-10-mobile-terminal-detail-tabs.md:141`、`docs/plans/2026-06-10-mobile-terminal-detail-tabs.md:245`
  - Changes asset 请求吞错：`app/src/components/TerminalChangesTab.tsx:333`
  - catch 未区分 401：`app/src/components/TerminalChangesTab.tsx:346`
  - 对照 drawer 正确处理 401：`app/src/components/TerminalFilePreviewDrawer.tsx:299`
- 修复方向：在 `TerminalChangesTab` 的 asset catch 中复用其他 preview 请求的错误处理，`ApiError && status === 401` 时调用 `onAuthExpired()`；非 401 再设置明确的 preview 错误状态，而不是静默降级。

### P3: File preview drawer 未展示计划要求的 readonly 和大小元信息

- 为什么这是风险：计划要求 drawer 显示文件名、相对路径、`readonly`、大小；后端响应已经提供 `sizeBytes` 和 `readonly`。当前 UI 只展示文件名/路径和内容，用户无法判断文件是否只读、文件大小是否接近预览限制，也无法解释 413/415 这类状态。
- 具体位置：
  - 计划验收：`docs/plans/2026-06-10-mobile-terminal-detail-tabs.md:103`
  - shared 响应已有字段：`packages/shared/src/terminal-protocol.ts:83`
  - drawer header 只展示文件名/路径：`app/src/components/TerminalFilePreviewDrawer.tsx:333`
  - 内容区未展示 metadata：`app/src/components/TerminalFilePreviewDrawer.tsx:373`
- 修复方向：在 drawer header 或 subheader 显示 `readonly` 与 `formatBytes(file.sizeBytes)`；图片 asset 路径如果不请求 file metadata，需要决定是否额外取 file response 或在 asset preview 中明确不展示大小。

## 验证命令

- `git diff --check -- . ':(exclude)docs/review'`：通过。
- `pnpm --filter @runweave/app typecheck`：通过。
- `pnpm --filter @browser-viewer/shared typecheck`：通过。
- `pnpm --filter @browser-viewer/frontend typecheck`：通过。
- `pnpm --filter @browser-viewer/frontend lint`：通过。
- `pnpm --filter @runweave/app build`：通过，Vite 报告大 chunk 警告。
- `pnpm --filter @runweave/frontend typecheck`：未执行到有效检查，包名不存在；实际前端包名是 `@browser-viewer/frontend`，已用正确包名补跑。

## 剩余风险 / 测试缺口

- 本次未做浏览器或 iOS 视觉验证；如果需要打开页面验收，必须使用 `$playwright-cli`。
- 当前变更没有 App 端 E2E 覆盖 Changes/Files 的真实交互，包括 tab 切换不断开 WebSocket、图片 preview 401、同路径 staged+working 跳转。
- `pnpm --filter @runweave/app build` 会生成被忽略的 `app/dist/` 构建产物；git 状态未出现新的 tracked 源码变更。
