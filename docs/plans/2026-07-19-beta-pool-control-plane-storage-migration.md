# Beta Pool 控制面存储迁移实施计划

> 状态：实现完成；真实迁移待现有 legacy Session 排空后验收
> 粒度：L3（并发租约、跨版本兼容、数据迁移与崩溃恢复）
> 推荐方案：将 Pool 控制面状态迁到 `~/.runweave/beta-pool`
> 配套测试计划：`docs/testing/platform/beta-pool-storage-migration.testplan.yaml`

## 1. 目标

把由 Dev Session CLI 直接管理的 Beta Pool 控制面状态从：

```text
~/Library/Application Support/Runweave Beta/pool
```

迁移到：

```text
~/.runweave/beta-pool
```

完成后必须满足：

1. `lease`、`recovery claim`、slot metadata 和 quarantine 统一以新目录为唯一权威写入点；
2. `pnpm dev:pool` 继续保持纯只读，不因查询创建目录或触发迁移；
3. 已由旧版本创建的 Beta Session 可以继续通过新版本 `dev:stop` 或 guarded recovery 安全释放旧 lease；
4. 旧 Pool 未排空时禁止新 Session 在新目录分配 lease，避免同一个物理槽位出现两个 owner；
5. 旧 Pool 排空后执行一次非破坏、可恢复、幂等迁移，保留旧数据备份；
6. 迁移完成后，正常 `dev:session` / `dev:pool` 生命周期不再遍历或读写旧 Pool 目录；
7. 任一目录冲突、文件身份异常、迁移阶段不明或并发竞争均 fail closed，不删除 lease、不启动新的 Beta 槽位。

核心不变量：

```text
任意时刻，五个 Beta slot 只能有一个权威 Pool 根目录。

旧 Pool 仍有 active lease 或 recovery claim 时，新 Pool 不得发布 lease；
新 Pool 已发布 lease 后，旧版本不得重新在旧 Pool 创建第二套租约。
```

## 2. 非目标

- 不引入 App Group、XPC、签名 helper、provisioning profile 或新的 macOS entitlement。
- 不迁移 `~/Library/Application Support/Runweave Beta/instances/<slotId>`；其中的 `userData`、runtime 和 warm-state 继续按 Beta 实例私有隔离。
- 不迁移 `/Applications/Runweave Beta pool-0N.app`、`~/.runweave/app-server-beta/<slotId>` 或 Dev Session manifest。
- 不更改五槽容量、slot ID、lease schema、recovery claim schema 或 hard-link 原子发布语义。
- 不新增单元测试或 TDD 文件；验证使用现有 verifier、临时 HOME、YAML 测试计划和真实 Dev Session 行为。
- 不承诺任意用户或 Agent 执行的宽目录命令都不会触发 macOS TCC；例如手工执行 `find ~/Library` 仍可能访问其他 App 数据。
- 不在迁移实现中顺手清理旧 Beta 实例、历史 quarantine 或无关目录。

## 3. 当前代码事实与目标差异

| 主题           | 当前事实                                                                                                                    | 目标差异                                                                              |
| -------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 路径入口       | `scripts/dev-session/beta-slot-pool-core.mjs` 的 `resolveBetaPoolPaths()` 固定返回 `Application Support/Runweave Beta/pool` | 增加统一的 canonical/legacy 路径合约，默认权威写入点改为 `~/.runweave/beta-pool`      |
| 调用者         | `dev:session`、`dev:pool`、stop、start-failure cleanup、janitor 和 recovery 都由普通 Node CLI 直接读写 Pool                 | 保持普通 Node CLI 所有权，不增加 App Group 权限依赖                                   |
| 只读投影       | `inspectBetaPool()` 读取单一 Pool 根，且空 HOME 下不创建目录                                                                | 能只读识别 canonical、legacy、未初始化和 conflict 四种存储状态，仍保持零写入          |
| Lease 原子性   | 新 lease 通过同目录 hard link 原子发布，release 前重验 inode、ownerSessionId 和 nonce                                       | 迁移不能削弱现有发布与释放安全检查，且必须防止两个根目录同时发布 lease                |
| Stop/recovery  | 按当前默认路径定位 lease 和 recovery claim                                                                                  | 对旧 Session 必须沿其权威 legacy 根完成 finalization，不能先迁移或改写 lease identity |
| Legacy cleanup | `scripts/runweave-beta-legacy.mjs` 把 legacy instance quarantine 放在旧 Pool 的 `quarantine` 下                             | 改为使用 canonical Pool 的专用 legacy quarantine 子目录，避免迁移后重新写旧根         |
| 降级           | 旧版本只认识旧 Pool 路径                                                                                                    | 迁移完成后在旧路径留下 fail-closed tombstone，阻止旧版本静默创建第二套 Pool           |

关键调用链：

```text
pnpm dev:session / pnpm dev:pool
  → scripts/dev-session/cli.mjs 或 pool-cli.mjs
  → beta-slot-pool-*.mjs
  → resolveBetaPoolPaths / fs lease、claim、metadata 操作
```

## 4. 存储路径与状态合约

### 4.1 路径

新增纯路径模块 `scripts/dev-session/beta-slot-pool-storage-paths.mjs`，集中定义：

```js
{
  controlRoot: "~/.runweave",
  canonicalPoolRoot: "~/.runweave/beta-pool",
  migrationRoot: "~/.runweave/beta-pool-migrations",
  migrationLockPath: "~/.runweave/.beta-pool-migration.lock",
  legacyBetaRoot: "~/Library/Application Support/Runweave Beta",
  legacyPoolRoot: "~/Library/Application Support/Runweave Beta/pool"
}
```

实际代码继续接受显式 `homeDir`，测试和 verifier 不读取用户真实 HOME。不得通过环境变量增加第二套生产路径覆盖入口。

canonical Pool 内保持现有结构：

```text
~/.runweave/beta-pool/
  leases/
  recovery-claims/
  metadata/
  quarantine/
    leases/
    legacy-instances/
  storage.json
```

`storage.json` 是存储级 marker，不替代 lease/metadata schema：

```js
{
  schemaVersion: 1,
  storage: "beta-pool-control-plane-v1",
  migrationId: "uuid-or-null",
  migratedFrom: "absolute-legacy-pool-path-or-null",
  sourceFingerprint: "sha256-or-null",
  completedAt: "ISO timestamp-or-null"
}
```

### 4.2 存储判定

新增 `inspectBetaPoolStorage({ homeDir })`，只读返回有限状态：

| `mode`                | 判定                                                                   | 行为                                                                   |
| --------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `uninitialized`       | canonical 与 legacy 都没有有效 Pool 状态                               | projection 返回五槽 idle；首次 mutation 创建 canonical                 |
| `canonical`           | canonical marker/结构有效，legacy 不含可写 Pool                        | 所有操作使用 canonical                                                 |
| `legacy-draining`     | canonical 尚未建立，legacy 存在 lease、claim 或可迁移数据              | projection 从 legacy 读取；只允许旧 owner stop/recover，不允许新 lease |
| `migration-resumable` | 有合法迁移 journal/staging，阶段可证明                                 | mutation 在迁移锁内继续事务；projection 只报告状态，不自动推进         |
| `conflict`            | canonical 与 legacy 都包含权威状态，或 marker/journal/文件身份无法对应 | 所有 mutation 拒绝；输出两个根和具体 blocker，不自动合并               |

`inspectBetaPool()` 顶层 additive 增加：

```js
storage: {
  schemaVersion: 1,
  mode: "canonical",
  effectiveRoot: "$HOME/.runweave/beta-pool",
  canonicalRoot: "$HOME/.runweave/beta-pool",
  legacyRoot: "$HOME/Library/Application Support/Runweave Beta/pool",
  migrationRequired: false,
  blockedBy: []
}
```

现有 `schemaVersion: 1`、slot、summary 和 `reservationGuaranteed=false` 不变。

## 5. 兼容与迁移规则

### 5.1 旧 Session 排空

迁移前不得复制 active lease 到新 Pool。规则固定为：

1. `dev:pool` 在 `legacy-draining` 下从旧根生成只读投影，不创建 canonical 目录；
2. 新 Beta start 检测到任一 legacy lease、recovery claim 或 identity 未知的 slot 时，以结构化错误 `beta_pool_legacy_drain_required` 失败；
3. 错误包含 occupied slot、owner Session、建议执行的 `pnpm dev:stop --session <id>` 或 guarded recover 命令；
4. `dev:stop`、start-failure cleanup 和 `dev:pool recover` 根据当前 lease 的 ownerSessionId/nonce 选择 legacy 根，在同一根内获取 claim、重验和释放；
5. 最后一个 legacy lease 释放后不在 stop 尾部自动迁移；下一次需要分配新 lease 的 mutation 再执行迁移，避免 stop 的职责扩大。

### 5.2 迁移事务

新增 `prepareBetaPoolStorageForAllocation({ homeDir })`，只在新 lease 分配前调用：

```text
获取 migration lock
  → 重新 inspect canonical 与 legacy
  → 确认 legacy 无 lease、无 recovery claim、无 live owner 引用
  → 盘点 regular file、目录、权限和 symlink 安全性
  → 写 migration journal: preparing
  → 复制 metadata/quarantine 到 canonical 同父目录 staging
  → 写 storage.json 与 sourceFingerprint
  → 校验 staging 文件集合、内容 hash、权限和 schema
  → 原子 rename staging → ~/.runweave/beta-pool
  → journal: canonical_published
  → rename legacy pool → pool.migrated-<migrationId>
  → 在原 legacy pool 路径写 regular-file tombstone
  → journal/storage marker: completed
  → 释放 migration lock
```

约束：

- `leases/` 必须为空才可迁移；不把已释放的旧 lease 复制到新根。
- `recovery-claims/` 必须为空；未知 claim 视为 active blocker。
- metadata 与 quarantine 只接受 regular file/真实目录；任何 symlink、FIFO、socket 或越界路径均 fail closed。
- staging 必须位于 `~/.runweave` 下，保证最终 publish 使用同卷 atomic rename。
- canonical 已存在但只有空目录不等于迁移完成；必须校验 `storage.json` 和 journal。
- 不覆盖 canonical 已有文件，不按“新目录存在”直接跳过迁移。
- legacy backup 保留，未得到用户明确清理授权前不 purge。

### 5.3 Tombstone 与旧版本

迁移完成后，旧 `pool` 路径变成普通 JSON 文件而不是目录：

```js
{
  schemaVersion: 1,
  state: "migrated",
  canonicalRoot: "$HOME/.runweave/beta-pool",
  migrationId: "...",
  backupPath: "$HOME/Library/Application Support/Runweave Beta/pool.migrated-...",
  completedAt: "..."
}
```

现有旧代码对非目录 Pool root 会触发安全拒绝，因此降级后会失败而不是创建第二套 lease。不要用 symlink，因为现有 Pool 安全合同明确拒绝 symlink，且 symlink 会让权威根判断含糊。

### 5.4 崩溃恢复

迁移 journal 至少支持：

- `preparing`
- `staged`
- `canonical_published`
- `legacy_archived`
- `completed`
- `rolled_back`
- `blocked`

恢复规则：

- staging 未发布：校验 journal owner 后删除本次 staging，重新开始；不动 legacy。
- canonical 已发布、legacy 尚未归档：只有 sourceFingerprint 与 marker 一致时继续归档；不一致进入 `conflict`。
- legacy 已归档、tombstone 未写：从 journal 恢复 tombstone，然后完成。
- tombstone 已写但 completed marker 未更新：校验 canonical 与 backup 后补齐 marker。
- 任一阶段无法证明文件身份或 fingerprint：保留全部现场并返回 `beta_pool_storage_migration_blocked`。

## 6. 回滚边界

### 6.1 尚未产生 canonical lease

允许提供内部 rollback helper，且只能在 migration lock 内：

1. canonical `leases/` 与 `recovery-claims/` 为空；
2. canonical marker、journal、legacy tombstone 和 backup migrationId 完全匹配；
3. 删除 tombstone，将 backup 原子 rename 回 legacy `pool`；
4. 将 canonical rename 到 migration journal 下作为回滚备份，不直接删除；
5. journal 写 `rolled_back`。

首期不增加面向用户的 `--force` 或独立 purge 命令；rollback helper 供迁移失败自动收敛和 verifier 使用。

### 6.2 已产生 canonical lease

禁止自动回滚。需要降级时必须先用当前版本停止全部 Beta Session，确认 canonical lease/claim 为空，再执行显式维护流程。旧版本直接运行只会命中 tombstone 并 fail closed，这是预期安全行为。

## 7. 错误合同

复用 `DevSessionError`，新增稳定 `details.code`：

| code                                  | 场景                                          | suggestedAction                               |
| ------------------------------------- | --------------------------------------------- | --------------------------------------------- |
| `beta_pool_legacy_drain_required`     | legacy 仍有 lease/claim                       | 停止列出的 owner Session 后重试 start         |
| `beta_pool_storage_migration_busy`    | 另一个迁移者持有有效 migration lock           | 等待当前操作完成后重试                        |
| `beta_pool_storage_migration_blocked` | symlink、未知文件类型、hash 或 journal 不一致 | 保留现场并运行 `dev:pool --json` 查看 blocker |
| `beta_pool_storage_conflict`          | canonical 与 legacy 同时存在权威状态          | 禁止 start/stop 自动猜测，人工核对两个根      |
| `beta_pool_storage_downgrade_blocked` | 旧路径为迁移 tombstone                        | 使用理解 canonical Pool 的当前版本            |

所有错误必须包含 `canonicalRoot`、`legacyRoot`、`mode`、`blockedBy` 和不带秘密的 `suggestedAction`；不得输出 lease 文件全文、token 或 runtime 环境变量。

## 8. 文件范围与职责

### 新增

- `scripts/dev-session/beta-slot-pool-storage-paths.mjs`
  - 只负责 canonical/legacy/migration/backup 路径解析与路径内约束。
- `scripts/dev-session/beta-slot-pool-storage-migration.mjs`
  - 存储探测、migration lock、journal、staging、fingerprint、迁移恢复和受限 rollback。
- `scripts/dev-session/verify-beta-pool-storage-migration.mjs`
  - 使用临时 HOME 覆盖空目录、legacy drain、幂等迁移、并发、崩溃恢复、conflict 和 tombstone；属于 repo verifier，不是单元测试。

### 修改

- `scripts/dev-session/beta-slot-pool-core.mjs`
  - 复用新路径模块；让 acquire/assert/release 显式绑定本次 lease 的 effective root，禁止中途切根。
- `scripts/dev-session/beta-slot-pool-projection.mjs`
  - 添加只读 storage 状态；legacy-draining 时读取 legacy，conflict 时结构化失败。
- `scripts/dev-session/beta-slot-pool-lifecycle.mjs`
  - finalizer 沿 lease 所属根完成 claim、metadata、reset 和 release。
- `scripts/dev-session/beta-slot-pool-recovery.mjs`
  - recover 使用投影确认的 effective root；不跨根 quarantine 或 release。
- `scripts/dev-session/beta-slot-pool-metadata.mjs`
  - 所有读写接收显式 paths，避免内部重新按 HOME 解析到另一根。
- `scripts/dev-session/cli.mjs`
  - 新 lease acquisition 前调用 migration preparation；保存 slot lease 的 storage root identity。
- `scripts/dev-session/cli-stop.mjs`
  - 允许旧 owner 在 legacy-draining 阶段安全排空，不隐式启动迁移。
- `scripts/dev-session/cli-start-cleanup.mjs`
  - start 失败清理继续使用 acquisition 返回的原 storage paths。
- `scripts/dev-session/pool-cli.mjs`
  - 人类输出和 JSON 暴露 storage mode、migrationRequired 与 blocker；status 保持只读。
- `scripts/dev-session/beta-slot-pool.mjs`
  - 汇总导出新的路径、探测和迁移入口。
- `scripts/runweave-beta-legacy.mjs`
  - legacy instance quarantine 改到 canonical `quarantine/legacy-instances`，不再重新创建旧 Pool 目录。
- `scripts/dev-session/verify-beta-slot-pool.mjs`
  - 接入 storage migration verifier，并保持现有 Beta pool verifier 全部通过。
- `scripts/dev-session/verify-beta-slot-pool-projection.mjs`
  - 更新临时 HOME 断言，确认只读投影不会创建 canonical 或 legacy 根。
- `docs/deployment/runweave-beta.md`
  - 实施完成后更新当前事实、迁移阻塞、降级边界、备份位置和排障命令。

### 不修改

- `electron/**`、`frontend/**`、`app/**`、`packages/common/**`
- `scripts/runweave-update-core.mjs` 中 Beta instance 私有数据路径
- Electron 签名、entitlement 和打包配置
- Dev Session manifest/lease schema

## 9. 实施顺序

### 阶段 1：冻结路径与只读存储判定

- [ ] 新增 canonical/legacy 路径模块和 `inspectBetaPoolStorage()`。
- [ ] 明确“有效状态”判定：lease、claim、metadata、quarantine、storage marker 分开识别，空目录不能冒充完成迁移。
- [ ] 更新 projection，让 `dev:pool` 在空 HOME、legacy-only、canonical-only、conflict 下都保持零写入。
- [ ] 给现有 core helper 增加显式 paths 参数，但暂不切换 mutation 默认根。

阶段验证：临时 HOME 下运行 projection 前后递归目录清单和文件 hash 不变；现有 projection verifier 通过。

### 阶段 2：旧 Session 排空与根绑定

- [ ] acquisition 返回并在后续生命周期传递 `storageRoot`/paths，不允许 assert/release 重新按当前默认解析。
- [ ] 新 start 在 legacy active 时返回 `beta_pool_legacy_drain_required`，不创建 canonical。
- [ ] stop、start-failure cleanup、recover 和 finalizer 沿 legacy 根安全释放旧 lease。
- [ ] legacy root 已排空时 projection 报告 migration required，但 stop 本身不推进迁移。

阶段验证：构造旧 lease 与 manifest，用新代码 stop 后只删除正确 lease；新 start 在排空前零副作用失败，排空后才进入迁移。

### 阶段 3：迁移事务、并发与崩溃恢复

- [ ] 实现 migration lock、journal、staging、fingerprint 和 atomic publish。
- [ ] 迁移 metadata、lease quarantine 与 legacy instance quarantine；不复制 active lease/claim。
- [ ] 实现 legacy archive 与 regular-file tombstone。
- [ ] 为每个 journal phase 实现可重复恢复；不可证明时进入 conflict/blocked。
- [ ] 让并发 start 只有 migration winner 能 publish canonical，随后仍由现有 hard-link 机制竞争唯一 lease。

阶段验证：在每个迁移阶段注入一次中断，重跑后得到唯一 canonical 根；并发两个 start 不产生双 lease、双 backup 或多个 completed journal。

### 阶段 4：切换所有调用方与文档

- [ ] mutation 默认切换到 canonical，删除业务代码对旧 Pool 的直接拼接。
- [ ] 更新 legacy cleanup quarantine 路径。
- [ ] 更新 CLI 输出、结构化错误和 `docs/deployment/runweave-beta.md`。
- [ ] 用 `rg` 确认旧 Pool 字符串只保留在 legacy resolver、迁移说明和 verifier fixture 中。

阶段验证：新 HOME 首次 start 只创建 `~/.runweave/beta-pool`；迁移完成后的正常 status/start/stop 不读取旧 Pool。

## 10. 验证方式

### 10.1 静态与 verifier 门禁

```bash
pnpm testplan:validate docs/testing/platform/beta-pool-storage-migration.testplan.yaml
pnpm typecheck
pnpm lint
pnpm dev:session:verify
```

预期：

- YAML schema 校验通过；
- typecheck、lint 无新增错误；
- `dev:session:verify` 包含新 migration verifier 且全部通过；
- verifier 全程使用临时 HOME，不修改用户真实 `~/.runweave` 或 `Application Support`。

### 10.2 真实 Dev Session 验收

实际执行时必须使用 `$toolkit:runweave-dev-session` 管理准确 worktree、Session ID、profile 和清理，不直接启动 Beta/Backend/Electron。按配套测试计划完成：

1. legacy Session 排空；
2. 首次 canonical 迁移；
3. 新 Beta Session start/status/stop；
4. `dev:pool --json` 确认 `storage.mode=canonical`；
5. `dev:stop` 后确认 Session stopped 且 lease/claim 均已清理；
6. 在隔离 macOS 15+ 验收账号上使用 `$computer-use` 观察正常流程没有出现“访问其他 App 的数据”弹窗，并检查对应时间窗没有新的 `AUTHREQ_PROMPTING`。

如果无法获得隔离账号或 TCC 权限已预授权，第 6 步必须报告“未执行 + 环境原因”，不能用静态检查代替。

## 11. 验收标准

- [ ] canonical Pool 唯一固定为 `~/.runweave/beta-pool`，普通 Node CLI 可直接管理，不依赖 App Group。
- [ ] Beta instance 私有数据路径保持原样，没有扩大共享范围。
- [ ] `dev:pool` 在任何 storage mode 下都不创建、迁移、归档或修复文件。
- [ ] legacy active 时新 start fail closed，旧 Session 可以被当前版本安全 stop/recover。
- [ ] inactive legacy 数据只迁移一次，metadata/quarantine 内容与权限完整，旧备份保留。
- [ ] 并发 start 和迁移崩溃不会产生双 Pool、双 owner 或丢失 lease。
- [ ] canonical 与 legacy 冲突时没有任何自动删除、覆盖或合并。
- [ ] 迁移后旧路径 tombstone 阻止旧版本创建第二套 lease。
- [ ] canonical 已有 lease 时自动 rollback 被拒绝。
- [ ] legacy instance quarantine 不再写入旧 Pool。
- [ ] 正常新版本 start/status/stop 不再访问旧 Pool 路径。
- [ ] 配套 YAML 测试计划格式校验、typecheck、lint 和 `dev:session:verify` 全部通过。

## 12. 风险与副作用

| 风险/副作用                        | 影响                                           | 控制措施                                                                  |
| ---------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------- |
| 首次迁移仍需读取旧 App 数据目录    | 首次迁移可能仍触发一次 macOS 授权提示          | 只在排空后精确访问旧 Pool；迁移完成后不再进入旧根；不可承诺绕过系统授权   |
| 旧版本不认识 canonical Pool        | 降级后 Beta start 会失败                       | legacy tombstone 强制 fail closed；降级前必须用当前版本排空并执行维护流程 |
| active legacy Session 与新版本并存 | 可能形成双 Pool                                | 新 allocation 在 legacy 排空前禁止创建 canonical lease                    |
| 迁移中断                           | 可能同时看到 staging、canonical、legacy backup | journal + fingerprint + migration lock；无法证明时保留现场并 conflict     |
| 迁移锁遗留                         | 后续 start 被阻塞                              | lock 记录 PID/process signature/nonce；只在身份可证明失效时回收           |
| 备份长期保留                       | 占用少量磁盘并保留历史诊断数据                 | 不自动 purge；文档给出位置和人工清理前置条件                              |
| 旧 quarantine 路径变化             | legacy restore/purge 需要找到新 journal        | 同步切换 create/read/restore/purge 全链路，并迁移原 quarantine            |
| 任意 shell 宽扫描仍可触发 TCC      | 用户仍可能看到同类弹窗                         | 明确产品边界；正常 Pool 代码只使用精确路径，不为通用终端增加全盘访问权限  |

## 13. 执行提交建议

建议拆成两个可独立审查的提交：

1. `refactor(dev-session): add beta pool storage root compatibility`
   - 路径合约、只读探测、legacy drain、显式 root 绑定和 verifier；尚不自动迁移。
2. `feat(dev-session): migrate beta pool control state to runweave home`
   - migration transaction、tombstone、legacy quarantine 切换、真实验收与文档。

第一提交必须保持现有 legacy 行为可用；第二提交只有在配套迁移用例全部通过后才能合并。
