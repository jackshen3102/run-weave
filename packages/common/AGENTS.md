# Web 基础能力

`packages/common` 保留 Web 前端使用的终端缓冲、滚动、输入和图片预览基础能力。
原生 iOS 不导入本包。调用方通过显式子路径 `@runweave/common/terminal` 使用。

## 边界

- 不新增根导出；样式继续使用明确的 CSS 子路径。
- 新增页面状态、Web-only 业务、Electron bridge 或服务调用保留在 `frontend` 的实际拥有者。
- 不为了未来复用增加抽象；新增基础能力需列出当前调用方与保留包边界的理由。
- 后端、CLI、跨运行时协议、DTO 和纯 TypeScript 合同进入 `packages/shared`。
- 修改终端或图片公共行为时检查所有 Web 调用方；原生 Swift 实现独立维护。

验证使用 `pnpm --filter @runweave/common typecheck` 与 Web 前端对应检查。
