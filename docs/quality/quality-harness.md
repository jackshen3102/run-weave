# 质量体系概览

本文描述 Runweave 当前质量体系的目标与边界，避免实现级细节。

## 目的

- 让变更后可以验证关键用户路径。
- 能区分产品回归与环境噪声。
- 用最小验证集形成可靠结论。

## 非目标

- 不是替代所有 E2E。
- 不是覆盖所有外部网站变体。
- 不追求一次性完整自动化。
- 不维护单元测试、Vitest、Node test、live test 或 coverage 门槛。

## 分层思路（概念级）

- **E2E 层**：Playwright 关键路径闭环验证，是当前唯一正式自动化测试层。
- **静态/构建层**：backend、shared、electron、Runweave CLI、App 通过 typecheck、lint、build 或手工冒烟验证。

具体命名与映射见：`docs/testing/layers.md`

## 入口命令（概览）

- `pnpm run test:e2e`：前端 Playwright 关键路径。
- `pnpm test`：等同于 `pnpm run test:e2e`。
- `pnpm run quality:gate`：按变更选择 Playwright smoke E2E；不再运行单测或 coverage。

## 按需录屏验收

当用户明确要求“最后录屏验证”时，可在常规验证后执行浏览器 MCP 录屏验收，并把录屏与元数据保存到本地 `artifacts/verification-runs/`。

该能力是最终验收证据层，不替代 E2E 断言。详细设计见：`docs/quality/recorded-browser-mcp-verification.md`

## 关键路径（高层）

- 登录成功
- 创建会话
- Runweave Viewer 连接与首帧
- 输入回执
- 导航往返
- 重连恢复

详细选择策略见：`docs/testing/command-matrix.md`
