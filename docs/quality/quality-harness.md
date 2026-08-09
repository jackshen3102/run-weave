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

- **文档层**：`pnpm docs:check` 检查 L1/L2 必需入口和受治理 Markdown 的本地相对链接。
- **架构层**：`pnpm architecture:check` 检查 600 行 ratchet、循环依赖、反向依赖和共享根导入债务。
- **E2E 层**：只允许 `frontend/tests/*.spec.ts` 的 Playwright 自动化；当前没有受 Git 管理的 spec，
  因此该层会以 `No tests found` 阻塞。终端、App、Electron 行为按测试计划用
  `$playwright-cli` / `$computer-use` 真实取证。
- **静态/构建层**：backend、shared、electron、Runweave CLI、App 通过 typecheck、lint、build 或手工冒烟验证。

具体命名与映射见：`docs/testing/layers.md`

## 入口命令（概览）

- `pnpm run test:e2e`：前端 Playwright 入口；当前无 tracked spec，预期以 `No tests found` 非零退出。
- `pnpm test`：等同于 `pnpm run test:e2e`。
- `pnpm docs:check`：校验文档入口与仓库内相对链接。
- `pnpm architecture:report`：生成 `artifacts/architecture-report.json`，报告当前结构债务。
- `pnpm run quality:gate`：按变更选择 docs、architecture、typecheck/lint 和 Playwright E2E；当前
  E2E 资产为空时不会把该层误报为通过。

## 按需录屏验收

当用户明确要求“最后录屏验证”时，可在常规验证后执行浏览器 MCP 录屏验收，并把录屏与元数据保存到本地 `artifacts/verification-runs/`。

该能力是最终验收证据层，不替代 E2E 断言。详细设计见：`docs/quality/recorded-browser-mcp-verification.md`

## 行为验收

登录、Terminal Workspace、创建会话、输入回执、重连恢复、Terminal Browser、App 和 Electron
必须执行对应 `docs/testing/*` 的真实环境用例。只有仓库重新加入明确的 Playwright spec 后，
这些 spec 才能作为补充自动化证据，不能由命令入口本身代替。

详细选择策略见：`docs/testing/command-matrix.md`
