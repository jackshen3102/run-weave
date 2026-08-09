# Terminal Renderer

`packages/terminal-renderer` 是 App 使用的 React/xterm 渲染层，封装终端实例、addon 和样式。

## 先看哪里

- 包入口与公开组件：`src/index.ts`
- React renderer：`src/TerminalRenderer.tsx`
- xterm 实例与 addon 生命周期：`src/TerminalRenderer.tsx`
- 公开样式：`src/terminal-renderer.css`

## 边界

- 本包负责终端显示与输入桥接，不负责 Terminal Session、WebSocket 协议或后端生命周期。
- 协议与 DTO 来自 `packages/shared`；Web/App 通用的小型前端能力按
  `../common/AGENTS.md` 判断是否进入 `packages/common`。
- 不引入 App-only 页面状态、Ionic 组件或 Web-only Electron bridge。
- 修改公开 props、CSS 或 addon 生命周期时检查所有真实消费者，不假设两个端行为一致。

## 验证

```bash
pnpm --filter @runweave/terminal-renderer typecheck
pnpm --filter @runweave/app typecheck
```
