# 云端浏览器实时操控 - 执行计划与进度

## 1. 项目目标

在保留当前后端简化方案（单机单进程、Express + ws + Playwright + 内存会话）的前提下，升级为可持续开发的 Monorepo：

- 项目目录固定为 `frontend` 与 `backend`
- 使用 `pnpm workspace` 统一管理依赖与脚本
- 前端技术栈：React + Vite + Tailwind + shadcn/ui + dark/light 模式切换
- 后端技术栈：延续文档方案（Express + ws + Playwright + uuid）
- 引入质量保障：lint、类型检查、单测、集成测试、E2E、CI 门禁

## 2. 目标目录结构

```txt
.
├── frontend/
├── backend/
├── packages/
│   └── shared/
├── package.json
├── pnpm-workspace.yaml
└── plan.md
```

说明：`packages/shared` 用于前后端共享类型与消息协议，降低字段漂移风险。

## 3. 分阶段执行计划

### Phase 1 - Workspace 初始化

1. 创建 `pnpm-workspace.yaml`
2. 创建根 `package.json`（统一 scripts）
3. 初始化 `frontend`、`backend`、`packages/shared` 三个 package

### Phase 2 - Backend 最小闭环

1. HTTP API：创建、查询、销毁会话
2. WebSocket：帧下行、交互上行
3. 会话管理：内存 Map + 超时清理 + 断连释放
4. Playwright + CDP Screencast：start/ack/stop

### Phase 3 - Frontend Viewer

1. React + Vite + Tailwind 基础搭建
2. 引入 shadcn/ui 组件体系
3. 实现 dark/light 切换
4. Viewer 页面：Canvas 渲染 + 事件回传 + 重连策略

### Phase 4 - 测试与质量保障

1. Unit Test：frontend/backend 核心逻辑
2. Integration Test：backend API + ws 协议
3. E2E：create session -> open viewer -> interact -> destroy
4. 质量门禁：eslint + typecheck + test + coverage

### Phase 5 - CI 与验收

1. GitHub Actions 运行 lint/typecheck/test/e2e
2. 覆盖率阈值落地
3. 文档完善与验收清单打勾

## 4. 质量保障策略

### 4.1 本地门禁

- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm e2e`（可在开发后期加入）

### 4.2 提交前门禁

- `husky` + `lint-staged`（后续阶段接入）

### 4.3 CI 门禁

- PR 必须通过 `lint + typecheck + unit/integration + e2e` 才允许合并

## 5. 进度看板（持续更新）

状态说明：`[ ]` 未开始，`[~]` 进行中，`[x]` 已完成

- [x] 评审现有方案并确认落地范围
- [x] 将分阶段执行计划写入文件并建立进度看板
- [x] 初始化 pnpm workspace 基础结构
- [x] 搭建 backend 最小可运行骨架
- [x] 搭建 frontend 最小可运行骨架
- [x] 接入测试与质量保障基线
- [x] 增量迭代：后端推帧与前端只读 Viewer 联调
- [x] 增量迭代：输入事件回传（mouse/keyboard/scroll）
- [x] 增量迭代：协议与会话集成测试完善
- [x] 增量迭代：共享 WS 协议类型与断线重连保活
- [x] 增量迭代：连接稳定性增强（手动重连 + 心跳）
- [x] 增量迭代：工程化门禁（CI + Coverage + Pre-commit）
- [~] 更新验收清单与下一步计划

## 6. 执行日志

- 2026-03-19：完成计划细化与进度看板初始化。
- 2026-03-19：完成 Monorepo 初始化（frontend/backend/packages/shared）与 pnpm workspace 配置。
- 2026-03-19：完成 backend 骨架（Express API、ws 连接、SessionManager、Playwright BrowserService 占位）。
- 2026-03-19：完成 frontend 骨架（React + Vite + Tailwind + shadcn 风格组件 + dark/light 切换）。
- 2026-03-19：完成质量基线（ESLint、TypeScript typecheck、Vitest 单测、Playwright smoke E2E）。
- 2026-03-19：本地验证通过：`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm e2e`、`pnpm build`。
- 2026-03-19：新增后端 screencast 推帧（CDP start/frameAck/stop）并接入 `/ws?sessionId=` 二进制帧下发。
- 2026-03-19：新增前端最小 Viewer 页面（`?sessionId=` 直连、Canvas 实时绘制、会话状态展示）。
- 2026-03-19：完成输入事件回传闭环（前端 mouse/keyboard/scroll 上行，后端解析并注入 Playwright）。
- 2026-03-19：新增坐标映射与输入测试（`backend/src/ws/input.test.ts`、`frontend/src/lib/coordinate.test.ts`）。
- 2026-03-19：本轮验证通过：`pnpm --filter ./backend typecheck`、`pnpm --filter ./frontend typecheck`、`pnpm test`、`pnpm e2e`。
- 2026-03-19：新增 backend API 集成测试（create/get/delete）与 ws 集成测试（连接、非法消息、输入注入）。
- 2026-03-19：Viewer 增加 mousemove 节流（16ms）以降低高频输入压力。
- 2026-03-19：本轮验证通过：`pnpm test`、`pnpm e2e`。
- 2026-03-19：共享协议新增 `ServerEventMessage` 并在前后端统一使用（connected/ack/error）。
- 2026-03-19：SessionManager 增加断线宽限期（默认 5 秒），支持页面刷新后快速重连保活。
- 2026-03-19：Viewer 增加断线自动重连（指数退避，最高 2 秒）。
- 2026-03-19：新增保活相关测试：`backend/src/session/manager.test.ts` 增加断线宽限期保活与到期销毁用例。
- 2026-03-19：本轮验证通过：`pnpm --filter ./backend typecheck`、`pnpm --filter ./frontend typecheck`、`pnpm test`、`pnpm e2e`。
- 2026-03-19：Viewer 增加重连状态提示与手动 `Reconnect` 按钮。
- 2026-03-19：ws 服务增加 ping/pong 心跳与超时终止，增强僵尸连接清理能力。
- 2026-03-19：本轮验证通过：`pnpm --filter ./backend typecheck`、`pnpm --filter ./frontend typecheck`、`pnpm test`、`pnpm e2e`。
- 2026-03-19：新增 CI 工作流 `/.github/workflows/ci.yml`，覆盖 lint/typecheck/test/coverage/e2e。
- 2026-03-19：新增覆盖率门禁（backend/frontend）与 `pnpm coverage` 脚本。
- 2026-03-19：接入 `husky + lint-staged` 提交前门禁（`.husky/pre-commit`）。
- 2026-03-19：清理前端误生成文件（如 `frontend/vite.config.js`）。
- 2026-03-19：本轮验证通过：`pnpm lint`、`pnpm typecheck`、`pnpm coverage`、`pnpm e2e`。
