# T3 Code 借鉴落地方案细化

打开 [index.html](./index.html)，或从当前项目的 Files 以 HTML Preview 打开同一文件；也可从 Runweave 的 `/prototypes` 选择当前 Worktree 下的 `t3code-borrowings-plan`。修改后手动刷新或重新打开。

## 原始目标与已确认决策

基于 `pingdotgg/t3code@5eaff03e` 调研结论，将已拍板范围细化为可评审的交互、流程与协议方案：

- **机制 1（代码/Diff 行级批注打包回终端）**：不借鉴，保持现有 Monaco 行引用复制与 Browser/HTML 评审边界。
- **机制 2（基准分支 Diff 与提交查看）**：只实现第一阶段（纯只读 `working | branch | commits` 源切换），不做隐藏 Git Ref 轮次快照与工作区回滚。
- **机制 3（一键新建 Worktree + 受控 `setup`）**：借鉴，抽离 `RaceWorktreeSupply` 公共创建能力，并对 `runweave.json` 的 `worktree.setup` 执行 SHA-256 修订批准门禁。
- **机制 4（Attention 待处理收口 + Working 折叠 + PR 有界值守）**：借鉴，将 Codex 待答、Claude `PermissionRequest`、OSC 7501 `blocked` 接入 `needs_action`，折叠 `working`，并增加带 10 次纯评论唤醒熔断的后台 PR 值守。
- **机制 5（跨 Agent / 跨 Worktree 有预算上下文交接）**：借鉴，复用 `ConversationReader` 净正文投影与终端文本附件，支持 48 KiB 预算内的跨 CLI / 跨目录新终端交接。
- **机制 6（Agent 启动上下文与 MCP 字节预算门禁）**：借鉴，基于当前仓库实测基线（根 `AGENTS.md` 4,823 B、50 个 Toolkit 技能 frontmatter 17,621 B、`runweave-mcp` Schema）建立防膨胀门禁。

## 源码基线与模拟边界

- 当前仓库基线：[预览 Git 服务](../../../backend/src/terminal/preview/git.ts)、[主分支状态服务](../../../backend/src/terminal/git/home-branch-status.ts)、[Worktree 注册表](../../../backend/src/terminal/workspace-service/worktree-project-registry.ts)、[Race Worktree 创建](../../../backend/src/race/race-worktree-supply.ts)、[Attention 服务](../../../backend/src/attention/attention-service.ts)、[OSC 7501 程序状态](../../../packages/shared/src/terminal/runtime/program-status.ts)、[Codex 会话分叉](../../../backend/src/terminal/application/agent-fork.ts)、[质量门禁](../../../scripts/quality/gate.mjs)。
- 页面中的演示切换按钮、Diff 行、Worktree 创建进度、Attention 卡片和交接预算条均为本地前端模拟，用于展示拟落地交互与状态分支，不代表后端接口或 UI 已上线。

## 未决小项（可在实施前拍板）

1. `runweave.json` 新增 `worktree.setup` 时，保持 `schemaVersion: 1` 可选兼容字段还是升级为 `schemaVersion: 2`（默认推荐保持 `schemaVersion: 1` 可选字段，不破坏已有服务配置）。
2. PR Watch 后台值守入口放在终端顶栏状态菜单还是快捷指令旁（默认推荐放在终端关联 PR 徽标菜单，显式按终端开启）。

## 实际验证记录

- 静态与文档链接检查：`pnpm docs:check`、`index.html` 体积与内联无外链检查。
- 浏览器交互与响应式核对：通过当前终端绑定的 Runweave Terminal Browser（Playwright CLI 附着）执行桌面（1440×900）与窄视口（390×844）交互切换、无横向溢出核对及界面示意截图采集；未在 iPhone 真机验收。
