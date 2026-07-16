# Runweave Beta 五槽位池 case_17 Recheck

## 结论

`case_17` 通过。fresh dispatch `594405d6-dd3a-4748-af61-b4458a05b70e` 明确声明当前 checkpoint 已通过指定范围的 code review；本轮核对确认 round 1 的两个 blocking P1 均已有对应代码修复：slot-owned service 未静默前禁止 reset/release，磁盘预算改为累计四个估算分量。

本轮不重新执行独立 full code review，不覆盖 round 1 的历史失败报告，也未修改业务代码。

## 证据

- Dispatch：`.runweave/agent-team/atr_6828267c_20260715095649.json` 中 `activeWorkerDispatch.dispatchId=594405d6-dd3a-4748-af61-b4458a05b70e`、`round=2`、`reviewTarget=null`、`repairKeys=[]`。
- Lease fail-closed：`scripts/dev-session/cli.mjs:346-369,549-558` 在 post-start cleanup 中先 stop，在 stale identity 未清除时拒绝 reset/release；`scripts/dev-session/services.mjs:338-360` 区分已退出进程与仍存活的 identity drift。
- 磁盘加法预算：`scripts/dev-session/beta-slot-pool.mjs:567-588` 用 `reduce` 累加 App、Desktop Runtime、App Server Runtime 与 tracked source 四个分量。
- 静态门禁：`git diff --check` 及五个相关 `.mjs` 的 `node --check` 均退出 0。

## 残余风险

- `pnpm dev:session:verify` 未通过：`verifyRegistry` 在新增 stale-cleanup 断言处报 `Missing expected rejection`。该命令未作为 `case_17` 通过证据；需由后续实现/行为验证单独收敛。
- 本结论只消费本 dispatch 的指定范围 review 状态并核对两项历史 P1 的修复落点，不代替 BSP-001 至 BSP-016 的真实行为验收。
