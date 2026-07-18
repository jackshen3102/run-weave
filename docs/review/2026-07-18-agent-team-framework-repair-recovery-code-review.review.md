# Agent Team 框架修复与重启恢复代码审查

## 结论

未通过 `AGT-REVIEW-GATE`：当前实现仍有 2 个未修复 P1，均会破坏框架修复后的恢复闭环。现有 typecheck、lint、行为脚本和 diff 检查全部通过，但行为脚本没有覆盖这两条负向路径。

## 审查边界

- Dispatch：`43ca4163-fcc3-4878-9f16-dbd8ab88638a`
- Run：`atr_a07db00d_20260717170123`
- 计划：`docs/plans/2026-07-17-agent-team-framework-repair-recovery.md`
- Case：`docs/testing/agent-team/agent-team-framework-repair-recovery-test-cases.md`
- 实现：共享合同、Backend framework repair service/route、CLI、前端 Agent Team 面板和行为验证脚本。
- `reviewCheckpointMode=disabled`，运行包没有 `reviewTarget`；本次以计划、Code Worker outbox 与当前 framework-repair diff 的交集为审查边界。
- 排除当前工作树中与本 Run 无关的 `worktree-terminal-context` 计划、原型、测试文档及其已有 review 报告。

## 阻断发现

### P1：continue 丢失当前 code 修复 dispatch 的 repairKeys

`beginFrameworkRepair` 把旧 dispatch（含 `repairKeys`）保存到 `frameworkRepair.target.invalidatedDispatch`，但 `continueFrameworkRepair` 创建 fresh dispatch 时没有把这些 key 传给 `createActiveWorkerDispatch`（`backend/src/agent-team/service-framework-repair.ts:83`、`:129`）。工厂因此把 `repairKeys` 默认为空数组（`backend/src/agent-team/service-workflow-policy.ts:141`），而 code outbox 校验遇到空 key 会直接返回 valid（`backend/src/agent-team/repair-loop.ts:375`）。

影响：若框架问题发生在 blocking finding 已回派 code 的修复阶段，continue 后的 code worker 不再被要求提交对应 `fixVerifications`；修复尝试计数、Before/After 证据和同场景验证均可被绕过，Run 仍可能继续进入 code_review/behavior_verify。该行为违反 ATFR-003 的“只重新派发保存的恢复目标”和“保留可信 repair 历史”要求。

修复方向：fresh dispatch 必须继承被撤销 dispatch 的 backend-owned `repairKeys`，并在完整替代 prompt 中恢复相同的修复交接合同；补充一个带非空 repair cycle/repairKeys 的 continue 行为断言。

### P1：checkpoint 模式 rerun 失败会留下已切换分支和部分 pane

`rerunFrameworkRepair` 在 successor split 成功前调用 `createRerunReviewCheckpoint`（`backend/src/agent-team/service-framework-repair.ts:214`）；该 helper 立即执行 `git switch -c`（`:415`、`backend/src/agent-team/review-checkpoint-git.ts:76`）。随后 `applySplit` 逐个创建 worker pane，任一后续 split 失败即可抛错（`backend/src/agent-team/service-execution.ts:89`），但 rerun 外层没有回滚新分支或已创建 pane（`backend/src/agent-team/service-framework-repair.ts:266`）。

影响：旧 Run JSON 虽仍是 blocked，实际 worktree 已离开旧 checkpoint branch，并可能存在只创建了一部分的 successor panes；继续旧 Run 会在错误分支上工作，重试 rerun 还会继续制造新分支/别名。这违反 ATFR-007“第一次失败不创建半成品、旧现场不受损且可直接重试”的要求。

修复方向：在所有可失败的校验和资源准备完成前不要切分支；为 branch/pane/new-run 建立显式 rollback，或把 successor 创建改为可恢复的事务状态并让重试复用同一 successor 身份。补充 local_commit 模式下第 2/3 个 pane 创建失败的验证。

## 验证结果

- `pnpm typecheck`：通过。
- `pnpm lint`：通过。
- `pnpm agent-team:verify-framework-recovery`：通过，16 条检查；该脚本把 rerun 的 `applySplit` 替换为成功 harness，且 continue fixture 没有非空 `repairKeys`，因此未覆盖上述问题。
- `git diff --check`：通过。
- 未执行 Playwright：本轮是代码审查门禁，结论来自结构性状态机合同；真实 UI 验收仍属于 behavior_verify worker。

## 剩余风险

在两个 P1 修复并补齐负向路径验证前，不应通过 Code Review 门禁。
