# Web Terminal 状态查询入口验收 Runbook

## 前置条件

- 使用已运行的 Web 前端：`http://127.0.0.1:5173/`。
- 后端已登录且 Web Terminal 可打开。
- App Server 至少存在一条 `ThreadRef`；若没有，先运行 `pnpm app-server:verify-state-sync` 或通过真实 terminal/hook 事件生成状态。

## 验收步骤

1. 打开 Web Terminal 页面，点击右上角 `More actions`。
   - 预期：菜单中出现 `状态查询`。
2. 点击 `状态查询`。
   - 预期：居中打开标题为 `状态查询` 的 dialog。
3. 切到 `Thread ID`，输入已存在的 `threadId`，点击 `查询`。
   - 预期：显示单条 ThreadRef 摘要，字段包含 `status`、`threadId`、`agent`、`terminalSessionId`、`terminalPanelId`、`projectId`、`runId`、`lastEventId`、`lastHookEvent`、`lastCompletionReason`、`updatedAt`、`cwd`、`sourceInstanceId`。
4. `Thread ID` 模式输入不存在的 `threadId`，点击 `查询`。
   - 预期：显示 `未找到该 thread`。
5. 切到 `Terminal ID`，输入存在多条 ThreadRef 的 `terminalSessionId`，点击 `查询`。
   - 预期：显示候选列表，默认选中排序后的第一条；排序优先级为 `running`、`starting`、`failed`、`idle`、`completed`、`unknown`，同状态按 `updatedAt` 新到旧。
6. 点击候选列表中的另一条结果。
   - 预期：下方状态摘要切换为该 ThreadRef。
7. 点击 `复制给 Agent`。
   - 预期：剪贴板文本包含当前选中 ThreadRef 的最小状态和排查指令；多候选场景包含候选列表。
8. 检查 dialog 文案。
   - 预期：页面不出现 `复制 JSON` 和 `Raw JSON`。

## 必跑命令

```bash
pnpm --filter @runweave/shared typecheck
pnpm --filter @runweave/backend typecheck
pnpm --filter @runweave/backend lint
pnpm --filter ./frontend typecheck
pnpm --filter ./frontend lint
pnpm app-server:verify-state-sync
git diff --check -- backend frontend packages/shared docs
```
