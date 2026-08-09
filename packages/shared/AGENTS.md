# 跨运行时合同

`packages/shared`（`@runweave/shared`）保存 backend、frontend、app、electron、app-server、CLI
之间复用的纯 TypeScript 合同。

## 适合放这里

- HTTP / WebSocket DTO、事件 envelope、状态枚举和 IPC payload；
- 跨进程发现、路径和运行时元数据；
- 不依赖 React、DOM、Electron、Express、Node service 实现或持久化驱动的纯类型与纯函数。

公开入口由 `package.json#exports` 决定。新增能力优先提供明确子路径；修改根导出前检查是否会扩大
浏览器 bundle 或引入 Node-only 依赖。

## 不适合放这里

- Backend service、数据库模型和文件系统实现；
- Electron handler、preload 实现或 BrowserView 生命周期；
- Web/App 组件、hooks 和样式；
- 只被一个运行时使用、仅因“未来可能复用”而抽出的类型。

Web 与 App 共享的前端实现属于 `packages/common`；其边界见 `../common/AGENTS.md`。

## 变更检查

修改合同前，用实际 import 搜索确认消费者，并同步审查序列化、兼容和可选字段语义：

```bash
rg '@runweave/shared' app app-server backend electron frontend packages scripts
pnpm --filter @runweave/shared typecheck
pnpm architecture:check
```
