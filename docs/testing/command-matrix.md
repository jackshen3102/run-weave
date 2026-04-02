# 测试命令选择

| 变更场景            | 推荐命令                                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------- |
| 前端文案/样式       | `pnpm --filter ./frontend test -- src/...`                                                              |
| 前端状态/交互       | `pnpm run test:ui`                                                                                      |
| 后端路由/服务逻辑   | `pnpm --filter ./backend test -- src/...`                                                               |
| 共享协议类型变更    | `pnpm --filter ./packages/shared test && pnpm --filter ./backend test && pnpm --filter ./frontend test` |
| 关键用户路径        | `pnpm run test:e2e -- tests/interaction.spec.ts`                                                        |
| 外部依赖风险        | `pnpm run test:live`                                                                                    |
| 预合并全量信心      | `pnpm run test:default && pnpm run test:ui && pnpm run test:e2e`                                        |
| Electron 客户端开发 | `pnpm dev:electron`                                                                                     |

## 反模式

- 不要用 E2E 覆盖纯逻辑变更。
- 不要把 live 当作日常回归默认。
- 协议变更不要跳过 shared / backend / frontend 联动测试。
