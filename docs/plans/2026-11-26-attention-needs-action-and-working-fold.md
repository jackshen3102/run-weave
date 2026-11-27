# Attention 待处理信号收口与 Working 折叠实施计划

当用户并行打开多个终端时，桌面端 Companion/徽标与原生 iOS 首页将所有「正在等人回答或授权」的终端（含 Codex 结构化提问、Claude 权限请求与 OSC 7501 阻塞态）统一置顶为 `needs_action` 并直达对应面板，同时默认折叠正在正常运行的 `working` 项以消除背景噪音。设计交互见 `docs/prototypes/t3code-borrowings-plan/index.html#mech-4`（注：后台 PR 值守作为独立子系统拆分在 `docs/plans/2026-11-26-terminal-pr-bounded-watch.md`）。

## 1. 目标与非目标

### 目标

- 补齐 `AttentionService` 对现有结构化人工门禁事实的采集覆盖，统一映射为最高优先级的 `state: "needs_action"` 并附带精确 `actionKind` 与 `panelId`：
  1. **Codex 结构化待答**：来自 `TerminalQuestionsService` 已确认仍处于 `pending` 的实时提问请求（`actionKind: "question"`）；
  2. **Claude 权限确认**：来自公共 Hook 已核验主进程代次的 Claude `PermissionRequest` 事件（`actionKind: "permission"`），在后续工具执行、`UserPromptSubmit`、`Notification/idle_prompt` 或会话结束时自动清除；
  3. **OSC 7501 程序阻塞态**：来自面板实时采集的 `oscProgramStatus.state === "blocked"`（`kind: "permission" | "question" | "auth"` 分别映射对应 `actionKind`，无 `kind` 时映射 `"agent_prompt"`）。
- 在桌面端 Companion 托盘列表及原生 iOS 关注/分组视图中，当同时存在其他槽位或 `working` 项数量 `>= 1` 时，将 `state === "working"` 的条目默认收进底部可展开的「运行中 (N)」折叠区；一旦任一终端转为 `needs_action / blocked / failed / completed`，立即浮出折叠区置顶展示。
- 点击 `actionKind === "question"` 且当前客户端支持结构化问答的条目时，桌面/iOS 支持直接定位目标面板（iOS 可一键打开「回复辅助」）。

### 非目标（不做什么）

- **严禁启发式猜测**：绝不根据终端输出中的 `"Allow?"`、`"error"` 文本或“多少分钟没有输出”推断 `needs_action` 或 `blocked`（严格保持 `DSC-010` 结构化事实边界）。
- 不改变 `TerminalStateService` 的四个基础状态枚举（`shell_idle | agent_starting | agent_idle | agent_running`），也不修改完成通知投递到飞书的触发条件。
- 不在本计划内实现 GitHub PR 轮询值守（见独立计划 `2026-11-26-terminal-pr-bounded-watch.md`，该计划仅复用本计划新增的 `actionKind` 协议槽位）。

## 2. 用户可见行为与业务规则

1. **单 Session 多 Panel 聚合优先级**：
   - 每个 `terminalSessionId` 仍最多生成一个 `AttentionSlot`。
   - 当同一 Session 下多个运行中 Panel 处于不同状态时，按 `needs_action (600) > blocked (500) > failed (400) > completed (300) > working (200)` 选择最高优先级 Panel，并将 `slot.panelId`、`slot.panelLabel` 精确指向该触发 Panel（而非默认 `activePanelId`）。
   - 同为 `needs_action` 的多个信号在同一 Panel 共存时，优先展示更具体的结构化来源：`TerminalQuestions` 待答 > Claude `PermissionRequest` / Pi `ui_prompt_start` > `OSC 7501 blocked` > Trae `Notification`。
2. **Claude `PermissionRequest` 等待生命周期**：
   - `agent-hook-processor.ts` 在校验通过主 Claude 进程身份（PID、启动时间、Panel 活动租约）后，收到 `PermissionRequest` 时在对应 Panel 记录 `pendingPermissionRequest: { hookTimestamp, processGeneration, sessionId }`。
   - 当同一 Panel 收到同代次的 `PostToolUse`、`PreToolUse`（推进到下一工具）、`UserPromptSubmit`、`Stop`、`Notification/idle_prompt`，或 Panel 进程退出/切换 Agent 时，立即清除 `pendingPermissionRequest`，防止已处理的权限弹窗残留假告警。
3. **Codex `TerminalQuestions` 只读观测边界**：
   - `AttentionService.snapshot()` 只查询 `TerminalQuestionsService` 已登记或由 `PreToolUse(request_user_input)` 触发确认的活跃待答状态（新增无副作用只读方法 `listPendingForSession(terminalId)`），**绝不在每次 `snapshot()` 轮询时对所有空闲终端主动新建 Unix socket 连接**。
4. **Working 折叠交互**：
   - Companion 托盘展开态与 Web/iOS 关注分组中：`needs_action`、`blocked`、`failed`、`completed` 默认平铺在上方；`working` 聚合为底部一行 `运行中 (N)`，用户点击可本地展开/收起，展开状态仅保存在当前视图内存中，不影响 Companion 单卡弹出抑制逻辑（`DSC-003` / `DSC-004`）。

## 3. API 合约与数据结构

### 3.1 共享协议扩展（`packages/shared/src/attention.ts`）

```ts
export type AttentionActionKind =
  | "question"
  | "permission"
  | "auth"
  | "agent_prompt"
  | "pr_attention";

export interface AttentionSlot {
  // 保持全部既有字段不变...
  attentionId: string;
  projectId: string;
  parentProjectId: string;
  projectName: string;
  contextName: string;
  branch: string | null;
  terminalSessionId: string;
  sessionLabel: string;
  panelId: string | null;
  panelLabel: string | null;
  state: AttentionState;
  actionKind?: AttentionActionKind; // 新增可选细分原因，向后兼容旧客户端
  title: string;
  detail: string;
  updatedAt: string;
  source: {
    kind: "terminal_session";
    evidence: string; // 例如 "terminal_question" | "claude_permission_request" | "osc7501:blocked:permission"
  };
  targetSurface: AttentionTargetSurface;
  completionRevision: number | null;
}
```

- `attentionId` 稳定性规则（确保 Companion 进程内单卡收起去重 `DSC-003` 正常工作）：
  - Codex 待答：`terminal:${sessionId}:question:${panelId}:${threadId}:${turnId}:${itemId}`
  - Claude 权限：`terminal:${sessionId}:claude-perm:${panelId}:${sessionUuid}:${sequenceOrTimestamp}`
  - OSC 7501 阻塞：`terminal:${sessionId}:osc-blocked:${panelId}:${kind ?? "generic"}:${observedAt}`

## 4. 修改与新增文件清单

| 文件路径                                                                                                | 操作      | 职责说明                                                                                                                                                            |
| :------------------------------------------------------------------------------------------------------ | :-------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/shared/src/attention.ts`                                                                      | 修改      | 新增可选 `AttentionActionKind` 类型与 `AttentionSlot.actionKind` 字段                                                                                               |
| `packages/agent-bridge/hooks/runweave-hook-payload.cjs` 与 `electron/src/hooks/hook-installer.ts`       | 核对/修改 | 确认 Claude `PermissionRequest` Hook 事件原样携带主进程代次身份投递至 Backend，且不包含敏感命令全文或环境变量                                                       |
| `backend/src/terminal/manager/records.ts` 与 `backend/src/terminal/application/agent-hook-processor.ts` | 修改      | 在 Panel 运行态维护有界的 Claude `pendingPermissionRequest` 状态及自动清除条件                                                                                      |
| `backend/src/terminal/questions/service.ts`                                                             | 修改      | 新增无副作用只读查询 `findActivePendingQuestion(terminalId)`，返回已确认仍处于 `pending` 的 `{ panelId, threadId, turnId, itemId, updatedAt }`                      |
| `backend/src/attention/attention-service.ts`                                                            | 修改      | 按精确优先级整合 `TerminalQuestions`、Claude `PermissionRequest`、`panel.oscProgramStatus (blocked)`、Pi 与 Trae 信号，填充 `panelId`、`panelLabel` 与 `actionKind` |
| `frontend/src/features/attention/` 与 Companion 渲染组件                                                | 修改      | 展示细分标签（需回答 / 需授权 / 需认证），并将 `working` 槽位默认折叠在托盘底部可展开分组中                                                                         |
| `packages/app-ios/Sources/RunweaveIOS/Features/Home/`                                                   | 修改      | 在首页会话行与排序投影中识别阻塞/待答标识，提供一键打开目标终端（Codex 待答可直达 `CodexReplyAssistant`）及运行中折叠开关                                           |
| `docs/architecture/terminal-state.md`                                                                   | 修改      | 更新 `Attention` 聚合覆盖范围说明（补充 Codex 待答、Claude `PermissionRequest` 与 `OSC 7501 blocked`）                                                              |
| `docs/testing/platform/attention-needs-action-convergence.testplan.yaml`                                | 新建      | 覆盖新增三类阻塞信号的触发、精确 Panel 跳转、消退及 `working` 折叠降噪的验收用例                                                                                    |

## 5. 高风险点与安全/兼容回滚

- **权限卡死后残留假阳性风险**：若用户在终端内按 `Ctrl+C` 或 `Esc` 取消了 Claude 的权限确认而未触发 `PostToolUse`，必须确保紧随其后的 `Stop`、`UserPromptSubmit`、`Notification/idle_prompt` 或进程退出均能可靠清空 `pendingPermissionRequest`。
- **敏感信息不入 Attention 快照**：`AttentionSlot` 会跨进程传给 macOS Desktop Companion（`CompanionPresentationState`）；`title` 与 `detail` 只能使用固定受控提示文案（如「Claude 请求执行权限，请打开面板确认」），**严禁把待审批的完整 Shell 命令参数、文件路径或用户问题正文拼进 `AttentionSlot`**。
- **兼容与回滚**：`actionKind` 为可选新增字段，旧前端/Companion/iOS 仍按 `state === "needs_action"` 正常渲染高优提醒；回滚 Backend 仅恢复原有 Pi/Trae 采集范围，无持久化数据迁移负担。

## 6. 验收标准与验证方式

配套新增测试计划：[docs/testing/platform/attention-needs-action-convergence.testplan.yaml](../testing/platform/attention-needs-action-convergence.testplan.yaml)，并回归既有 [docs/testing/platform/desktop-slot-companion.testplan.yaml](../testing/platform/desktop-slot-companion.testplan.yaml)（重点核对 `DSC-003`、`DSC-004`、`DSC-007`、`DSC-010`、`DSC-013`）与 [docs/testing/terminal/runtime/osc-7501-status.testplan.yaml](../testing/terminal/runtime/osc-7501-status.testplan.yaml)。

- [ ] `pnpm testplan:validate docs/testing/platform/attention-needs-action-convergence.testplan.yaml` 与 `pnpm docs:check` 通过。
- [ ] `pnpm --filter @runweave/shared typecheck`、`pnpm --filter @runweave/backend typecheck`、`pnpm --filter @runweave/frontend typecheck`、`pnpm --filter ./electron typecheck`、`pnpm lint`、`pnpm architecture:check` 通过；若改动 Hook 脚本则通过 `pnpm agents:build` 与 `pnpm toolkit:verify-hooks`。
- [ ] 在受管桌面实例与 iOS 模拟器完成 `ATTNCONV-001` 至 `ATTNCONV-006` 真实交互取证：验证三类阻塞事实准确置顶、点击直达目标 Panel、处理或中断后立即清除、`working` 默认折叠不遮挡待处理项，且普通终端输出 `"error/blocked"` 仍零误报。
