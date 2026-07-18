# Agent Team 框架修复与重启恢复 Code Review（Round 9）

## 结论

通过 `AGT-REVIEW-GATE`。本轮未发现 open P0/P1。ATFR-006 的根因修复位于 RunStore 当前 Run 选择边界：同一 terminal session 存在终态 predecessor 与非终态 successor 时优先返回非终态 Run；不存在非终态 Run 时回退到按 `updatedAt` 排序的最新终态 Run。

## 审查结果

- `backend/src/agent-team/storage/run-store.ts:58-71` 先限定 `terminalSessionId`，再选择第一个非 `done`/`failed` Run；`listRuns` 已按 `updatedAt` 降序，因此多个候选时仍保持最新优先。
- 该规则由 RunStore 统一提供，API `/runs?terminalSessionId=...`、CLI export、Agent Team 面板轮询、completion signal 和新 Run 冲突检查使用同一事实源，没有新增 UI 启发式或额外状态字段。
- 正常 rerun 中 predecessor 最终为 `failed`，successor 为 `running`，因此 predecessor 即使最后更新也不会遮蔽 successor；旧 Run 仍可通过明确 runId 读取。
- 全部 Run 进入终态后，查询回退到最新终态 Run，不会让面板变成空状态。
- 跨 terminal session 的候选在选择前已过滤，不会串选其他终端的活动 Run。

## 独立探针

使用真实 `LowDbTerminalSessionStore`、`TerminalSessionManager` 和 `AgentTeamRunStore` 写入三组候选：

1. terminal A：更新时间更晚的 failed predecessor + 更新时间更早的 running successor。
2. 将 terminal A 的 successor 更新为最新 done Run，验证全终态回退。
3. terminal B：独立 running Run，验证 terminal 隔离。

输出：

```json
{
  "activeSelection": "atr_r9_succ",
  "terminalFallback": "atr_r9_succ",
  "otherSelection": "atr_r9_other"
}
```

三项均符合合同。

## 证据与门禁

- Code Agent 同场景真实产品 After 证据显示 terminal-bound CLI 持续返回 running successor，Agent Team 面板稳定显示 successor 的 `CODE / round 1`，旧新 Run 的双向关联和执行结论隔离保持成立。
- `pnpm agent-team:verify-framework-recovery`：21 项通过，包含 `ATFR-006-terminal-session-selects-active-successor` 以及此前 rerun rollback 负向场景。
- `pnpm typecheck`：通过。
- `pnpm lint`：通过。
- `git diff --check`：通过。

## 范围说明

本轮仅进行代码审查和可执行 RunStore 探针，没有修改被审查的实现、配置或测试。
