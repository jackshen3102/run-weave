# Terminal Image Zoom 代码评审

- 日期：2026-06-21
- 评审对象：当前 live worktree diff，重点覆盖 Web/App terminal image preview zoom 组件迁移、`packages/common` 导出、E2E 覆盖与未跟踪文件。
- 评审类型：`$toolkit:review-only`，只读代码评审；未修改被评审源码、配置或测试，仅新增本报告。
- 结论：未发现 blocker / major 问题；当前可进入 `human_verify`。

## 发现

- **P3 清理项：仓库根目录仍有未跟踪 `.tmp/preview-zoom-test.png`**。`git status --short` 显示 `?? .tmp/`，文件为 1600 x 1000 PNG 临时图片。它不是本次功能源码的一部分，且没有发现包含文本凭据或线程 dump 的证据；合入前建议删除或确认不会被误提交。

## 已核对

- `packages/common/src/terminal/zoomable-image.tsx` 新增的 `ZoomableImage` 被 Web 与 App 双边真实调用：Web 侧 `frontend/src/components/terminal/terminal-image-preview.tsx:1`，App 侧 `app/src/components/TerminalZoomableImage.tsx:1`。
- `packages/common/package.json:7` 继续只提供显式子路径导出，新增 CSS 也通过 `@runweave/common/terminal/zoomable-image.css` 显式导入，没有添加 `@runweave/common` 根导出。
- `packages/common/package.json:11` 新增 React peer 依赖，当前 Web/App 均使用 React 19，版本约束一致。
- `packages/common/src/terminal/zoomable-image.tsx` 未使用 React `useCallback`，符合本仓库 Hooks 约束。
- Web 侧新增 E2E 覆盖了打开图片、缩放、拖拽、重置、实际尺寸、全屏打开/关闭，以及 Changes 图片入口。

## 验证

- `git diff --check -- . ':(exclude)docs/review'`：通过。
- `pnpm install --offline --frozen-lockfile`：通过。
- `pnpm --filter @runweave/common typecheck`：通过。
- `pnpm typecheck`：通过。
- `pnpm lint`：通过。
- 按 `$playwright-cli` skill 约束执行相关浏览器 E2E：`cd frontend && npx playwright test tests/terminal-preview.spec.ts -g "terminal preview zooms image files and image changes" --reporter=line`：通过，1 passed。

## 剩余风险

- 本次只跑了新增 zoom 相关 Playwright 用例，没有跑完整 `frontend/tests/terminal-preview.spec.ts` 全量用例。
- App 侧图片缩放接入经过代码审查、类型检查和 lint，但未做真实移动端/浏览器交互验证。
- Playwright 运行生成了被 `.gitignore` 忽略的 `frontend/test-results/.last-run.json`，未进入 `git status`。
