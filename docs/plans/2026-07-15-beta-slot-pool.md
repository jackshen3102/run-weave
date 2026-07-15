# Runweave Beta 五槽位池与资源回收闭环计划

## 目标

将 `dev-session` 的 Beta profile 从“每个 session 派生一个独立 Beta instance”改为“全局固定 5 个 Beta 槽位循环复用”，同时让资源数量、release 保留量和磁盘启动门槛都可计算、可观测、可回收。

目标完成后必须同时满足：

- `/Applications` 下最多存在 5 个池化 Beta App：`Runweave Beta pool-01.app` 至 `Runweave Beta pool-05.app`；
- `~/Library/Application Support/Runweave Beta/instances/` 下最多存在 5 个池槽位目录；
- `~/.runweave/app-server-beta/` 下最多存在 5 个池槽位 home；
- 新的 `dev-session` 不再创建 `Runweave Beta dvs-*.app`、`Runweave Beta rcv-*.app` 或其他随 session 增长的 install target；
- 每个槽位的 Desktop Runtime 与 App Server Runtime 最多各保留 `current + previous` 两个 release；
- stop 后下一 owner 不继承上一 session 的 Cookie、LocalStorage、IndexedDB、Terminal Browser 标签、backend 凭据、App Server event/cloud-sync 或 update 临时状态；
- 槽位满、lease 损坏、身份无法证明或磁盘预算不足时一律 fail closed；
- Stable 与 shared Backend/App Server 永远不属于槽位 janitor 的清理范围。

## 非目标

- 不修改 Stable `/Applications/Runweave.app` 的安装或 update 语义；
- 不引入槽位抢占、优先级、等待队列或动态扩缩容；
- 不把 Beta profile 强制升级为全 dedicated Backend/App Server，继续服从现有 impact closure；
- 不在自动 start/janitor 中删除旧 `dvs-*`、`rcv-*` 或其他 legacy instance；
- 不新增单元测试文件或 TDD；
- 不覆盖 Windows、Ionic App、外部分发、签名或公证流程。

## 当前事实

- `resolveBetaUpdateTargets(homeDir, instanceId)` 会把任意合法 `instanceId` 映射为独立 App、userData、Runtime 和 App Server home，见 [scripts/runweave-update-core.mjs](../../scripts/runweave-update-core.mjs)。
- Beta profile 当前使用 `plan.targetEnvironment.instanceId ?? sessionId` 启动 Beta，见 [scripts/dev-session/services.mjs](../../scripts/dev-session/services.mjs)。
- `--dry-run` 在 sessionId、revision、manifest 和服务启动之前返回，因此不能承诺实际分配结果，见 [scripts/dev-session/cli.mjs](../../scripts/dev-session/cli.mjs)。
- 不同 session 只有各自的 session lock；现有端口租约已经提供独占创建、hard link、文件身份校验和 owner 校验模式，见 [scripts/dev-session/registry.mjs](../../scripts/dev-session/registry.mjs)。
- Beta profile 可能复用 shared Backend/App Server，`startDedicatedBeta()` 会注入 shared home、lock、token 和 PID，见 [scripts/dev-session/beta-service.mjs](../../scripts/dev-session/beta-service.mjs)。
- Desktop Runtime 和 App Server Runtime 当前按新 releaseId 创建目录，安装逻辑不主动淘汰历史 release，见 [scripts/install-runtime-package.mjs](../../scripts/install-runtime-package.mjs) 与 [packages/shared/src/app-server/runtime-release.ts](../../packages/shared/src/app-server/runtime-release.ts)。
- Beta userData 还包含持久 Terminal Browser partition、`terminal-browser-tabs.json`、`backend-auth.json` 等状态，不能靠少量目录黑名单证明 reset 完整。

## 已定设计决策

### 1. 固定容量与作用域

- 容量固定为 5，是本计划的产品约束，不做运行时配置。
- 槽位在当前 macOS 用户下全局共享，跨 worktree、branch 和 source revision 共用同一池。
- 合法 `slotId` 只有 `pool-01` 至 `pool-05`。
- 不带显式槽位时，优先选择 `lastRevision` 与当前 revision 相同的 idle 槽位，否则选择 `lastReleasedAt` 最早的 idle 槽位；metadata 缺失时按 `pool-01` 至 `pool-05` 稳定顺序选择。
- 带 `--instance pool-0N` 时把它解释为硬性的 `requestedSlotId`：空闲则获取，占用则立即失败，不回退到其他槽位。
- dev-session Beta 入口拒绝非 pool instance；低层 `runweave-beta.mjs` 保留 legacy instance 能力。

### 2. 单一所有权真相

不新增全局可写 `slots.json`。唯一所有权真相是 5 个 lease 文件：

```text
~/Library/Application Support/Runweave Beta/pool/
  leases/pool-01.lock
  metadata/pool-01.json
  ...
  leases/pool-05.lock
  metadata/pool-05.json
```

lease 使用现有 `acquireServicePortLease()` 的安全发布/删除模式：独占创建临时文件、写入并 `fsync`、hard link 发布、校验文件身份，释放时只删除获取时同一文件身份的 lease。

lease schema 固定为：

```json
{
  "schemaVersion": 1,
  "slotId": "pool-01",
  "leaseNonce": "uuid",
  "ownerSessionId": "dvs-...",
  "ownerSourceRoot": "/absolute/source/root",
  "ownerRevision": "git-revision",
  "ownerManifestPath": "/absolute/manifest.json",
  "allocatorPid": 12345,
  "acquiredAt": "ISO-8601"
}
```

约束：

- lease 不重复持久化 Desktop/backend/App Server PID、appPath 或运行 state；这些事实从 session manifest 与实时 identity handshake 派生；
- `metadata/pool-0N.json` 只保存 `lastRevision`、`lastReleasedAt`、`lastCleanupSummary`、`lastDiskSummary`，用于 LRU 与诊断，不参与所有权判断；
- metadata 损坏可以重建；lease 损坏、schema 不支持、owner 不一致时槽位标记为 `broken` 并保持占用，禁止猜测或覆盖；
- `leaseNonce` 同时写入 manifest `targetEnvironment.betaSlot`，stop/janitor 必须校验 `slotId + ownerSessionId + leaseNonce + 文件身份`。

### 3. manifest 与 dry-run 合约

`targetEnvironment` 新增：

```json
{
  "betaSlot": {
    "policy": "fixed-pool-v1",
    "capacity": 5,
    "requestedSlotId": null,
    "assignedSlotId": "pool-01",
    "leaseNonce": "uuid"
  }
}
```

- dry-run 输出 `policy`、`capacity`、`requestedSlotId` 与只读 `capacitySnapshot`，但 `assignedSlotId`、`leaseNonce` 必须为 `null`，且 snapshot 明确标记 `authoritative: false`；
- dry-run 不创建 sessionId、manifest、lease、slot 目录，不修改任何 mtime；
- 真实 start 先生成 sessionId/revision 和 planned manifest，再原子获取 lease，随后立即把 `assignedSlotId + leaseNonce` 写入 starting manifest，最后启动服务；
- `targetEnvironment.instanceId` 作为兼容字段：dry-run 为显式 requested slot 或 `null`，真实 manifest 中等于 assigned slot；
- `services.beta.instanceId`、`services.electron.instanceId`、`services.*.slotId` 与 assigned slot 必须一致；
- start 失败且已完成 identity-safe stop/reset 时，manifest 标记 `failed` 后释放 lease；任何 stop/reset 失败都把 manifest 标记 `stale`、槽位标记 `broken` 并保留 lease。

### 4. ownership matrix

继续复用 planner 的现有 impact closure：

| 资源                               | dedicated 时                    | shared 时                      | slot janitor 权限                                |
| ---------------------------------- | ------------------------------- | ------------------------------ | ------------------------------------------------ |
| Beta App / Electron / CDP          | 总是 slot-owned                 | 不适用                         | 可按 lease + identity 停止                       |
| Packaged Backend / browser profile | slot-owned                      | 记录 shared Backend 引用       | 只清 slot-owned，永不停止 shared                 |
| App Server                         | 使用 `app-server-beta/<slotId>` | 记录 shared home/lock/PID 引用 | 只清 slot-owned home，永不停止或删除 shared home |
| Frontend renderer                  | 随 Beta App                     | 不适用                         | 随 Electron 生命周期处理                         |

manifest 现有 `ownership` 是服务所有权真相。lease/metadata 不保存 shared PID，不得把 shared 服务提升为槽位 owner，也不得为了磁盘预算清理 shared 目录。

### 5. warm 与 mutable 路径分离

目标路径：

```text
/Applications/Runweave Beta pool-01.app                  # warm current app
/Applications/.Runweave Beta pool-01.app.previous-*      # 最多 1 个 rollback backup
~/Library/Application Support/Runweave Beta/instances/pool-01/
  runtime/                                                # warm Desktop Runtime，最多 2 个 release
  warm-state/                                             # current/previous 引用与受控诊断元数据
  diagnostics/                                            # 有数量和字节上限的日志
  user-data/                                              # 全部 mutable，可整体删除重建
  build/                                                  # 临时，update/stop 后删除
  runtime-artifacts/                                      # 临时，update/stop 后删除
  control/                                                # 临时，stop 完成后删除
~/.runweave/app-server-beta/pool-01/
  runtime/                                                # warm App Server Runtime，最多 2 个 release
  app-server.lock.json / token / events / logs / cloud-sync  # 全部 mutable
```

变更 `resolveBetaUpdateTargets()`：Desktop `runtimeHome` 从 `user-data/runtime` 移到 `instanceRoot/runtime`；需要跨 session 保留的 update/rollback 引用移到 `warm-state`。这样 stop 可以整体替换 `user-data`，无需维护 Chromium/Electron 状态删除黑名单。

volatile reset 顺序固定为：

1. manifest 进入 `stopping`，lease 保持占用；
2. 按 manifest ownership 与进程身份停止 dedicated Electron/backend/App Server，保留 shared 服务；
3. 确认 slot-owned PID 均退出；
4. 原子 rename 旧 `user-data` 到同槽临时目录，创建空的新 `user-data`，再删除旧目录；
5. App Server home 只保留受控 `runtime/`，其余 token、lock、event、log、cloud-sync 与 state 整体删除重建；
6. 删除 build、runtime-artifacts、control、pending、status、port lease 与临时文件；
7. 执行 release/log retention，写 metadata cleanup/disk summary；
8. manifest 写为 `stopped` 或 `failed`；
9. 最后校验 lease 文件身份与 nonce 并释放 lease。

步骤 2 至 8 任一步失败都不得释放 lease。

### 6. release retention 与磁盘门禁

每个槽位的硬上限：

- Desktop App：1 个 current App + 1 个被 `warm-state` 引用的 previous backup；
- Desktop Runtime：最多 2 个完整 release，只能是 current 与 previous known-good；
- App Server Runtime：最多 2 个完整 release，只能是 current 与 previous known-good；
- update/failure 日志：最多 5 个且合计最多 64 MiB，两个条件任一超限即从最旧开始删除；
- build、runtime-artifacts、失败临时目录和未被 current/previous 引用的 release：健康切换或恢复完成后立即删除。

删除保护：

- 先读取并校验 current/previous pointer；pointer 缺失、损坏、指向不存在 release 时 fail closed，不执行 release prune；
- active slot 只允许自身 owner 在健康切换完成后 prune；start janitor 只能 prune idle/stale 且所有权可证明的 slot；
- current、previous、运行中进程实际加载的 release 任一身份不一致时保留证据并拒绝清理。

启动前磁盘门禁：

```text
configuredFloor = RUNWEAVE_BETA_POOL_MIN_FREE_BYTES 或默认 4 GiB
plannedWriteBytes = 本轮计划创建/复制的 App + Desktop Runtime + App Server Runtime + 临时产物估算总和
requiredFreeBytes = max(configuredFloor, plannedWriteBytes * 3)
```

- `plannedWriteBytes` 无法估算时 fail closed，不用 0 继续；
- 检查与目标路径同一 filesystem 的 `freeBytes`；先对可证明安全的 pool 垃圾执行 retention/janitor，再重新计算；
- 清理后 `freeBytes < requiredFreeBytes` 时拒绝启动，错误输出 `freeBytes`、`requiredFreeBytes`、`configuredFloor`、`plannedWriteBytes`、已清理字节和仍被 current/previous/active slot 占用的字节；
- 测试可通过 `RUNWEAVE_BETA_POOL_MIN_FREE_BYTES` 注入阈值，但生产默认值固定为 4 GiB。

### 7. janitor 与 stale recovery

start 前 janitor 只处理 pool v1 资源：

- 无 lease 的槽位视为 idle，只能做 metadata 修复和未引用临时产物清理；
- lease 对应 manifest 为 `ready/stopping/stale` 时，联合 manifest、PID/process signature、statusPath、backend/App Server lock 和 CDP identity 判定；
- lease 对应 manifest 缺失，且 `allocatorPid` 已死、`acquiredAt` 超过 10 分钟，才可标记为 orphan；
- manifest 为 `planned/starting/failed` 且 allocator 已死时，必须先验证所有 recorded dedicated identity，再决定 stop/reset；
- identity 漂移、manifest/lease nonce 不一致、未知 schema、symlink 或路径逃逸一律标记 broken 并 fail closed；
- `stop --cleanup-stale` 只清理 manifest 记录且 identity 可验证的 dedicated 资源，成功 reset 后才释放 lease。

### 8. legacy 兼容与显式迁移

- 自动 start/janitor 只盘点 legacy `dvs-*`、`rcv-*` 和其他非 pool instance，输出路径、大小、运行身份和建议命令，不删除、不停止、不计入 5 个新槽位容量；
- 新增低层显式命令 `runweave-beta.mjs legacy-inventory --json`、`legacy-cleanup --instance <id> --json`、`legacy-restore --operation <id> --json` 与 `legacy-purge --operation <id> --confirm <operationId> --json`；cleanup 必须指定单个 instance，不接受 glob；
- cleanup 先验证 App bundle id、instance 路径、status/process identity、非 Stable 路径和无 symlink，再把资源同 filesystem 原子移动到 `pool/quarantine/<operationId>/`，写 journal 与恢复命令；
- `legacy-restore` 只能按 journal operationId 原路恢复；`legacy-purge` 才永久删除 quarantine，没有匹配的 confirm 不执行；
- active legacy、无可信 identity、路径逃逸或与 Stable 重叠时拒绝 cleanup；
- 低层 legacy instance update/status/stop 继续可用，不因 pool 引入而被自动删除。

## 修改范围

### dev-session 与 manifest

- `scripts/dev-session/cli.mjs`：区分 requested/assigned slot，编排 acquire、manifest、stop/reset/release 顺序。
- `scripts/dev-session/contracts.mjs`：校验 `targetEnvironment.betaSlot`、lease nonce 与兼容 `instanceId`。
- `scripts/dev-session/registry.mjs`：抽取/复用安全 lease 发布和文件身份删除能力。
- `scripts/dev-session/services.mjs`：把 assigned slot 传入 Beta start，并在失败清理中保持 lease 语义。
- `scripts/dev-session/beta-service.mjs`：记录 slot 与 shared/dedicated ownership，不把 shared PID 变成槽位所有权。
- `scripts/dev-session/service-runtime.mjs`：status/open/stale reconciliation 校验 slot/nonce/manifest/service identity。
- 新增 `scripts/dev-session/beta-slot-pool.mjs`：5 槽选择、lease、metadata、janitor、disk summary；不维护全局 `slots.json`。

### Beta 路径、更新与清理

- `scripts/runweave-update-core.mjs`：新增 `assertBetaSlotId()`，调整 pool runtime/warm-state 路径；保留 legacy resolver。
- `scripts/runweave-beta-state.mjs`：暴露 pool 路径、warm/mutable 边界与 status 字段。
- `scripts/runweave-beta.mjs`：pool-aware stop/reset、legacy inventory/cleanup/purge。
- `scripts/runweave-beta-operations.mjs`：健康切换后的 current/previous retention、rollback 引用和 cleanup summary。
- `scripts/runweave-update-operations.mjs`、`scripts/install-runtime-package.mjs`、`packages/shared/src/app-server/runtime-release.ts`：支持受控 retention，但不改变 Stable 默认路径的保留策略。
- `electron/src/desktop-config.ts`：继续以 assigned slot 驱动 App name/userData/CDP，不新增 sessionId 路径。

### 验证脚本与文档

- 扩展现有 `scripts/dev-session/verify-*.mjs` 与 `scripts/runweave-beta.mjs verify` 入口；不新增单元测试框架或单元测试文件。
- 同步 [docs/testing/beta-slot-pool-test-cases.md](../testing/beta-slot-pool-test-cases.md)。
- 实现前后如文件路由变化，更新 `docs/README.md` 对应索引；不改无关文档。

## 实施步骤

### Step 1：固定 patch 边界并更新验收合同

- [ ] 只纳入本计划涉及的 dev-session、Beta update/runtime、Electron 配置和配套文档。
- [ ] 先补齐现有 verify 脚本对 lease schema、5/6 容量边界、requested slot、unknown schema 和文件身份的覆盖。
- [ ] 确认配套 BSP-001 至 BSP-016 均有可执行前置、证据和失败判断。

验证：verify 脚本可在隔离 HOME 中运行，不触碰真实 Stable 或用户现有 Beta。

### Step 2：实现原子 lease 与 dry-run/manifest 合约

- [ ] 实现 5 个独立 lease 和非权威 metadata，不创建 `slots.json`。
- [ ] dry-run 只输出 requested policy 与非承诺 capacity snapshot。
- [ ] start 获取 lease 后立即写 assigned slot/nonce 到 starting manifest。
- [ ] 实现显式 requested slot 与第 6 个请求的 fail-closed 错误明细。

验证：并发 6 个 allocator 只能得到 5 个不同 slot；dry-run 前后 pool/session 目录摘要和 mtime 不变。

### Step 3：切换 pool 路径并明确 shared ownership

- [ ] dev-session Beta 默认只使用 assigned slot 作为低层 instanceId。
- [ ] Desktop Runtime 与 warm-state 移出 mutable userData。
- [ ] dedicated App Server 使用 slot home；shared Backend/App Server 只记录引用。
- [ ] status/open 输出 slot、lease、ownership 和 CDP identity。

验证：shared 与 dedicated 两种 impact closure 分别启动，stop Beta 后 shared PID/home/lock/token 摘要不变。

### Step 4：实现 stop/reset/release 严格顺序

- [ ] stop 进入 `stopping` 后保持 lease。
- [ ] 只停止 identity 可验证的 dedicated 资源。
- [ ] 整体替换 mutable userData，并清空 slot-owned App Server mutable state。
- [ ] 成功写 manifest/metadata 后最后释放 lease；任一步失败都保留 lease。

验证：在 reset 中点并发启动第二 session，第二 session 必须失败且不得看到半清理状态；下一 owner 的浏览、认证与 App Server 行为态为空。

### Step 5：实现 release retention 与磁盘门禁

- [ ] current/previous pointer 成为 prune allowlist。
- [ ] 每类 runtime 最多 2 个 release，App backup 最多 1 个，日志同时满足数量/字节上限。
- [ ] 实现 `plannedWriteBytes`、`requiredFreeBytes`、清理前后 disk summary。
- [ ] pointer 损坏、估算失败或空间不足时 fail closed。

验证：同槽连续不同 revision 更新后 release 数和 `du` 达到稳定平台；低磁盘用例输出完整预算并不清 active/shared/Stable。

### Step 6：实现 pool janitor 与显式 legacy 流程

- [ ] janitor 只自动处理 pool v1 且所有权可证明的资源。
- [ ] unknown/corrupt lease 保持占用并输出人工恢复信息。
- [ ] legacy inventory 只读；cleanup 单实例、可恢复；purge 二次确认。
- [ ] active/unowned/symlink/path escape legacy 一律拒绝。

验证：stale pool 能恢复；active pool、active legacy、shared 与 Stable 均不受影响。

### Step 7：按 Runweave 变更验证门禁验收

- [ ] 完成最小代码修改后固定本次 patch 边界。
- [ ] 在只包含本次 patch 的 source root 首次执行无显式 profile 的 `pnpm dev:session --dry-run --json`，检查 planner 影响闭包，不向下降级。
- [ ] 仅通过 `pnpm dev:session` 启动验证 Session，并从 `dev:status` / `dev:open` 解析入口。
- [ ] Desktop 与 terminal-browser 分别通过 `dev:open --surface desktop|terminal-browser --json` 取得 CDP，使用 `$toolkit:playwright-cli attach --cdp=<endpoint>` 验证真实页面；桌面 App 启停与 Stable/Beta 并存使用 `$computer-use`。
- [ ] 完成 BSP-001 至 BSP-016，关闭本轮新建 tab、detach，执行 `dev:stop` 并确认 dedicated 资源清理。

## 风险与回滚

### 数据删除风险

- 删除只允许发生在 slot allowlist 内，路径必须无 symlink、未逃逸、lease/manifest/identity 一致；
- mutable reset 不使用“已知缓存目录”黑名单，而是整体替换 userData；
- legacy 永不自动删除，显式 cleanup 先进入有 journal 的 quarantine。

### 并发与崩溃风险

- lease 是唯一所有权真相，metadata/manifest 不能单独授权清理；
- reset 完成前不释放 lease；unknown schema 或 identity 漂移保持占用；
- start/stop 崩溃后由 manifest state + lease + recorded identity 收敛，不按 PID 或进程名猜测。

### release 回滚风险

- prune 前必须确认 current/previous/实际加载 release 一致；
- 健康切换成功前不改 previous allowlist；
- rollback 失败时保留两个 release、日志和 lease，禁止为了腾空间删除最后可用版本。

### 计划回滚

- 实现按 lease、路径分离、reset、retention、legacy 六个独立 commit 边界组织；
- 如 pool start 未通过门禁，回滚 dev-session 默认入口，但不自动删除已创建 pool App/runtime；使用显式 inventory/cleanup 处理；
- 不通过恢复旧的 per-session install target 作为长期 fallback。

## 验收标准

- 新 dev-session 任意多轮执行后，池化 App 和 slot 目录始终不超过 5；
- 第 6 个并发请求 fail closed，5 个 owner 明细可追踪且无双占；
- stop/reset 中途槽位不可复用，成功 reset 后才变 idle；
- 同槽多轮更新后 Desktop/App Server Runtime 各不超过 2 个 release，日志和 backup 不超过规定上限，`du` 不随轮次继续线性增长；
- dry-run 不写任何 pool/session 状态，也不承诺 assigned slot；
- shared Backend/App Server、Stable 和 active legacy 的 PID、路径、lock、token 与数据不被 pool stop/janitor 修改；
- 下一 owner 无法读取上一 owner 的 Cookie、LocalStorage、IndexedDB、标签、backend 凭据或 App Server 行为态；
- unknown/corrupt lease、identity drift、损坏 pointer、无法估算空间和低磁盘都 fail closed；
- legacy cleanup 只有显式单实例命令可执行，并提供 journal、恢复与二次 purge 确认；
- [docs/testing/beta-slot-pool-test-cases.md](../testing/beta-slot-pool-test-cases.md) 的 BSP-001 至 BSP-016 全部有真实证据并通过。

## 必跑门禁

按顺序执行，任一失败即停止：

```bash
pnpm dev:session:verify
pnpm runweave:beta:verify
pnpm runweave:update:test-cases
pnpm typecheck
pnpm lint
git diff --check
```

静态门禁不能替代真实行为验收。浏览器页面必须使用 `$toolkit:playwright-cli` 显式附着 `dev:open` 返回的本次 Session CDP；桌面联动必须使用 `$computer-use`；不得用系统浏览器、默认 endpoint、既有 Playwright session 或截图代替。

## 不做什么

- 不用新的 `rm -rf` 分支继续修补 per-session install 泄漏；
- 不把可重建 status cache 提升为租约真相；
- 不把 shared PID 写进 slot lease 或交给 slot janitor；
- 不为了通过磁盘门禁删除 active、current、previous、Stable 或无可信 owner 的 legacy 资源；
- 不让 dry-run 获取临时 lease；
- 不新增单元测试文件。
