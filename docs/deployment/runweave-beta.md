# Runweave Beta 开发与使用指南

Runweave Beta 是 macOS 本机开发通道。正式版 Runweave（Stable）继续承载终端和开发上下文；当前源码 worktree 通过 Beta 控制命令构建并部署到本机 Beta 实例，作为被开发、重启、验证和回滚的目标。

日常开发不再自行命名 Beta 实例。`pnpm dev:session` 从固定的 `pool-01` 至 `pool-05` 中分配一个槽位，并用 lease 隔离并行 worktree；调用方只保存返回的 `devSessionId`。`default`、`agent-a` 等自定义实例只作为既有 legacy 资源被只读盘点、停止或显式清理，不能再更新、打开或回滚。

`dev-session --profile beta` 使用独立的固定池策略：只会分配 `pool-01` 至 `pool-05`，不再按 Session 创建新的 App 或实例目录。`--dry-run` 只返回非权威容量快照；真实 start 才获取 lease，stop 完成进程身份校验、mutable reset、release retention 和 metadata 落盘后才释放。`update`、`open`、`rollback` 等低层可变操作只接受固定池 ID；既有 legacy instance 只允许只读盘点、停止和显式 cleanup，不再允许创建或更新。

池槽位的 Desktop Runtime 与 update state 位于实例根目录的 `runtime/` 和 `warm-state/`，不在会被整体替换的 `user-data/` 中。每槽 Desktop Runtime、App Server Runtime 只保留 current + previous；App 回滚副本使用不带 `.app` 后缀的隐藏 rollback 目录，避免被 LaunchServices 注册。legacy 资源只由 `legacy-inventory` 盘点，必须通过单实例 `legacy-cleanup` 进入 quarantine，并用 operation id 显式 restore 或二次确认 purge。

当前没有单独的 `dev:beta` 热开发命令。推荐模型是：

```text
Stable Runweave 中修改代码
        ↓
预览 planner 的影响范围
        ↓
获取池槽位并构建、更新 Beta
        ↓
在 Beta 中验证真实行为
        ↓
停止 Session，再继续下一轮修改
```

## 适用范围与前置条件

- 当前实现仅面向 macOS 本机开发，不是对外分发的 Beta 发布渠道。
- 在目标源码 worktree 中执行本文命令；更新状态会记录该 worktree 的路径和源码 revision。
- 推荐保持 `/Applications/Runweave.app` 正常运行，并在 Stable terminal 中执行 Beta 更新，以免被测 Beta 重启时中断开发控制面。
- 仓库固定使用 `pnpm@10.6.2`。首次构建前执行 `corepack enable && pnpm install`，并确认当前 worktree 能正常执行项目构建命令。
- 需要页面级验收时，先用 `command -v playwright-cli` 确认 CLI 命令可用，并使用 `$toolkit:playwright-cli` skill 执行验收。

## 快速开始

### 1. 只读规划

```bash
pnpm dev:session --dry-run --json
```

确认 planner 选择 `profile=beta`、目标 source root 与影响闭包正确。dry-run 不分配槽位，也不创建 App、目录、manifest 或 lease。

### 2. 启动并保存 Session ID

```bash
pnpm dev:session --json
```

从结果保存 `devSessionId`、`source.root` 和 `targetEnvironment.instanceId`。默认由 allocator 选择槽位；只有测试合同明确要求时才传 `--instance pool-0N`。

### 五槽位池状态

`dev-session --profile beta` 已收敛到固定 5 个全局槽位：`pool-01` 至 `pool-05`。lease 是池化所有权真相；不要用低层命令、端口、最近启动时间或窗口名称推断目标。

使用独立的只读控制面查看五槽联合事实：

```bash
pnpm dev:pool
pnpm dev:pool --json
```

`dev:pool` 联合读取 lease、owner manifest、dedicated runtime、shared dependency 与最近一次 recovery receipt，返回 `idle / healthy / partial / degraded-shared / stale-reclaimable / stale-manual / broken`。它是带 `observedAt` 的观察快照，`reservationGuaranteed=false`，不会创建 claim、manifest、lease、metadata 或迁移目录；真实分配仍以 hard-link lease publication 为准。JSON 中的 `storage` 会说明当前使用 `canonical`、`legacy-draining`、`migration-resumable` 或 `conflict`。

Pool 控制面唯一 canonical 根是 `~/.runweave/beta-pool`。旧版本创建的 `~/Library/Application Support/Runweave Beta/pool` 只用于兼容排空：仍有旧 lease 或 recovery claim 时，新 start 返回 `beta_pool_legacy_drain_required`，必须先按输出中的 owner Session 执行 stop/recover。最后一个旧 lease 释放后，下一次真实 start 才执行一次迁移；迁移会保留 `pool.migrated-<migrationId>` 备份，并在旧路径留下 regular-file tombstone，阻止旧版本降级后创建第二套 lease。

定向恢复 valid lease 时必须显式匹配 owner Session：

```bash
pnpm dev:pool recover --slot pool-03 --session <ownerSessionId> --json
```

corrupt lease 无可读 owner 时省略 `--session`，仅允许“零 slot 进程 + 路径引用可信 + lease 文件 identity 稳定”的 guarded quarantine。不存在 `--force`、`--force-kill` 或 `--force-release` 绕过入口。

池化实现必须同时满足：

- dry-run 只输出 `policy`、`capacity`、`requestedSlotId` 和非权威 capacity snapshot，
  不创建 session、manifest、lease 或目录，也不承诺 `assignedSlotId`。
- 真实 start 获取单槽 lease 后，才把 `assignedSlotId + leaseNonce` 写入 manifest；
  lease 是唯一所有权真相，metadata 只用于 LRU 与诊断。
- stop/reset 必须在停止 slot-owned 进程后执行统一 release transaction：替换 mutable
  `user-data`、清理 dedicated App Server state、写入 `release_pending` receipt、释放 lease，
  最后把 owner manifest 收敛到 `stopped/completed`。
- shared Backend/App Server 只记录引用，永远不被 slot janitor 停止或删除；Stable 与 legacy instance 不属于自动池清理范围。
- 每个槽位的 Desktop Runtime 与 App Server Runtime 最多保留 current + previous；App rollback 最多 1 个且不能以 `.app` 结尾。旧 `.app.previous-*` 会迁移并注销 LaunchServices 路径。磁盘不足时只能清理所有权可证明的 pool 垃圾，仍不足则 fail closed。
- stale cleanup 只有在记录 PID 已退出或整个槽位不存在运行进程/路径所有者时才释放 lease；PID 复用且仍有槽位进程时继续 fail closed。

当前唯一行为验收入口是 [Beta Pool 全场景测试计划](../testing/platform/beta-pool-storage-migration.testplan.yaml)。该计划覆盖全新 canonical 环境中的五槽主链，以及原 Beta 资源管理合同中的投影、异常识别、安全恢复、并发竞争、崩溃收敛和诊断发布；只排除 legacy 控制面旧数据迁移、迁移 journal、tombstone、备份与降级测试。需要验证 `dev-session --profile beta` 时，以该合同和 `dev:status` / `dev:open` 返回的 slot、lease、manifest、CDP 身份为准。

### 3. 查询、打开和停止

```bash
pnpm dev:status --session <devSessionId> --json
pnpm dev:open --session <devSessionId> --surface desktop --json
pnpm dev:stop --session <devSessionId> --json
```

后续每条命令都显式使用同一个 Session ID。页面验收只连接 `dev:open` 返回的 CDP；不要手工打开 App 或猜固定端口。

## 日常开发流程

每轮修改完成后停止旧 Session，再重新规划和启动：

```bash
pnpm dev:stop --session <devSessionId> --json
pnpm dev:session --dry-run --json
pnpm dev:session --json
```

多 worktree 分别在各自 source root 中保存独立 Session ID；allocator 会用 lease 隔离共享的五槽位，不要把一个 worktree 的 Session ID 用到另一个 worktree。

### 自动更新策略

默认 `auto` 是推荐模式：

| 源码变化                        | 更新动作                                |
| ------------------------------- | --------------------------------------- |
| frontend/backend 等运行时代码   | 构建新的 Desktop Runtime，并重启 Beta   |
| Electron shell、打包或原生资源  | 重新打包并安装完整 Beta App             |
| App Server 相关路径             | 独立构建并切换 Beta App Server          |
| 首次部署或缺少历史状态          | 完整 Beta App，并初始化 Beta App Server |
| 已部署且内容未变化的 dirty 文件 | 不重复触发对应组件更新                  |

完整 App 的敏感路径列表以 `scripts/runweave-update-core.mjs` 中的 `APP_SENSITIVE_PATH_PREFIXES` 为准，App Server 路径以 `APP_SERVER_SENSITIVE_PATH_PREFIXES` 为准；跨目录改动以 `--dry-run` 的实际选择和原因作为权威判断。

### 强制更新模式

`runweave-beta.mjs update/open/rollback` 是 Dev Session 内部控制链，只接受 `pool-01` 至 `pool-05`。日常开发不要直接调用低层 `--mode`、`--app-server` 或 `--no-restart`，避免绕过 lease、manifest 与 stop/reset 顺序；由 planner 和 Dev Session 选择实际更新闭包。

## 在 Beta 中使用 Runweave

Beta 页面顶部会显示以下构建标识，窗口标题也包含源码 revision：

```text
BETA · <version> · <source revision>
```

在 Beta 中打开项目并创建 terminal 后，terminal 会自动获得 Beta backend 地址、独立 CLI profile 和 Beta App Server 环境。可以用只读命令确认连接目标：

```bash
rw health --json
```

Beta terminal 的输出应满足 `reachable=true`、`authenticated=true`、`profile=beta`，且 `baseUrl` 与 `pnpm dev:status --session <devSessionId> --json` 返回的 `backend.baseUrl` 一致。Stable terminal 应连接 Stable backend，Beta terminal 应连接 Beta backend。

### Beta 登录账号

Beta 是仅监听本机的开发通道，使用固定登录凭据：

```text
账号：admin
密码：admin
```

固定弱密码只允许在显式 Beta Desktop 通道中使用。Stable 和其他 packaged backend 仍会拒绝 `admin/admin`。

### 更新命令的通道语义

以下正式更新命令始终指向 Stable，即使它从 Beta terminal 中执行：

```bash
pnpm runweave:update
```

更新 Beta 必须回到 Stable terminal，通过 Dev Session 执行：

```bash
pnpm dev:session --dry-run --json
pnpm dev:session --json
```

这是保护边界，不是环境继承错误。正式更新器会清除 Beta-scoped 环境，并固定使用 Stable App、Runtime、App Server 和更新状态。

## 固定隔离边界

以下 `<slotId>` 只能是 `pool-01` 至 `pool-05`：

| 资源                  | Beta 路径或身份                                                    |
| --------------------- | ------------------------------------------------------------------ |
| Desktop App           | `/Applications/Runweave Beta <slotId>.app`                         |
| bundle id             | `com.runweave.desktop.beta.<slotId>`                               |
| 实例根目录            | `~/Library/Application Support/Runweave Beta/instances/<slotId>`   |
| Electron userData     | `<实例根目录>/user-data`                                           |
| backend profile       | `<userData>/browser-profile`                                       |
| CLI profile           | `<userData>/cli/config.json`                                       |
| Desktop Runtime       | `<实例根目录>/runtime`                                             |
| 更新状态              | `<实例根目录>/warm-state/state.json`                               |
| App Server            | `~/.runweave/app-server-beta/<slotId>`                             |
| App Server cloud sync | `~/.runweave/app-server-beta/<slotId>/cloud-sync`                  |
| Pool 控制面           | `~/.runweave/beta-pool`                                            |
| Desktop CDP           | `dev:open --surface desktop` 返回的动态 loopback endpoint          |
| Terminal Browser CDP  | `dev:open --surface terminal-browser` 返回的动态 loopback endpoint |

Beta 构建不会安装全局 completion hook，不显示或启用正式版自动更新入口。Beta backend 启动后会在独立 CLI profile 中 refresh/login，并把动态 backend URL 和该 profile 路径注入新 terminal；不会读取或覆盖 `~/.runweave/config.json`。

## 验证

### 静态与结构门禁

```bash
pnpm runweave:beta:verify
pnpm runweave:update:test-cases
pnpm --filter @runweave/electron typecheck
pnpm --filter @runweave/frontend typecheck
pnpm lint
git diff --check
```

`runweave:beta:verify` 检查 Stable/Beta 写路径是否重叠、Beta builder identity 是否存在，以及 status 是否包含敏感字段；它不能代替真实行为验收。

### 页面与 CDP 验证

先从当前 Session 解析 surface，再使用 `$toolkit:playwright-cli` 显式附着该 endpoint：

```bash
pnpm dev:open --session <devSessionId> --surface desktop --json
playwright-cli -s=runweave-beta-desktop attach --cdp="<dev:open 返回的 cdpEndpoint>"
playwright-cli -s=runweave-beta-desktop eval \
  "JSON.stringify({title: document.title, channel: document.documentElement.dataset.runweaveChannel, revision: document.documentElement.dataset.runweaveSourceRevision})"
playwright-cli -s=runweave-beta-desktop detach
```

预期 `channel` 为 `beta`，标题和页面 revision 与 `dev:status` 中的 `source.revision` 对应。dirty 或 untracked 内容不会进入页面 revision；是否部署了脏工作区必须同时检查 `source.dirty` 和更新状态中的 worktree snapshot。桌面并存、退出、恢复和窗口身份使用 `$computer-use` 验证。

Terminal Browser 验收先执行 `pnpm dev:open --session <devSessionId> --surface terminal-browser --json`，再附着其返回的 endpoint。Desktop CDP 和 Terminal Browser CDP 是不同 surface；不要用一个 endpoint 代替另一个，也不要使用全局 `PLAYWRIGHT_MCP_CDP_ENDPOINT` 或 Playwright 默认配置猜测目标。

完整回归按 [Runweave Beta 自举开发通道测试计划](../testing/platform/runweave-beta-self-hosting.testplan.yaml) 执行。静态命令、status 或代码阅读不能代替该文档要求的真实桌面与页面行为证据。

## 回滚

正常开发通过停止当前 Session、切换到要验证的源码 revision，再启动新的 Dev Session 完成回退。低层 rollback 只接受固定池 ID，作为控制链内部恢复能力；不能再用 `default`、`agent-a` 或其他自定义实例创建回滚目标。

App 回滚副本保存在 `/Applications/.Runweave Beta pool-0N.rollback-<timestamp>`。该目录与 App 同卷以保持原子 rename，但不以 `.app` 结尾，不会作为独立应用注册；每个槽位最多保留一个引用中的 rollback。

Pool 存储迁移和 App 版本回滚是两个独立边界。canonical Pool 已产生 lease 后，不允许自动恢复到旧 Pool；需要降级时，先用理解 `~/.runweave/beta-pool` 的当前版本停止全部 Beta Session。旧版本命中 legacy tombstone 后失败是预期的 fail-closed 行为，不能删除 tombstone 后直接重试，否则可能形成双 Pool。

更新失败或更新后 45 秒内未达到健康状态时，Beta 更新器会先尝试自动恢复更新前基线，再记录失败摘要。自动恢复失败时不要继续反复更新，先根据 status 和日志定位组件。

## 日志与常见问题

### `beta_pool_legacy_drain_required` 或存储迁移阻塞

先执行 `pnpm dev:pool --json`，按 `storage.mode` 处理：

- `legacy-draining`：停止 `legacyOwners` 中列出的 Session；不要手工移动 lease。
- `migration-resumable`：保留 journal、staging、backup 和 tombstone，重新执行原 start 让事务续跑。
- `conflict`：禁止继续 start/stop 自动操作，核对输出中的 canonicalRoot、legacyRoot 和 blockedBy；不要合并或删除任一根。

首次迁移需要精确读取一次旧 App 数据目录，macOS 仍可能请求一次授权。迁移完成后的正常 Pool 生命周期不再访问旧根；手工执行 `find ~/Library` 等宽目录命令仍可能独立触发系统隐私提示。

更新日志位于：

```text
~/Library/Application Support/Runweave Beta/instances/<slotId>/diagnostics/logs/
```

失败摘要和对应日志路径同时出现在：

```bash
pnpm dev:status --session <devSessionId> --json
```

### `dry-run` 意外选择完整 App

查看输出中的 `native-sensitive changes` 和 `reason`。Electron 主进程、打包配置、资源或更新脚本变化会触发完整 App；首次部署和源码 shell 版本高于已安装版本也会触发完整 App。

### Beta 已打开，但 status 报告不健康

依次核对 `desktop`、`backend`、`appServer`、`cdp` 四个对象。不要只按进程名判断：status 还会验证 Beta App 路径、PID、profile、健康接口以及 CDP 监听进程归属。

### 无法回滚

只有成功更新后保存了上一可用基线，`rollback` 才能恢复。首次安装前或上一基线已经不存在时，命令会明确返回 `No previous Beta release is available for rollback`。

### Beta 与 Stable 看起来相同

优先检查窗口标题和页面顶部的 `BETA` 标识，再用 `status --json` 中的 App 路径、userData、backend profile、Desktop CDP 和 Terminal Browser CDP endpoint 交叉确认。不要只凭 Dock 图标或端口猜测通道。
