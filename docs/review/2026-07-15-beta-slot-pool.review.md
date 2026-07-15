# Runweave Beta 五槽位池计划评审

- 评审对象：`docs/plans/2026-07-15-beta-slot-pool.md`
- 评审类型：计划评审（只评审，不修改计划或源码）
- 评审日期：2026-07-15

## 结论

当前计划不宜直接进入实现。按 sessionId 派生 Beta 安装目标确实会造成实例数量增长，固定槽位也是合理方向；但现方案仍有 5 个 P1 和 1 个 P2。最关键的问题是：槽位数量固定并不等于磁盘占用有界，且租约、reset、共享服务与 legacy 清理的所有权规则尚未形成可证明安全的闭环。

## 发现

### P1 严重

1. **五个槽位不能保证磁盘有界，当前方案仍会让 Runtime 与 App Server release 持续累积。** 计划把解决磁盘膨胀作为目标，却只限制 App、instance 目录和 home 的数量，并明确保留 warm runtime；当前 Runtime/App Server 安装逻辑每次用新 releaseId 创建 `releases/<id>`，没有淘汰旧 release，因此同一槽位反复更新仍可无限增长，BSP-002 只数 App 数量也发现不了。定位：`docs/plans/2026-07-15-beta-slot-pool.md:5`、`:123`、`:235`；证据：`scripts/runweave-update-operations.mjs:296`、`scripts/install-runtime-package.mjs:325`、`packages/shared/src/app-server/runtime-release.ts:100`。修复方向：先定义可量化的每槽/全池字节预算、安装临时空间放大系数和 release 保留策略（至少明确 current、rollback 所需 previous、构建产物、备份与失败产物），再让 BSP-002/BSP-008 以多轮不同 release 更新后的 `du` 平台值验收，而不只是 App 个数。

2. **`slots.json` 加 per-slot lock 没有单一原子真相，无法保证并发分配与 stop/reset 的互斥。** 两个不同 session 受各自 session lock 保护，仍可同时读同一份 `slots.json` 并更新不同槽位；仅有 per-slot lock 会产生共享 JSON 丢更新，先释放租约再 reset 还会让新 owner 在旧 owner 删除数据时拿到槽位。计划没有定义锁顺序、原子发布、崩溃恢复、同 inode/owner 校验，也没有规定租约必须在进程停止、volatile reset 和 manifest 落盘之后最后释放。定位：`docs/plans/2026-07-15-beta-slot-pool.md:88`、`:95`、`:193`、`:307`；证据：现有 session lock 只覆盖单个 session，见 `scripts/dev-session/registry.mjs:316`，而端口租约已有基于独占创建、hard link、文件身份校验和 owner 校验的实现，见 `scripts/dev-session/registry.mjs:358`。修复方向：用 5 个独立、原子发布的槽位 lease 文件作为唯一所有权真相，状态汇总从 lease + manifest 派生；生命周期固定为 `reserved -> starting -> ready -> stopping -> idle`，并将释放 lease 设为 stop/reset 成功后的最后一步。补充“session A 正在 reset 时 session B 尝试 acquire”和两个 session 同时拿不同槽位的交错验收。

3. **volatile reset 的删除边界不完整，会把上一 session 的身份与浏览数据带给下一 owner。** 计划列出的清理项没有覆盖 `userData` 根下的 `terminal-browser-tabs.json`、`backend-auth.json`、主 renderer 的 Chromium 存储，以及 App Server `cloud-sync` 等状态；现有 Terminal Browser 使用持久化 partition，测试 BSP-004 也只在已列目录写 marker，无法证明 Cookie、LocalStorage、IndexedDB、标签页和凭据被清空。定位：`docs/plans/2026-07-15-beta-slot-pool.md:110`、`:300`；证据：`electron/src/terminal-browser-runtime.ts:80`、`electron/src/terminal-browser-tabs-persistence.ts:9`、`electron/src/packaged-backend-auth.ts:50`、`packages/shared/src/app-server/paths.ts:19`。修复方向：不要维护易漏项的删除黑名单；将不可变 warm runtime 移出 mutable userData，或明确只保留 `runtime/current.json` 与受控 release 集合，其余 userData/App Server state 整体原子替换。BSP-004 必须验证 Cookie、LocalStorage、IndexedDB、持久标签、backend 凭据、event/cloud-sync 和 update state 均不跨 owner。

4. **计划没有决定池对 shared Backend/App Server 的所有权，目标路径与现有 planner 行为冲突。** 目标要求所有 Beta App Server 路径按 slot 隔离，槽位状态还记录 backend/appServer PID；但当前 Beta profile 会在相关代码未受影响时复用 shared Backend/App Server，`startDedicatedBeta()` 会把 shared home/lock/token 注入 Beta。若 janitor 把这些 PID 当槽位资源会误停共享服务；若不管理，则“每槽一个 App Server home”和 reset/验收标准不成立。定位：`docs/plans/2026-07-15-beta-slot-pool.md:54`、`:79`、`:118`、`:194`；证据：`scripts/dev-session/planner.mjs:344`、`scripts/dev-session/beta-service.mjs:92`、`scripts/dev-session/beta-service.mjs:221`。修复方向：明确二选一的 ownership matrix：推荐保留现有 impact closure，槽位只拥有 Electron 与实际 dedicated 的资源，shared 服务仅记录引用且永不被 slot janitor 清理；若产品目标要求每槽全隔离，则明确把 Beta profile 提升为 dedicated Backend/App Server，并接受启动、磁盘和验证成本。两种模式都要各有状态与 stop 用例。

5. **start 前按 `dvs-*`/`rcv-*` 名称自动删除 legacy 资源，无法同时满足“保留低层 legacy instance 能力”和所有权安全。** 新 pool 状态无法证明旧 checkout、手工低层命令或仍在使用的 legacy instance 归谁；仅凭名称和死 PID 删除 support dir 可能造成数据丢失，而拒绝删除无 owner 的目录又无法满足 BSP-009 的自动清理期望。定位：`docs/plans/2026-07-15-beta-slot-pool.md:135`、`:161`、`:208`、`:323`；证据：现有低层入口仍接受任意合法 instance，见 `scripts/runweave-beta.mjs:29`，现有 legacy migration 会先检查运行状态、备份、写 journal 并标记 `legacyPreserved`，见 `scripts/runweave-beta.mjs:130`、`:213`、`:289`。修复方向：start 前 janitor 只自动回收带受支持 schema/lease/manifest 且所有权可验证的 pool 资源；legacy 只做 inventory 和磁盘报告，删除改为显式 migrate/cleanup 命令，带备份/隔离区和恢复期限。新增“active legacy”“inactive 但无可信 owner”“路径为 symlink/身份漂移”的拒删用例。

### P2 一般

1. **dry-run 无法同时保持只读并给出权威 assigned slot，计划混淆了请求策略与实际分配结果。** 当前 `--dry-run` 在生成 sessionId、revision、manifest 和启动服务之前直接返回 planner 结果；真正槽位只能在非 dry-run 的并发锁内确定。若 dry-run 预占槽位就破坏只读语义，不预占则输出的 slot 可能在 start 前被别人拿走。定位：`docs/plans/2026-07-15-beta-slot-pool.md:193`、`:235`、`:257`；证据：`scripts/dev-session/cli.mjs:179`、`:192`、`:207`。修复方向：在契约中区分 `requestedSlotId/slotPolicy` 与 `assignedSlotId`；dry-run 只输出池规则和非承诺的 capacity snapshot，实际 start 获取 lease 后再把 assigned slot 原子写入 manifest，且验证 dry-run 不改变 lease、manifest 和目录 mtime。

## 更简单的复用方向

推荐保留固定 5 个 `slotId` 和路径，但删掉全局可写 `slots.json` 状态机，复用现有 dev-session manifest、服务 identity 检查和原子端口租约模式：

1. 每槽一个独占 lease 文件，内容只保存 `slotId`、`ownerSessionId`、manifest 路径、source revision 和 acquire identity；用现有安全文件发布/删除模式实现。
2. `status` 从 lease、session manifest 和实时服务握手派生，不重复持久化 PID、路径、state 等 19 个易漂移字段；需要 LRU/cleanup 摘要时写每槽非权威 metadata。
3. stop 在持有 lease 时完成 identity 校验、停止 dedicated 资源、整体替换 mutable state，最后释放 lease；shared 服务完全沿用现有 ownership，不纳入槽位清理。
4. legacy 清理做成显式、可回滚的迁移命令；start janitor 只处理本版本可证明拥有的 pool lease。

权衡：这会少一个可直接读取的全局快照，也不提供跨槽位事务；但池容量只有 5，状态可在常数时间内派生，换来单一所有权真相、更少 schema 迁移和更小的并发/误删面。若确实需要 `slots.json` 供 UI 展示，应把它降为可重建缓存，而不是租约真相。

## 残余风险与待确认项

- 5 是固定产品约束还是当前机器的运维默认值；若是后者，计划需要给出容量测算，而不是把数字写死为领域规则。
- warm runtime 为支持 rollback 最少保留几个 release、失败更新保留多久，尚无明确数字。
- pool 是否跨所有 worktree/branch 全局共享；若共享，需定义新旧 CLI schema 不兼容时的 fail-closed 行为。
- 显式 `--instance pool-0N` 是调试强制指定还是仅候选偏好；强制指定会提高占用冲突率，需要明确错误语义。

## 检查范围与命令摘要

- 阅读计划与 `docs/testing/beta-slot-pool-test-cases.md`。
- 核对 `scripts/dev-session/{cli,planner,registry,services,beta-service}.mjs` 的 dry-run、manifest、锁、shared/dedicated ownership 与 stop 调用链。
- 核对 `scripts/runweave-{update,beta}*.mjs`、Runtime/App Server release 安装、Electron userData 与 Terminal Browser 持久化路径。
- 未运行实现型验证、Playwright 或桌面验收：本次是计划评审，尚无对应实现可验收。
