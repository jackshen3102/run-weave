# Environment blocker recovery hardening 代码评审

## 结论

未发现 P0/P1。上一轮识别出的两个 P1 已闭合：framework repair successor 不再继承旧恢复调度状态；environment recovery 的唯一 fingerprint/代表 Case 约束已在 Run 写入前由后端强制执行。当前剩余副作用均为可控、可审计的预期行为变化。

## 预期行为变化

- **歧义 recovery 请求由批量派发改为 400 零副作用。** 显式混选普通 Case、case-scoped blocker、未知 Case 或多个 fingerprint 会在 `updateRun()` 前拒绝；这会让少数旧调用从成功变为失败，但避免批量清空验收状态。定位：`backend/src/agent-team/service-acceptance-policy.ts:127`、`backend/src/agent-team/service-intervention.ts:188`。
- **显式选择同 fingerprint 的后序 Case 时，后端仍派 acceptance 顺序中的首个 Case。** 这是保证确定顺序的设计，不再严格照搬调用方选择的后序 Case；实际派发 Case 会写入 intervention history 和 logs。定位：`backend/src/agent-team/service-acceptance-policy.ts:156`、`backend/src/agent-team/service-intervention.ts:201`。
- **Framework repair successor 不再携带 predecessor 的最新 observation。** successor 是全新 Run，Case 从 pending 开始；旧 observation 和 environmentRecovery 审计仍保留在 predecessor，没有证据丢失。定位：`backend/src/agent-team/service-framework-repair.ts:557`。

## 残余风险

- **P2：更新前已收到旧 prompt 的 v1 behavior worker 可能多走一次协议补交。** environment skip 新增必填 fingerprint/scope，但 protocol version 仍为 1；现有一次 protocol correction 可恢复，补交再次失败才进入 `need_human`。这是原 fingerprint 功能的兼容成本，本次 hardening 没有扩大它。定位：`backend/src/agent-team/service-acceptance-policy.ts:346`、`backend/src/agent-team/service-repair-protocol.ts:84`。建议保留协议补交失败率监控，不为此扩大为协议迁移。
- **P2：恢复 campaign 的 dispatch/持久化/fixture cleanup 次数与待跑 Case 数线性增长。** 一次只派一个 Case 是“首个真实产品失败即停”的必要代价；没有新增轮询或无界重试，复杂度为 O(N)。定位：`backend/src/agent-team/service-acceptance-policy.ts:51`、`backend/src/agent-team/service-round-execution.ts:151`。建议只在真实大型测试计划中观察耗时，无需提前增加批量配置。
- **P3：fingerprint 语义仍依赖 worker 正确归类。** 错误复用同一 fingerprint 最坏会使同组 Case 额外重跑，不会直接产生 pass；旧 observation 仍保留在 environmentRecovery 中。定位：`backend/src/agent-team/service-acceptance-policy.ts:97`、`backend/src/agent-team/service-acceptance-policy.ts:167`。

## 验证证据

- `git diff --check`：通过。
- `pnpm typecheck`：通过。
- `pnpm lint`：通过。
- `pnpm agent-team:verify-control-plane`：19/19 通过。
- `pnpm agent-team:verify-framework-recovery`：25/25 通过。
- Service 层多 fingerprint intervention 返回 400 后，Run JSON 字节级不变。
- Framework repair 实际 rerun 后，predecessor 保留 environmentRecovery，successor 的 latestObservation/environmentRecovery 均为 null。

## 判断

可以继续交付。无需为了消除这些低风险成本升级协议、修改 CLI/API、增加 UI 或引入新的恢复子系统；这些动作的影响面会显著大于当前残余风险。
