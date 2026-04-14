# AGENTS

面向编码智能体的高层路由与最小默认行为。

## 项目概览

- 项目名：Runweave
- 前端：React + Vite
- 后端：Express + WebSocket + Playwright 控制
- Electron 桌面客户端：electron/（多后端连接管理）
- 共享协议：packages/shared

## 最小命令

- 开发：`pnpm dev`
- Electron 开发：`pnpm dev:electron`
- 构建：`pnpm build`
- Electron mac 打包：`pnpm dist:electron:mac`
- 类型检查：`pnpm typecheck`
- Lint：`pnpm lint`
- 测试：`pnpm test`

## Electron 打包约束

- 默认仅打包当前本地可用的 mac 客户端。
- 使用命令：`pnpm dist:electron:mac`
- 不要默认打包 Windows 客户端，也不要为了兼容性额外生成 Windows 安装包，除非用户明确提出。

## 前端测试 / TDD 约束

- 前端 `*.tsx` 文件与面向 UI 的 React hooks 不写单测，不新增 `*.test.tsx`、`*.spec.tsx`、`*.ui.test.tsx`。
- 使用 `test-driven-development` skill 时，只对非 UI 逻辑执行 TDD，例如 `*.ts` 的 service、store、协议适配、URL/状态工具与纯函数。
- `*.tsx` 页面、组件以及 UI 侧 hooks 不要求 TDD 覆盖，相关变更通过 E2E、集成链路或必要的手工回归验证。
- 如需调整前端测试配置，保持 `frontend` Vitest 仅收集 `*.test.ts`，并将 UI 侧代码排除在 coverage 阈值之外。

## 文档路由（按需读取）

| 需求           | 阅读                                  |
| -------------- | ------------------------------------- |
| 架构/网络拓扑  | docs/architecture/network-topology.md |
| 质量体系概览   | docs/quality/quality-harness.md       |
| 测试层级与命名 | docs/testing/layers.md                |
| 测试命令选择   | docs/testing/command-matrix.md        |
| 终端回归       | docs/testing/runbooks/terminal-vim.md |
| 部署/环境概览  | docs/deployment/overview.md           |
| 文档总入口     | docs/README.md                        |
