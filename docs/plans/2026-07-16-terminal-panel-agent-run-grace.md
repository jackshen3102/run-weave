# Terminal Panel Agent 活动租约实施计划

## 目标

修复多 Pane 终端中 Agent 退出后 `activeCommand=codex -> null` 未留下可用 grace 记录，导致 grace 窗口内 `Stop` 被错误拒绝为 `inactive_agent` 的问题。

最终状态判断以目标 Panel 为作用域：可信 `Stop` 必须属于同一个 Panel、Agent 和 launch operation，并且目标 Agent 当前仍活跃，或刚在 30 秒 grace 窗口内退出。Session 只负责聚合 Panel 状态，不再作为多 Pane Agent 活跃身份的独立事实源。

## 非目标

- 不修改四态协议：`shell_idle`、`agent_starting`、`agent_idle`、`agent_running`。
- 不改变 `activeCommand` 的 shell/tmux 机器信号语义。
- 不新增单元测试、Vitest 或 backend test 文件。
- 不跨机器或跨 Profile 迁移活动租约；只保证同一 Backend Profile 重启恢复。
- 不调整 App/Web 的视觉展示。

## 当前代码事实

- `backend/src/terminal/manager-base.ts` 的 `lastAiActiveCommands` 仅以 Session ID 为 key。
- `backend/src/terminal/manager-session-runtime.ts` 只在 Session metadata 更新时观察 `activeCommand`。
- `backend/src/terminal/application/panel-workspace.ts` 会直接更新 Panel 的 `activeCommand`，随后调用通用 `upsertPanel()`；多 Pane 时 Session 的 `activeCommand` 被聚合为 `null`。
- `backend/src/terminal/agent-hook-processor.ts` 已有 Panel identity 和 operation generation 门禁，但 grace 仍读取 Session 级历史。
- `backend/src/routes/terminal-completion.ts` 已解析 `panelId/tmuxPaneId`，但 completion body 当前不携带 `operationId`。
- `electron/src/hooks/hook-launcher-script.ts` 运行在 Agent 进程继承的环境中，可以读取 `RUNWEAVE_TERMINAL_AGENT_OPERATION_ID`，但当前未把它写入 hook/completion body。

## 数据模型

使用一份作用域明确的内存 Map 作为实时判定源，并把同一记录持久化到 LowDB 作为重启恢复投影：

```ts
interface RecentAgentActivity {
  terminalSessionId: string;
  panelId: string | null;
  source: TerminalCompletionEvent["source"];
  command: string;
  operationId: string | null;
  phase: "starting" | "active" | "grace";
  observedAt: number;
  clearedAt: number | null;
}
```

Map key：

- Panel：`panel\0<terminalSessionId>\0<panelId>`。
- 无 Panel 的旧 PTY/legacy Session：`session\0<terminalSessionId>`。

不同时维护两份互相回退的 Session/Panel 真相。若请求未携带 Panel identity：

- 恰好一个 running Panel：解析到该 Panel。
- 没有 Panel：使用 Session scope。
- 多个 running Panel：拒绝，不能猜测目标 Pane。

## 状态转换规则

| previous           | next                 | 活动租约处理                                                                         |
| ------------------ | -------------------- | ------------------------------------------------------------------------------------ |
| 非 Agent/null      | Agent command        | 写 `active`；绑定当前 Panel operation generation，缺失时为 legacy `operationId=null` |
| 同一 Agent command | 同一 Agent command   | 幂等，不刷新 `observedAt`                                                            |
| Agent command      | null                 | 保留同一 identity，写 `grace` 和 `clearedAt=now`                                     |
| Agent command      | 普通非 Agent command | 删除租约；普通命令会立即终止 grace                                                   |
| grace              | 新 Agent command     | 新活动覆盖旧租约，绑定新 operation generation                                        |
| Panel/Session 删除 | 任意                 | 删除对应租约                                                                         |
| Backend 重启       | starting/active      | 从 LowDB 恢复租约和 operation generation；与当前 Panel 不一致则删除                  |
| Backend 重启       | grace                | `clearedAt` 仍在 30 秒内则恢复剩余窗口，过期则删除                                   |

`clearedAt` 是后端观察到 Panel metadata 清空的时间，不宣称为 Agent 进程的精确退出时间。

## Hook 接收判定

按以下顺序判定：

1. Session 存在且未退出。
2. 精确解析目标 Panel；多 Pane无 identity 返回 `panel_identity_mismatch`。
3. 若该 Panel 有 operation generation，请求必须携带匹配的 `operationId + agent`；否则返回 `operation_identity_mismatch`。
4. 读取同一作用域的活动租约。
5. 当前命令匹配，按现有规则接收。
6. grace 仅对 `Stop` 生效，并同时满足：
   - 目标 scope 当前 `activeCommand=null`；
   - 租约为 `phase=grace`；
   - `source` 与 hook agent 一致；
   - generation 存在时，租约、请求和当前 generation 的 `operationId` 一致；
   - `now-clearedAt <= 30_000`。
7. 其余请求保持现有 `inactive_agent`/当前状态处理。

## Completion 接收判定

- completion schema 新增可选 `operationId`，hook launcher 从 `RUNWEAVE_TERMINAL_AGENT_OPERATION_ID` 透传。
- 新 hook：有 operation generation 时必须匹配 operation identity。
- legacy 手动启动：只有目标 scope 没有 generation 时，才允许 `operationId=null`，继续使用 Panel + source + active/grace 判定。
- completion event 保存 `operationId` 供诊断和去重，不把 completion 当作 TerminalState 状态来源。
- 安装态残留旧 hook 脚本但 Panel 已有 generation 时采用 fail-closed；应用启动时的 hook 安装/刷新流程负责更新脚本。

## 文件范围

- `backend/src/terminal/completion-source-gate.ts`
  - 定义 `RecentAgentActivity` 与 scope key/判定 helper。
- `backend/src/terminal/manager-base.ts`
  - 将历史 Map 改为作用域明确的活动租约 Map；启动时校验并恢复持久化租约与 operation generation。
- `backend/src/terminal/store.ts`、`backend/src/terminal/lowdb-store-base.ts`、`backend/src/terminal/lowdb-panel-store.ts`、`backend/src/terminal/lowdb-store.ts`
  - 新增 `recentAgentActivities` 持久化投影及按 scope/Session 清理接口。
- `backend/src/terminal/manager-session-runtime.ts`
  - 实现 observe/get/clear；无 Panel Session 保留 legacy scope。
- `backend/src/terminal/manager-panel-operations.ts`
  - 提供 Panel activeCommand 转换记录入口；Panel/Session 清理时删除租约。
- `backend/src/terminal/application/panel-workspace.ts`
  - 在原地修改前捕获 `previousActiveCommand`，记录真实 Panel 转换；新 Panel 首次同步也记录。
- `backend/src/terminal/application/agent-preparation.ts`
  - resume 路径写 Panel command 时记录转换，不绕过统一观察入口。
- `backend/src/terminal/application/panel-split.ts`
  - provisional Panel 收敛到真实 metadata 时记录转换。
- `backend/src/terminal/agent-hook-processor.ts`
  - 使用目标 scope 的租约和 operation identity 判定 grace。
- `backend/src/routes/terminal-completion.ts`
  - 接收 `operationId`，使用相同 scope/identity 规则。
- `electron/src/hooks/hook-launcher-script.ts`
  - hook 与 completion body 透传 operation ID。
- `packages/shared/src/terminal/completion.ts`、`backend/src/terminal/completion-events.ts`
  - completion 事件携带可选 operation ID。
- `scripts/verify-toolkit-hooks.mjs`
  - 验证 launcher 确实透传 operation ID；这是已有 verify 脚本，不新增单测。
- `docs/architecture/terminal-state.md`
  - 记录 Panel 作用域、grace 和重启 fail-closed 契约。

## 兼容与回滚

- 单 Panel hook 未携带 `panelId` 时解析到唯一 running Panel，不改变正常单 Pane行为。
- 无 Panel 的 PTY/legacy Session 使用 Session scope。
- 多 Pane hook 缺 Panel identity 将从“可能猜测”收紧为拒绝，这是安全性收紧，不提供跨 Pane fallback。
- 回滚时可恢复原 Session 历史读取；不涉及持久化 schema 迁移或用户数据回填。

## 实施顺序

1. 建立 scope/lease 数据结构和 Manager API，保留现有外部行为。
2. 接通所有 Panel activeCommand 写入点和生命周期清理。
3. Hook 改用 Panel scope，并固定 30 秒边界与 operation identity。
4. Completion 和 Electron hook bridge 透传 operation ID。
5. 更新架构文档和已有 verify 脚本。
6. 执行配套用例 `docs/testing/terminal/terminal-agent-run-grace-test-cases.md`。

## 验收与验证

前置门禁，任一失败即停：

```sh
pnpm --filter ./backend typecheck
pnpm --filter ./backend lint
pnpm --filter ./packages/shared typecheck
pnpm --filter ./electron typecheck
pnpm --filter ./electron lint
pnpm toolkit:verify-hooks
git diff --check
```

行为验收使用真实 Dev Session、真实 tmux Pane、真实 Codex 和 `$toolkit:playwright-cli`，不得用静态检查代替。详细步骤和失败判断见：

- `docs/testing/terminal/terminal-agent-run-grace-test-cases.md`

## 高风险点

- operation ID 未从 hook launcher 传播会导致现代 hook 全部 fail-closed；必须和 Backend 同批落地并执行 verify。
- Backend 重启恢复必须同时恢复租约和 operation generation；只恢复其中一项会产生身份降级或误拒绝。
- 任何漏接的 Panel activeCommand 写入点都会再次产生无 grace 记录；计划列出的三个原地写入路径必须全部覆盖。
- 多 Pane 无 identity 的旧调用将被拒绝；日志必须包含 Session、Panel、operation 和 ignoreReason，便于区分兼容问题与真实攻击/迟到事件。
- 时间窗口测试容易受轮询抖动影响；真实用例以服务端记录的 metadata 清空时刻为基准，分别在 5 秒内和至少 31 秒后发送，不以 `/quit` 输入时刻计时。
