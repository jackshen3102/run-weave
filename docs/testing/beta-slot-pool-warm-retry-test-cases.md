# Beta 槽位池 warm 重试测试案例

> 来源：`docs/plans/2026-07-15-beta-slot-pool.md`
>
> 本文继承既有 `BSP-` case ID 前缀，补充固定槽位 warm 重试场景；不改变已运行 Agent Team run 锁定的 BSP-001 至 BSP-016 验收快照。

## 执行规则

- 执行前必须重新核对 Given；前置不成立时结果为 `blocked`，不得把其他状态迁移或历史失败归入本用例。
- `$computer-use` 不可用时只把窗口证据标记为环境 `blocked`，不得据此判产品 `fail` 或触发 code repair。
- 失败重试必须保持同一 validation HOME、registry/manifest 归属链和 `pool-01`；只重置 mutable user state，不删除可追溯 warm App/runtime。

### BSP-017 stop/reset 后 warm 重试仍复用同一槽位

- Given：同一隔离 validation HOME 中 `pool-01` 的 warm App、Desktop Runtime 与 App Server Runtime 已存在；上一 owner 已完成 stop/reset，manifest 为 `stopped` 或 identity-safe `failed`，`pool-01` lease 已释放，mutable user state 已清空；记录 warm 产物与 Stable 摘要。
- When：显式执行 `pnpm dev:session --profile beta --instance pool-01 --json` 启动 session A，用 `$computer-use` 确认窗口后执行 `pnpm dev:stop --session <sessionA> --json`；确认 stop/reset 与 lease release 完成，再在同一 validation HOME 中再次显式请求 `pool-01` 启动 session B。
- Then：A 与 B 都分配 `pool-01`，各自 manifest/lease 的 ownerSessionId 与 nonce 在其生命周期内一致且两轮 nonce 不同；B 只能在 A 的 reset、stopped/failed manifest 落盘和 lease 释放后获取槽位；不创建或切换到其他 pool App/slot；warm App/runtime 归属链保留，Stable 摘要不变。
- 失败判断：A 未安全收敛便让 B 获取 lease、B 随机切换其他 slot、创建新的 App/slot、复用 A 的 nonce、删除 warm App/runtime、修改 Stable，或在 Given 不成立时仍强行重试。Computer Use 服务不可用时只把窗口证据标记为环境 `blocked`，不得据此判产品失败。
