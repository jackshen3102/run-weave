# BSP-001 测试用例与执行链评审

## 结论

BSP-001 的产品目标合理：首次 Beta start 必须只获取一个合法槽位，lease/manifest 一致，并且不能影响 Stable。

当前长时间未通过的主因不是这组核心断言过严，而是执行链在第一次运行后改变了测试前置与命令，却仍把后续结果归到 BSP-001。后续实际场景已经从“空池默认分配”变成“固定 pool-01 的 warm 重试与 stale recovery”，应分别由 BSP-002、BSP-007、BSP-015 承担。

当前不应把 BSP-001 标记为持续产品失败；更准确的状态是：早期 symlink sizing 代码缺陷已修复，随后一次 backend readiness 失败把环境推进到可追溯的 stale/fail-closed 状态，现阶段复现被该状态阻塞。

## 评审发现

- **P1：实际执行不再满足 BSP-001 的 Given/When，失败归因失真。** 文档要求隔离 HOME 中没有 pool lease/App/slot，并通过不带 `--instance` 的 `pnpm dev:session --profile beta --json` 验证默认分配；后续执行却保留 warm App/runtime 并显式使用 `--instance pool-01 --session dvs-3946ca`。这既跳过了默认 allocator 选择路径，也不再是首次冷启动。修复方向：BSP-001 只在精确空池前置下执行一次；固定同槽 warm 重试改由 BSP-002 或新增继承 `BSP` 前缀的独立用例承接。定位：`docs/testing/beta-slot-pool-test-cases.md:77-82`。

- **P1：执行器把其他用例的 fail-closed 结果继续回灌为 BSP-001 代码修复。** backend 未健康后，自动恢复产生 identity drift，manifest 进入 stale 且 lease 保留；这正是 BSP-007 的“身份不可证则不清理”和 BSP-015 的“reset 失败则保留 lease”语义。继续以 BSP-001 repairKey 重试只会被 stale owner 链挡住，无法重新进入首次 start。修复方向：BSP-001 在环境无法恢复时标记 `blocked`，把 stale recovery 交给 BSP-007/BSP-015；只有恢复到 BSP-001 原始 Given 后才允许重跑。定位：`docs/testing/beta-slot-pool-test-cases.md:119-124`、`docs/testing/beta-slot-pool-test-cases.md:175-180`、`.runweave/agent-team/atr_6828267c_20260715095649.json`。

- **P2：窗口证据与槽位核心断言耦合，Computer Use 服务故障会遮蔽产品结果。** `$computer-use` 窗口确认有价值，但 Sky 服务启动失败属于验收基础设施阻塞，不能自动等价为槽位分配代码失败。修复方向：保留窗口证据要求，但将其结果单独记录为 `pass/fail/blocked`；只有真实看到错误窗口行为才判产品 fail，工具不可用应暂停验收而非抛回 code。定位：`docs/testing/beta-slot-pool-test-cases.md:80-82`。

未发现 P0。

## 为什么修了很久

这不是同一个 Bug 连续修不掉，而是至少四段不同问题被串在同一个视觉状态里：

1. 前几轮 `case_17` 处理的是 Agent Team 固定 pane/thread、resume/readiness 与交接协议，不是 BSP-001 产品逻辑。
2. BSP-001 首次真实运行暴露 App bundle 内标准 Framework symlink 被容量估算误拒绝；这是代码 Bug，已由 checkpoint `3a0bfa100b9b8af30b8b20b158f99cc2a6433f6d` 修复并通过对应 verifier/reviewer。
3. 修复后下一次真实 start 越过 sizing，却在 backend health 阶段超时并自动恢复到旧版本；这是新的启动链问题，不是 symlink 修复失败。
4. 自动恢复后的 process identity 与 planned manifest 不再可安全对应，系统按设计保留 `pool-01` lease。此后所有同 Session 重试都会在进入 backend 前 exit 5；这时继续要求 code worker“复现 BSP-001 再修”在逻辑上不可完成。

当前证据还表明 Activity 初始化可能占有 backend readiness，但这只是候选根因；在相同真实场景无法重新进入 backend 启动链前，不能把它确认为代码 Bug，更不能标为 P0/P1。

## 建议的最短闭环

1. 将当前 BSP-001 结果改为 `blocked/inconclusive`，不要继续累计为产品 fail。
2. 人工按 owner/nonce/manifest 归属链安全收敛 `dvs-3946ca`；不得直接删 lease 或随机换 slot。
3. BSP-001 若要验默认分配，应恢复真正空池前置，并执行文档原命令，不带 `--instance`。
4. 若目标是验证“失败后仍复用同一个 pool-01”，应使用独立 warm-retry 用例：同一 validation HOME、显式 pool-01、warm App/runtime 保留、mutable state 已 reset、lease 已释放。它不能继续冒充 BSP-001 的首次冷启动。
5. Computer Use 不可用时把 UI 证据标记为环境 `blocked`；CLI/manifest/lease/Stable 证据可以记录，但不能代替窗口通过，也不能触发 code repair。

## 检查范围

- `docs/testing/beta-slot-pool-test-cases.md`
- `docs/plans/2026-07-15-beta-slot-pool.md`
- `.runweave/agent-team/atr_6828267c_20260715095649.json`
- `dvs-3946ca` manifest、`pool-01` lease 与 update 日志
- 当前 code worker pane-scoped outbox

本次仅评审并新增本报告，未修改源码、测试用例文档、run 状态、Git HEAD/index 或验证环境。
