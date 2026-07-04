# Terminal Pane Resize 代码评审

## 直接执行

评审对象：当前 live worktree 的 terminal pane resize 相关代码改动，范围包括：

- `backend/src/agent-team/service.ts`
- `backend/src/routes/terminal-panel-routes.ts`
- `backend/src/terminal/tmux-service.ts`
- `frontend/src/components/terminal/terminal-pane-resize-overlay.tsx`（未跟踪文件）
- `frontend/src/components/terminal/terminal-surface-layout.tsx`
- `frontend/src/components/terminal/terminal-surface.tsx`
- `frontend/src/components/terminal/terminal-workspace-shell.tsx`
- `frontend/src/components/terminal/use-terminal-emulator.ts`
- `frontend/src/features/terminal/preview-store.ts`
- `frontend/src/services/terminal.ts`
- `packages/shared/src/terminal-protocol.ts`

### 发现

- **P2 一般（发布前已修复）：`onViewportResizeRef` 被 effect 使用但没有进入依赖数组，留下 lint warning，也让 hook 契约容易被后续改动破坏。** `useTerminalEmulator` 在 resize 同步时调用 `onViewportResizeRef.current?.()`，但初始化终端的 effect 依赖数组没有包含 `onViewportResizeRef`；当前调用方传入的是稳定 ref，所以短期运行风险有限，但仓库 lint 已明确报 `react-hooks/exhaustive-deps` warning，后续若 ref 来源变化会出现旧 effect 持有旧 ref 的问题。定位：`frontend/src/components/terminal/use-terminal-emulator.ts:268`、`frontend/src/components/terminal/use-terminal-emulator.ts:523`。修复方向：把 `onViewportResizeRef` 加入该 effect 的依赖数组；当前 PR 分支已补齐依赖并通过 lint。

### 无 P0/P1

未发现必须阻断上线的安全、数据或明显正确性缺陷。共享协议放在 `packages/shared`，未触碰 `packages/common` 根导出；新增前端回调使用 `useMemoizedFn`，未新增 `useCallback`。

### 验证摘要

- `git diff --check -- . ':(exclude)docs/review'`：通过。
- `pnpm typecheck`：通过。
- `pnpm lint`：通过。

### 残余风险 / 待确认

- 本轮是代码评审，未执行浏览器验收。拖拽 handle 的像素位置、tmux cell 几何刷新、sidecar/window resize 后的 handle 重定位，仍建议在真实 panel split 页面用 Playwright 或手动浏览器流程确认。
- `frontend/src/components/terminal/terminal-pane-resize-overlay.tsx` 当前是未跟踪文件；提交时需要确保它被纳入同一个变更，否则已修改的 `terminal-surface-layout.tsx` 会引用缺失文件。

## 深度交互（如有）

更低成本的修复路径是先清掉现有 lint warning，再做浏览器级行为验收。不要先扩大 resize 抽象或引入新的布局状态层；当前设计已经复用了 tmux 原生 pane geometry 和后端 panel workspace，主要缺口是把已有回调链收干净并证明拖拽坐标与 tmux resize 结果一致。
