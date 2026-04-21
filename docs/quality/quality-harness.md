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

## 分层思路（概念级）

- **默认层**：纯逻辑与确定性回归。
- **E2E 层**：关键路径闭环验证。
- **Live 层**：外部依赖漂移检查。

具体命名与映射见：`docs/testing/layers.md`

## 入口命令（概览）

- `pnpm run test:default`
- `pnpm run test:e2e`
- `pnpm run test:live`

## 关键路径（高层）

- 登录成功
- 创建会话
- Runweave Viewer 连接与首帧
- 输入回执
- 导航往返
- 重连恢复

详细选择策略见：`docs/testing/command-matrix.md`
