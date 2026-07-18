# Worktree Terminal Context 代码复审（Round 6）

结论：通过。WTC-009 的刷新后 Preview 恢复缺陷已修复，本轮未发现 open P0/P1；`AGT-REVIEW-GATE` 应记为 `pass`。另记录 1 条不阻断本轮 gate 的 P2 持久化生命周期问题。

## Findings

### P2：Preview 持久化缺少连接作用域与 child 生命周期清理

新增的 Zustand persist 使用固定全局 key `runweave.terminal.preview.projects.v1`，而同一功能域的 recent selection 会把 `apiBase` 编入 storage key。与此同时，父 Project 删除路径只调用 `removeProjectPreview(targetProject.projectId)`；实际 Preview 状态现在按 effective child Project ID 分桶，因此父 Project 的 child 记录不会随删除被清理，外部移除的 child context 也没有清理路径。

- 风险：多个 backend/profile 若复用同一 Project ID，可能读到另一连接的 Preview path；父/child 生命周期结束后，文件路径和视图偏好仍长期留在 localStorage，并持续累积。
- 定位：`frontend/src/features/terminal/preview-store.ts:31-32,294-304`、`frontend/src/features/terminal/recent-selection.ts:14-16`、`frontend/src/components/terminal/terminal-workspace-actions.ts:263-275`。
- 修复方向：让 Preview persistence 与连接 scope 对齐，并在父 Project 删除或 child context 确认消失时级联裁剪对应 effective Project entries；无需为本轮 WTC-009 回滚持久化方案。

该问题不破坏本轮同一连接内的 WTC-009 恢复场景，按 P2 记录，不阻断 `AGT-REVIEW-GATE`。

## 已关闭问题

### P0（resolved）：WTC-009 刷新后丢失 Preview mode/path

`preview-store` 现在通过 Zustand persist 只保存 `projects` 分区；每个 effective Project ID 的 `mode`、`selectedFilePath`、`path` 等选择字段可在 reload 后 rehydrate，而 `ui` 与 `browser` 继续使用当前运行时初始值。该实现复用既有 `projects[effectiveProjectId]` 数据模型，没有引入第二套 Preview 映射。

- 定位：`frontend/src/features/terminal/preview-store.ts:294-304`。
- 独立 review harness：分别写入 `child-alpha/context.txt` 与 `child-beta/selected-preview.txt`，恢复后两个映射均保留；持久化 payload 顶层仅有 `projects`，`ui.activeTool` 保持重置后的 `browser`，断言 `pass=true`。
- code worker 的同场景真实产品交接显示，reload 后 Alpha 仍为 Explorer/context.txt，随后切换 Beta 恢复 Explorer/selected-preview.txt；该证据仅作为修复交接，不替代后续独立 `behavior_verify`。

## 审查范围

- 核对 round 6 code dispatch `26542ed6-a857-4df5-8dd7-75cbf24cc855` 与当前 reviewer dispatch `fdd9fe24-0a16-4381-af8a-903c00ec2aae`。
- 重新读取当前 live diff，重点审查 `frontend/src/features/terminal/preview-store.ts` 的持久化、rehydration、transient-state 边界和清理调用点；未复用 round 2 outbox 结论。
- 本轮 run 的 `reviewCheckpoint` 为 `null`，因此以 WTC-009 repair cycle、code outbox 和当前 live source 为复审边界。

## 已执行验证

- 独立 Zustand persistence harness：通过，输出 `persistedKeys=["projects"]`、Alpha/Beta path 分别恢复、`pass=true`。
- `pnpm --filter @runweave/frontend typecheck`：通过。
- `pnpm lint`：通过。
- `git diff --check -- . ':(exclude)docs/review'`：通过。

本轮是 code review；未启动新的 Dev Session，也不把静态 harness 或 code worker 的运行时交接表述为 reviewer 自己完成的真实产品验收。
