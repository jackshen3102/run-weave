# Beta 固定资源池可解释投影与最终回收实施计划

> 状态：历史实施计划；全部 12 条测试合同已合并到当前 Beta Pool 控制面计划
> 粒度：L3（进程终止、lease 释放、并发竞争与崩溃恢复）
> 来源：`docs/architecture-flows/beta-resource-management/`
> 当前测试计划：`docs/testing/platform/beta-pool-storage-migration.testplan.yaml`

> 测试范围说明：原 `BRM-001`～`BRM-012` 的行为与断言全部保留，并映射为控制面 YAML 中的 `BETA-003`～`BETA-014`。长期重复运行、真实 CDP 与跨 owner 资源边界由 `beta-pool-runtime-regressions.testplan.yaml` 独立覆盖，本文其余内容作为对应实现背景继续有效。

## 1. 目标

把 Beta 固定 5 槽从“只知道 lease 是否存在”升级为可解释、可恢复的资源控制面：

1. 同时读取 slot lease、Dev Session manifest、runtime identity 和最近恢复结果；
2. 向操作者解释每个槽位为什么健康、部分失效、可回收或必须人工处理；
3. 清理全部已无运行进程且身份可证明的空壳资源；
4. 当分配即将因容量不足失败时，自动回收持续异常且身份完全可证明的最少数量 partial Session；
5. 任一身份信号不匹配或不可知时继续 fail closed，不误杀其它 Session；
6. 自动恢复成功后由同一个 `dev:session start` 继续竞争 lease 并启动，不要求人工重试。

最终必须满足下面的不变量：

```text
存在安全可回收候选时，新的 Beta start 不得直接以 pool full 结束。

任何 slot reset 或 lease release 都必须发生在 recovery claim 内，并在执行时重新证明安全条件；
只读 projection 的 derivedState 或 recovery.eligible 不能单独授权删除资源。
```

## 2. 当前代码事实与差异

| 主题         | 当前事实                                                                                                                  | 目标差异                                                                                                |
| ------------ | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Capacity     | `inspectBetaSlotCapacity()` 只读取五个 lease，返回 `idle / occupied / broken` 和 `authoritative: false`                   | 增加纯只读 pool projection，联合 lease、manifest、owned runtime、shared dependency 和 recovery metadata |
| allocator    | lease 中的 `allocatorPid` 是创建 lease 的短命 CLI PID，capacity 输出同时暴露 `allocatorLive`                              | 保留底层字段用于 orphan 启动保护，但在新投影中只作为 acquisition 诊断，不参与 runtime 健康判断          |
| Session 收敛 | `dev:status` 会调用 `inspectSessionServices()`，把单 Session 的 `ready` 收敛为 `stale`                                    | pool 查询和分配前也执行只读 runtime 检查；projection 自身不写 manifest                                  |
| Janitor      | `runBetaPoolJanitor()` 遇到 `ready / stopping` 直接视为 active；返回的 `recovered / active / broken` 被 `runStart()` 丢弃 | 分离只读判断与有副作用恢复；start 返回并持久化恢复 receipt                                              |
| 清理安全     | janitor 有 recovery claim，stop 有 Session lock；janitor 当前没有获取 owner Session lock                                  | 自动处理 ready/partial 前必须同时持有 recovery claim 与 owner Session lock                              |
| Release 顺序 | stop/janitor 可能先写 `stopped` manifest，再释放 lease                                                                    | 引入可收敛的 `stopping + release_pending → release lease → stopped` 事务，处理任一步崩溃                |
| Metadata     | 每个 slot metadata 只保存最后成功释放和清理摘要                                                                           | 继续有界存储，增加最近一次成功、阻塞或保留的 recovery attempt                                           |
| 操作入口     | 只有单 Session `dev:status` 和低层单实例 Beta status，没有五槽全局视图                                                    | 增加独立的 `dev:pool` CLI/JSON；首期不建设产品 UI                                                       |

关键代码位置：

- `scripts/dev-session/cli.mjs`
- `scripts/dev-session/cli-stop.mjs`
- `scripts/dev-session/contracts.mjs`
- `scripts/dev-session/registry.mjs`
- `scripts/dev-session/services.mjs`
- `scripts/dev-session/beta-slot-pool-core.mjs`
- `scripts/dev-session/beta-slot-pool-janitor.mjs`
- `scripts/dev-session/beta-slot-pool-storage.mjs`
- `scripts/dev-session/service-runtime.mjs`
- `scripts/runweave-beta-state.mjs`

## 3. 已冻结的产品与安全规则

1. 不增加 heartbeat、后台 daemon 或秒级 watcher；在 `dev:pool`、`dev:status` 和分配前按需检查。
2. projection 是纯只读快照，带 `observedAt`，不写 manifest、lease、metadata 或 runtime 文件。
3. `derivedState` 只用于展示、排序和告警；自动恢复在 claim/lock 内重新执行结构化安全谓词。
4. 无 slot-owned 运行进程且可证明安全的空壳，在每次 Beta start 时全部清理。
5. 仍有 owned 组件存活的 partial，只在容量压力下回收，并且只回收满足当前分配所需的最少数量。
6. ready/partial 候选必须检查两次，默认间隔 5 秒；第二次已恢复健康则保留。
7. owner Session lock busy 时跳过候选，不等待、不抢锁，继续尝试其它候选。
8. shared dependency 异常不触发 slot 回收；只有 `ownership: dedicated` 的 slot-owned runtime 异常才构成候选。
9. 身份存在 `unknown` 或 `mismatch` 时禁止自动停止、reset 和 release。
10. 提供定向 recover，但不提供绕过身份检查的 force kill/force release。
11. 自动恢复成功后原 Session 进入 `stopped`；失败且 lease 仍保留时进入 `stale`，不新增 manifest 状态枚举。
12. 自动恢复 receipt 同时出现在触发 start 的输出、原 Session manifest 和 slot metadata。
13. 显式请求 `--instance pool-0N` 时保持精确目标：健康占用直接失败，可安全恢复时只恢复该槽位，不回退其它槽位。
14. 首期只交付 CLI/JSON 控制面，不修改 Electron、Frontend 或 App UI。

## 4. 非目标

- 不扩大固定池容量，不创建 `pool-06` 或动态实例。
- 不删除 `allocatorPid` 或迁移现有 lease schema；只纠正其展示语义。
- 不把 lease TTL 当成 owner 活性，不根据 manifest 年龄直接杀进程。
- 不自动停止 shared Backend/App Server。
- 不因为容量不足降低 PID、process signature、lock、health、CDP 或路径引用验证。
- 不物理删除损坏 lease 的诊断证据；安全恢复时移动到 quarantine。
- 不引入无限增长的 recovery event log；每个 Session 保存自己的最终 receipt，每个 slot 只保存最近一次 attempt。
- 不新增单元测试/TDD 文件；使用现有 verifier、临时 HOME/fixture、YAML 测试计划和实际 CLI 行为验证。
- 不在本计划实现之外顺手重构 Dev Session CLI、Beta 更新器或其它资源池。

## 5. 目标只读投影合约

### 5.1 顶层结构

新增 `inspectBetaPool()`，返回 schema v1：

```js
{
  schemaVersion: 1,
  policy: "fixed-pool-v1",
  observedAt: "2026-07-18T...Z",
  reservationGuaranteed: false,
  capacity: 5,
  summary: {
    idle: 1,
    healthy: 1,
    partial: 1,
    degradedShared: 0,
    staleReclaimable: 2,
    staleManual: 0,
    broken: 0
  },
  slots: []
}
```

`reservationGuaranteed: false` 表示这是观察快照，不是 lease 预留；真实分配仍以 hard-link 原子发布为准。

### 5.2 Slot 结构

```js
{
  slotId: "pool-02",
  lease: {
    state: "valid", // absent | valid | corrupt
    owner: {
      sessionId: "dvs-dcaf25",
      leaseNonce: "...",
      sourceRoot: "/abs/path",
      revision: "..."
    },
    acquisition: {
      pid: 12345,
      processLive: false,
      role: "short-lived-launcher",
      affectsRuntimeHealth: false
    },
    acquiredAt: "...",
    failureReason: null
  },
  manifest: {
    readState: "valid", // absent | valid | corrupt | owner_mismatch
    state: "ready",
    sessionId: "dvs-dcaf25",
    sourceRoot: "/abs/path",
    updatedAt: "...",
    failureReason: null
  },
  runtime: {
    ownedComponents: {},
    sharedDependencies: {},
    ownedHealth: "partial", // healthy | partial | absent | unknown
    sharedHealth: "healthy" // healthy | degraded | unknown
  },
  derivedState: "partial",
  reasons: ["owned-electron-absent", "owned-backend-absent"],
  recovery: {
    eligible: true,
    mode: "capacity_pressure", // none | hygiene | capacity_pressure | manual
    requiresCapacityPressure: true,
    checks: {},
    blockedBy: [],
    suggestedAction: "automatic-on-capacity-pressure"
  },
  metadata: {
    lastReleasedAt: null,
    lastRecoveryAttempt: null
  }
}
```

`recovery.eligible` 只是本次观察结论；执行者不得把它当 capability token。所有 mutation 必须在 claim/lock 内重读 lease、manifest 和 runtime 后重新求值。

### 5.3 展示状态

固定使用以下有限枚举：

| `derivedState`      | 含义                                                 | 自动策略                                                     |
| ------------------- | ---------------------------------------------------- | ------------------------------------------------------------ |
| `idle`              | lease 不存在                                         | 可正常分配                                                   |
| `healthy`           | lease、manifest、全部 required runtime 身份一致      | 保留                                                         |
| `partial`           | 至少一个 slot-owned required 组件异常                | 仅容量压力下进入二次检查                                     |
| `degraded-shared`   | slot-owned runtime 健康，只有 shared dependency 异常 | 保留并报告 shared blocker                                    |
| `stale-reclaimable` | 无 slot-owned 运行进程，且安全证据完整               | hygiene 自动清理                                             |
| `stale-manual`      | 有身份 mismatch/unknown 或其它不可自动证明条件       | 拒绝自动操作                                                 |
| `broken`            | lease/manifest/路径等事实损坏，尚未证明可 quarantine | 默认阻塞；零进程且文件身份稳定时可由 guarded quarantine 恢复 |

不得为了每一种具体原因扩张枚举；细节进入 `reasons`、`checks` 和 `blockedBy`。

## 6. Recovery receipt 与持久化

### 6.1 Receipt 合约

统一使用 schema v1：

```js
{
  schemaVersion: 1,
  attemptId: "uuid",
  attemptedAt: "...",
  completedAt: "...",
  trigger: "startup_hygiene", // capacity_pressure | explicit_recover
  initiatingSessionId: "dvs-new-session",
  slotId: "pool-02",
  ownerSessionId: "dvs-old-session",
  leaseNonce: "...",
  previousManifestState: "ready",
  previousDerivedState: "partial",
  result: "recovered", // preserved | blocked | failed
  checks: {},
  stoppedServices: ["appServer"],
  blockedBy: [],
  releasedLease: true,
  quarantinedLeasePath: null,
  failureReason: null
}
```

约束：

- Receipt 不包含 token、Cookie、Authorization、JWT 或 App Server secret。
- 对外输出的路径仅限 manifest、lock、status 和日志路径，不读取或复制用户行为数据。
- `blocked` 与 `failed` 必须保存；不能只有成功记录。
- owner manifest 增加可选 `poolRecovery` 字段；这是 additive 兼容字段，不提升 `DEV_SESSION_SCHEMA_VERSION`。
- slot metadata 提升到 schema v2，保留既有 `lastRevision / lastReleasedAt / lastCleanupSummary / lastDiskSummary`，新增 `lastRecoveryAttempt`。
- 正常 stop 后更新 metadata 时必须 merge，不能意外丢弃最近的 recovery attempt。

### 6.2 Manifest 终态

```text
自动恢复成功：stopped + poolRecovery.result=recovered
恢复阻塞/失败且 lease 保留：stale + poolRecovery.result=blocked|failed
观察后恢复健康或 lock busy：原状态不变，metadata/start receipt 记录 preserved
```

## 7. 恢复事务与并发顺序

### 7.1 锁顺序

所有自动或显式 pool recovery 固定使用同一顺序：

```text
slot recovery claim
  → owner Session lock（owner 可解析时）
  → assert 当前 lease file identity + ownerSessionId + leaseNonce
  → 重读 manifest
  → 重做 runtime 安全检查
  → mutation
```

- recovery claim busy：记录 `preserved/recovery-claim-busy`。
- Session lock busy：记录 `preserved/owner-session-busy`，释放 claim 并尝试下一候选。
- 不允许某条路径使用相反锁序。
- corrupt lease 无法解析 owner 时不获取 Session lock；它只能走“零进程 + 稳定文件 identity + quarantine”的严格分支。

### 7.2 可收敛 release 顺序

抽取一个供 normal stop、start-failure cleanup 和 janitor 共用的 Beta slot finalizer，顺序固定为：

```text
停止或确认没有 slot-owned 进程
  → 再次确认 slot process/path references absent
  → reset mutable state
  → retention
  → 写 release metadata 和 release_pending receipt
  → manifest 保持 stopping，poolRecovery.phase=release_pending
  → 原子 release/quarantine lease
  → manifest 写 stopped，poolRecovery.phase=completed
```

崩溃收敛规则：

- lease 仍在、manifest 为 `stopping/release_pending`：下次 status/janitor 继续完成，不把它当 active。
- lease 已不存在、manifest 仍为 `stopping/release_pending`：下次 status 将 manifest 收敛为 `stopped/completed`。
- reset、metadata 或 release 任一步失败：lease 必须仍保留，manifest 进入 `stale` 并保存 failure receipt。
- 不允许先让 lease 消失再执行 mutable reset。

### 7.3 损坏 lease quarantine

仅在 recovery claim 内、确认所有 slot 进程和路径引用均不存在、且 lease 文件 inode/identity 未变化后执行：

1. reset mutable state 与 retention；失败则原 lease 不动；
2. 写 blocked/recovery metadata；
3. 将损坏 lease 原子移动到 `pool/quarantine/<operationId>/lease.json`；
4. 保存 `operation.json`，包含 slot、时间、原文件 identity、检查结果，不包含秘密；
5. 只有 rename 成功后槽位才视为 idle。

第一阶段不提供恢复 quarantine lease 回原位的自动入口；它是审计证据，不再代表 active ownership。

## 8. Janitor 与分配算法

### 8.1 启动卫生阶段

每次 Beta start 在创建新 manifest 之前执行：

1. 生成 projection；
2. 回收全部 `stale-reclaimable`；
3. 对 `broken` 只执行满足零进程 quarantine 谓词的分支；
4. 记录并返回本轮 `recovered / preserved / blocked / failed` receipts；
5. 不停止仍有 owned live components 的 partial。

### 8.2 容量压力阶段

正常 lease acquisition 无可用槽位，或显式 requested slot 被 partial/stale 占用时进入：

1. 重新生成 projection；
2. 排除 healthy、degraded-shared、manual、busy 候选；
3. 按下面顺序排序：
   - runtime absent 的 valid stale；
   - runtime absent 且可安全 quarantine 的 corrupt lease；
   - manifest 非活跃、仍有身份可证明残余进程；
   - `ready + partial`；
4. 同一级按 `acquiredAt` 最早优先；缺少可信 acquiredAt 的 corrupt lease排在 valid lease 之后；
5. 对含 live owned components 的候选在持锁后检查两次，间隔 5 秒；
6. 第二次仍 partial 且全部 live process identity 匹配时停止剩余 dedicated services；
7. 只恢复满足本次所需容量的最少数量，默认 1；
8. 回到原子 lease acquisition，不把旧 lease 直接转交给新 Session。

并发 start 使用有界循环，最多重新投影/分配 `BETA_SLOT_CAPACITY + 1` 轮；超出后返回 `capacity-won-by-concurrent-allocator`，同时保留已完成的 recovery receipts。

### 8.3 Shared dependency

projection 必须按 manifest 的 `ownership` 分组：

- `dedicated` required service 进入 `runtime.ownedComponents`；
- `shared-declared` 进入 `runtime.sharedDependencies`；
- shared 异常只产生 `degraded-shared` 或 shared blocker，不进入 slot recovery predicate；
- cleanup 继续只操作 dedicated services。

## 9. CLI 合约

在 `package.json` 增加：

```json
{
  "dev:pool": "node ./scripts/dev-session/pool-cli.mjs"
}
```

### 9.1 查询

```bash
pnpm dev:pool
pnpm dev:pool --json
```

- 默认输出五行人类可读表格：slot、derived state、owner Session、owned runtime、recovery mode、首个 blocker。
- `--json` 输出完整 projection。
- 查询始终返回 observation，不创建目录、claim、manifest、lease 或 metadata。
- 单个槽位事实损坏时仍返回其它四个槽位；命令整体只有在 pool root 安全边界无法建立时才非零退出。

### 9.2 定向恢复

```bash
pnpm dev:pool recover --slot pool-03 --session dvs-xxxxxx --json
pnpm dev:pool recover --slot pool-03 --json
```

- valid lease 且 owner 可读时必须传 `--session`，并精确匹配当前 owner；不接受“最近 Session”推断。
- corrupt lease 无法读取 owner 时不允许传入猜测 owner；只允许 guarded quarantine 分支。
- 没有 `--force`、`--force-kill`、`--force-release` 或等价环境变量。
- 结果始终返回 receipt；blocked 不删除 lease。

### 9.3 Start 输出

Beta start 的成功 JSON 增加：

```js
{
  // existing public manifest fields
  poolRecovery: {
    trigger: "startup",
    recovered: [],
    preserved: [],
    blocked: [],
    failed: []
  }
}
```

非 JSON 输出在 manifest 结果之后给出一段有界摘要，不打印 secret 或整份 runtime 文件。

## 10. 实施任务

### 阶段 1：纯只读 projection 与 `dev:pool`

新增：

- `scripts/dev-session/beta-slot-pool-projection.mjs`
- `scripts/dev-session/pool-cli.mjs`

修改：

- `scripts/dev-session/beta-slot-pool-core.mjs`
- `scripts/dev-session/beta-slot-pool-storage.mjs`
- `scripts/dev-session/beta-slot-pool.mjs`
- `scripts/dev-session/services.mjs`（仅在现有 inspection 不能区分 owned/shared facts 时补充只读返回值）
- `package.json`

工作：

- 实现 per-slot lease/manifest/runtime/metadata 联合读取，单槽错误结构化返回，不吞掉原因。
- 把 `allocatorPid` 映射为 `lease.acquisition`；新投影不暴露 `allocatorLive` 健康语义。
- 复用 `inspectSessionServices()` 和现有 Beta runtime identity 检查，不复制一套较弱的 PID-only 检查。
- 实现有限 derived state、reasons、checks 和 blockedBy。
- 实现人类表格与 JSON 输出；默认 status，`recover` 在阶段 2 前返回明确 unsupported，不提前暴露半成品 mutation。
- 保持 `inspectBetaSlotCapacity()` 和现有 dry-run 字段兼容；dry-run 可 additive 增加 projection summary，但不能删除旧字段。

阶段验收：`dev:pool --json` 对 fixture 五槽给出正确分类；执行前后 pool/session 目录清单与文件哈希不变。

### 阶段 2：统一 release transaction、receipt 与定向 recover

新增：

- `scripts/dev-session/beta-slot-pool-lifecycle.mjs`
- `scripts/dev-session/beta-slot-pool-recovery.mjs`

修改：

- `scripts/dev-session/beta-slot-pool-janitor.mjs`
- `scripts/dev-session/beta-slot-pool-core.mjs`
- `scripts/dev-session/beta-slot-pool-storage.mjs`
- `scripts/dev-session/cli-stop.mjs`
- `scripts/dev-session/cli.mjs`
- `scripts/dev-session/contracts.mjs`
- `scripts/dev-session/pool-cli.mjs`
- `scripts/dev-session/beta-slot-pool.mjs`

工作：

- 抽取 normal stop、start failure 和 janitor 共用的 finalizer，统一 reset/metadata/release/manifest 顺序。
- 为 `stopping + release_pending` 和“lease 已释放但 manifest 未终态化”增加幂等收敛。
- 扩展 manifest optional `poolRecovery` 校验与 public projection；不新增状态、不提升 manifest schema。
- metadata schema v2 使用 read-modify-atomic-write，保留既有字段并写最近 attempt。
- 实现 claim → Session lock → re-read → re-evaluate → mutate 固定锁序。
- 实现显式 recover、zero-process corrupt lease quarantine 和无 force 参数门禁。
- blocked/failed 路径保证 lease 保留，receipt 可查。

阶段验收：在每个故障注入点中断 finalizer 后重跑 status/recover，最终只能收敛为“lease 保留 + stale receipt”或“lease 已释放 + stopped receipt”，不得出现 idle slot 与旧进程并存。

### 阶段 3：容量压力恢复接入 start

修改：

- `scripts/dev-session/cli.mjs`
- `scripts/dev-session/beta-slot-pool-janitor.mjs`
- `scripts/dev-session/beta-slot-pool-recovery.mjs`
- `scripts/dev-session/beta-slot-pool-core.mjs`

工作：

- 把 janitor 改为显式 `startup_hygiene` 与 `capacity_pressure` 两种策略，不再用 manifest state 粗粒度决定 active。
- 创建新 Session ID 后把它作为 `initiatingSessionId` 传入 receipt；janitor 仍在新 manifest 创建前运行。
- hygiene 回收全部零进程安全空壳；capacity pressure 只回收所需最少 partial。
- 增加两次 5 秒检查、busy skip、shared dependency 排除和确定性候选排序。
- 原子 acquire 失败后重新投影；并发竞争使用有界循环，保留 recovery 成功但 allocation 失败的精确错误。
- 显式 requested slot 不回退其它槽位。
- start 成功/失败 JSON 都带本轮 pool recovery summary；不再丢弃 janitor 返回值。

阶段验收：池满但存在一个安全 partial 时，同一 start 自动恢复并成功启动；五槽均 healthy/manual/busy 时不误杀并返回逐槽 blocker。

### 阶段 4：自动化验证、运行手册与架构文档收敛

修改：

- `scripts/dev-session/verify-beta-slot-pool.mjs`
- `scripts/dev-session/verify-beta-slot-storage.mjs`
- `scripts/dev-session/verify-registry.mjs` 或现有最接近的 lifecycle verifier
- `scripts/verify-dev-session.mjs`
- `docs/deployment/runweave-beta.md`
- `docs/architecture-flows/beta-resource-management/README.md`
- `docs/architecture-flows/beta-resource-management/index.html`
- `docs/architecture-flows/beta-resource-management/app.js`

工作：

- 用临时 HOME、真实子进程和文件 identity fixture 覆盖投影、回收、并发和崩溃窗口；不新增单元测试文件。
- 更新 verifier 的 checks 列表，使 CI 输出能证明新增不变量。
- 文档写清 `dev:pool`、自动回收触发条件、无 force 边界、receipt 和恢复命令。
- 架构 HTML 从“诊断建议”更新为“现状与目标实现对照”；保留 2026-07-18 快照并明确它不是实时控制台。
- 不把当时 PID、nonce 或槽位快照改写成当前实时事实。

阶段验收：Beta Pool 控制面与长期运行两份 YAML 中全部 required cases 通过，静态门禁通过，文档命令与实际 CLI 输出一致。

## 11. 兼容、迁移与回滚

### 11.1 兼容

- 现有 lease schema v1 不变；`allocatorPid` 继续可读。
- `inspectBetaSlotCapacity()` 原字段保持；新信息 additive 提供，避免破坏 dry-run 和既有 verifier。
- manifest 只增加 optional `poolRecovery`；旧 manifest 没有该字段时正常读取。
- metadata v1 读取时把 `lastRecoveryAttempt` 视为 null；下一次写入原子升级 v2。
- `dev:status` 保持单 Session 语义；`dev:pool` 不取代它。
- `dev:stop --cleanup-stale` 继续可用，内部改为复用统一 finalizer。

### 11.2 回滚

- 阶段 1 可独立回滚，不产生外部状态变化。
- 阶段 2 以后回滚代码前，必须确认没有 manifest 停留在 `stopping + poolRecovery.phase=release_pending`；先用新代码收敛这些事务。
- metadata v2 保留 v1 字段，旧代码仍能用于 idle slot LRU；回滚不删除 recovery receipt。
- quarantine 证据不自动恢复或删除；回滚后仍保留在 pool root，不会重新变成 active lease。
- 不通过回滚恢复已完成 reset 的用户行为态；自动回收等价于 stop，receipt 是唯一审计依据。

## 12. 错误合同

新增或稳定下面的机器可读 reason code；具体 `DevSessionError` 文案可以沿用项目风格，但 JSON 必须含 code 和逐槽 evidence：

- `beta_pool_capacity_exhausted`
- `beta_pool_capacity_won_by_concurrent_allocator`
- `beta_pool_owner_session_busy`
- `beta_pool_shared_dependency_degraded`
- `beta_pool_live_process_identity_mismatch`
- `beta_pool_process_references_unknown`
- `beta_pool_lease_manifest_mismatch`
- `beta_pool_lease_corrupt_not_quarantinable`
- `beta_pool_recovery_failed_lease_retained`
- `beta_pool_requested_slot_occupied`

容量错误必须至少返回：`slotId`、derived state、owner Session（可读时）、blockedBy、suggestedAction；禁止只返回 `all five Beta slots are occupied or broken`。

## 13. 风险与控制

| 风险                          | 控制                                                                              |
| ----------------------------- | --------------------------------------------------------------------------------- |
| 误杀正在恢复的 Session        | owner Session lock、两次检查、shared/owned 分离、runtime 恢复后 preserved         |
| projection 快照过期           | `reservationGuaranteed:false`；执行时在 claim/lock 内重读全部事实                 |
| PID 复用                      | process signature、lock、health、CDP 和路径引用联合验证；任一 unknown fail closed |
| reset 后 release 前崩溃       | lease 保留，manifest `stopping/release_pending` 可重入                            |
| release 后 stopped 写入前崩溃 | 槽位容量已安全释放；status/janitor 把 manifest 收敛为 stopped                     |
| 并发 start 重复恢复/重复分配  | recovery claim 串行恢复；hard-link 串行 lease owner；有界重试                     |
| shared 故障触发槽位风暴       | shared dependency 从 recovery predicate 中排除                                    |
| 自动清理丢失诊断              | receipt 三处可查，corrupt lease quarantine，不复制 secret                         |
| metadata 无限增长             | 每 slot 只保留最近 attempt，每 Session 只保存自己的最终 receipt                   |
| 首期范围膨胀                  | 不做产品 UI、heartbeat、动态池或通用资源框架                                      |

## 14. 验证方式

实施阶段按顺序执行：

```bash
pnpm testplan:validate docs/testing/platform/beta-pool-storage-migration.testplan.yaml
pnpm dev:session:verify:beta-current
pnpm typecheck
pnpm lint
git diff --check
```

资源控制面行为以 `docs/testing/platform/beta-pool-storage-migration.testplan.yaml` 为入口；该历史文件名仅为兼容已有入口，内容不再执行旧数据迁移。跨轮次运行、真实 CDP 与资源所有权回归使用 `docs/testing/platform/beta-pool-runtime-regressions.testplan.yaml`。执行测试计划时使用 `$toolkit:run-test-cases`；若需要实际启动/停止 Dev Session，必须使用 `$toolkit:runweave-dev-session` 管理准确 Session、profile 和清理。原 BRM 的投影、恢复、并发、崩溃收敛和诊断场景全部保留；不构造或迁移 legacy 控制面旧数据。CLI/进程行为不得用截图或静态代码阅读冒充，运行时计划中的页面证据必须使用真实 CDP。

## 15. 完成标准

- [ ] `dev:pool` 能在不写任何状态的前提下解释全部五槽位。
- [ ] P1～P5 每项都对应到代码行为、CLI 输出或 receipt，不只更新文档。
- [ ] 池满且存在安全空壳时，当前 start 自动清理并成功获得容量。
- [ ] 池满且存在持续 partial owned runtime 时，只回收所需最少候选并继续启动。
- [ ] shared dependency 异常、Session lock busy、PID mismatch 和 unknown reference 均不会触发误杀。
- [ ] corrupt lease 只有在零进程和稳定文件 identity 下进入 quarantine。
- [ ] normal stop、start failure、janitor 和 explicit recover 共用同一 release transaction。
- [ ] 每个 recovery attempt 都可从命令输出、owner manifest 或 slot metadata 至少一个持久入口定位；成功自动恢复三处均可查。
- [ ] 崩溃注入与并发分配验证不存在“lease 已释放但旧进程仍使用槽位”的状态。
- [ ] 没有 force kill/release 后门，没有新增单元测试文件，没有修改产品 UI。
- [ ] 配套测试计划 required cases、`dev:session:verify:beta-current`、typecheck、lint 和 diff check 全部通过。

## 16. 推荐提交顺序

1. **只读投影与 CLI**：无资源 mutation，先稳定 schema 和分类。
2. **统一 release transaction 与显式 recover**：先证明恢复事务安全、可重入。
3. **容量压力自动恢复**：最后接入 start，启用用户可见行为变化。
4. **文档与完整验收**：更新架构诊断、部署手册和验证证据。

每个提交都必须保持 `pnpm dev:session:verify:beta-current` 可运行；不得在 projection 尚不可解释或 receipt 尚未持久化时提前启用自动终止 partial Session。完整兼容门禁 `pnpm dev:session:verify` 仍供仓库级回归使用，但不作为当前 Beta Pool 测试计划证据。
