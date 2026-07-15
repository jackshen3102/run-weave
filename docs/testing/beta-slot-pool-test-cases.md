# Runweave Beta 槽位池测试用例

## 需求来源

`dev-session` 的 Beta profile 当前会按 `instanceId/sessionId` 生成独立 Beta App、userData、Runtime 和 App Server home。目标是使用固定 5 个全局槽位，并同时保证租约原子性、跨 session 状态清空、release 数量与磁盘占用有界、shared/Stable 所有权安全和 legacy 显式迁移。

对应长期边界：`docs/deployment/runweave-beta.md#五槽位池计划状态`。原计划文档已按每日文档整理规则删除。

## 范围

覆盖：

- 5 个固定槽位的分配、显式请求、并发容量和 stop/acquire 时序；
- lease、manifest、service identity、status/open/CDP 的一致性；
- mutable userData 与 App Server state 的跨 owner 清空；
- current/previous release、App backup、日志与磁盘预算；
- shared Backend/App Server、Stable 和 legacy instance 的所有权边界；
- stale/orphan/broken/unknown-schema 的 fail-closed 与恢复。
- stop/reset/release 后在同一 validation HOME 显式复用同一 warm slot。

不覆盖：

- Beta 对外分发、签名、公证、Windows 和 Ionic App；
- 槽位抢占、排队和动态扩缩容；
- 新增单元测试文件。本仓库使用现有 verify 脚本、真实进程、`$computer-use` 与 `$toolkit:playwright-cli` 验收；
- 网络权限/HTTP 鉴权细节：本需求不新增业务接口，只验证 token/凭据不会跨 owner 或误删 shared 状态。

## 前提事实与验收规则

- 合法槽位只有 `pool-01` 至 `pool-05`；第 6 个并发请求必须失败。
- lease 是唯一所有权真相；metadata 只是可重建的 LRU/诊断数据。
- dry-run 的 capacity snapshot 非承诺，`assignedSlotId` 必须为 `null`。
- manifest 中 `assignedSlotId + leaseNonce + ownerSessionId` 必须与 lease 一致。
- stop/reset 成功并落盘后才能释放 lease；失败时 lease 保持占用。
- shared 服务只记录引用，slot janitor 无权停止或清理它们。
- 每槽 Desktop/App Server Runtime 最多各保留 current + previous 两个 release；App backup 最多 1 个；日志最多 5 个且合计不超过 64 MiB。
- 默认最小可用磁盘为 4 GiB；实际门禁为 `max(configuredFloor, plannedWriteBytes * 3)`。
- legacy 自动流程只 inventory；cleanup/purge 必须显式指定单实例/operation。

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

静态门禁不能替代真实行为验收。所有 UI/CDP 用例必须先通过 `pnpm dev:open --session <id> --surface <surface> --json` 解析本次 Session 目标，再用 `$toolkit:playwright-cli attach --cdp=<endpoint>`；桌面 App/Stable 并存证据使用 `$computer-use`。验收结束关闭本轮新建 tab、detach，并执行 `pnpm dev:stop --session <id> --json`。

## 用例索引

| ID      | 单一行为                                  | 验证方式                         |
| ------- | ----------------------------------------- | -------------------------------- |
| BSP-001 | 首次 start 只分配一个合法槽位             | CLI + 文件系统 + `$computer-use` |
| BSP-002 | 多轮 start/stop 不增加 install target     | CLI + 文件系统                   |
| BSP-003 | 多轮 update 后 release 与磁盘占用有界     | CLI + 文件系统                   |
| BSP-004 | 6 个并发请求最多成功 5 个                 | CLI + 真实进程                   |
| BSP-005 | stop/reset 完成前不能重新分配槽位         | CLI + 故障屏障脚本               |
| BSP-006 | 下一 owner 不继承 mutable 行为态          | CLI + `$toolkit:playwright-cli`  |
| BSP-007 | stale/orphan 槽位只在身份可证时恢复       | CLI + 真实进程                   |
| BSP-008 | active 槽位不会被其他 session 清理        | CLI + `$toolkit:playwright-cli`  |
| BSP-009 | status/open 与 lease/CDP 身份一致         | CLI + `$toolkit:playwright-cli`  |
| BSP-010 | 磁盘不足时先安全清理再 fail closed        | CLI + 文件系统                   |
| BSP-011 | 显式 `--instance` 不能绕过容量            | CLI                              |
| BSP-012 | dry-run 全程只读且不承诺槽位              | CLI + 文件快照                   |
| BSP-013 | shared Backend/App Server 不归槽位清理    | CLI + 真实进程                   |
| BSP-014 | 损坏/未知 lease schema 保持占用           | CLI + 文件系统                   |
| BSP-015 | start 失败按 reset 结果释放或保留 lease   | CLI + 故障注入                   |
| BSP-016 | legacy 只盘点，cleanup/purge 显式且可恢复 | CLI + 文件系统                   |
| BSP-017 | stop/reset 后 warm 重试仍复用同一槽位     | CLI + 真实进程 + `$computer-use` |

## 用例细则

### BSP-001 首次 start 只分配一个合法槽位

- Given：在隔离验证 HOME 中无 pool lease/App/slot 目录；真实 Stable 正常运行并已记录 App、Desktop、Backend、App Server PID 与路径摘要。
- When：通过 `pnpm dev:session --profile beta --json` 启动一个 Beta Session，并用 `$computer-use` 确认 Beta 窗口出现。
- Then：manifest 的 `assignedSlotId` 是 `pool-01` 至 `pool-05` 之一，lease 的 ownerSessionId/nonce 与 manifest 一致；只创建一个对应 Beta App 和 slot 目录；Stable 摘要不变。
- 失败判断：使用 sessionId 命名 App、一次创建多个槽位、lease/manifest 不一致，或 Stable 被重启/替换。

### BSP-002 多轮 start/stop 不增加 install target

- Given：隔离 HOME 中 pool 为空，仅保留 Stable 基线。
- When：串行执行 10 轮 Beta start/stop，每轮记录 `/Applications/Runweave Beta pool-*.app`、slot 目录和 lease 数量。
- Then：任意时刻 pool App/slot 目录都不超过 5；每轮 stop 后对应 lease 消失；不生成新的 `dvs-*`/`rcv-*` App 或目录。
- 失败判断：出现第 6 个 pool target、per-session target，或 stopped Session 仍无故持有 lease。

### BSP-003 多轮 update 后 release 与磁盘占用有界

- Given：一个 idle slot 已有 current/previous Desktop Runtime、App Server Runtime 和一个 App backup；记录槽位 `du`。
- When：在同一槽位连续执行 10 次产生不同 releaseId 的成功 update，并在每轮读取 current/previous pointer、release 目录、backup、日志数量与字节。
- Then：两类 Runtime 始终各不超过 2 个 release，App backup 不超过 1 个，日志不超过 5 个且合计不超过 64 MiB；第 3 轮后槽位 `du` 只随 current/previous 实际大小波动，不随轮次线性累积。
- 失败判断：存在未引用第 3 个 release、多个 backup、超限日志、current/previous 被删，或相同规模产物下 `du` 连续增长。

### BSP-004 6 个并发请求最多成功 5 个

- Given：5 个 slot 均 idle，准备 6 个不同 Session 请求并设置同步启动屏障。
- When：同时释放 6 个 start 请求。
- Then：恰好 5 个进入 ready 且持有不同 slot；第 6 个非零退出，错误列出 5 个 slot 的 ownerSessionId、manifest state、acquiredAt 和 stop 指引；无共享 JSON 丢更新。
- 失败判断：双占、创建第 6 个 target、静默等待、抢占 active slot，或错误缺少占用明细。

### BSP-005 stop/reset 完成前不能重新分配槽位

- Given：session A 独占 requested `pool-01`；验证脚本在 mutable userData rename 后、lease release 前设置可控屏障。
- When：A 执行 stop 并停在屏障；session B 同时显式请求 `pool-01`；随后释放屏障完成 A stop。
- Then：B 在屏障期间立即因 slot occupied 失败；A 完成 reset、manifest stopped、metadata 落盘后才释放 lease；之后新的 B 请求可获取 `pool-01`。
- 失败判断：B 在 reset 期间成功、看到半清理目录，或 A 在 reset/manifest 完成前删除 lease。

### BSP-006 下一 owner 不继承 mutable 行为态

- Given：session A 在 Beta 主 renderer 与 terminal-browser 写入 Cookie、LocalStorage、IndexedDB 和唯一页面 marker，并产生持久标签、`backend-auth.json`、browser auth-store、App Server event/cloud-sync/update marker；记录 warm current/previous release。
- When：停止 A，启动 session B 复用同一 requested slot；通过 `dev:open` 返回的 desktop/terminal-browser CDP 用 `$toolkit:playwright-cli` 读取新 Session 状态。
- Then：B 读不到 A 的 Cookie、LocalStorage、IndexedDB、标签、凭据和 App Server marker；B 生成新凭据；A 的 warm current/previous release 仍存在且身份不变。
- 失败判断：任一行为态跨 owner 可见、runtime 被误删，或为清状态停止/修改 shared 服务。

### BSP-007 stale/orphan 槽位只在身份可证时恢复

- Given：构造 pool v1 lease，其 manifest 为 stale 或缺失；allocatorPid 已死且 acquiredAt 超过 10 分钟；recorded dedicated PID 分别准备“身份匹配残留”和“PID 已复用身份不匹配”两组独立前置。
- When：运行 start 前 janitor 或 `stop --cleanup-stale`。
- Then：身份匹配组可安全 stop/reset/release；身份不匹配组不发信号、不删数据，slot 标记 broken 并输出证据与人工恢复指引。
- 失败判断：按 PID/进程名误杀身份不匹配进程，或未经 reset 直接释放 lease。

### BSP-008 active 槽位不会被其他 session 清理

- Given：session A ready，页面中有唯一 marker，lease/manifest/CDP identity 完整。
- When：session B start、stop、cleanup-stale 和 start janitor 分别运行。
- Then：A 的 lease、owner、PID、CDP endpoint 和页面 marker 均不变；B 只能取其他 idle slot 或 fail closed。
- 失败判断：A 被停止、数据被清、lease 被覆盖，或 B 的 endpoint 指向 A。

### BSP-009 status/open 与 lease/CDP 身份一致

- Given：一个 Beta Session ready。
- When：读取 `dev:status --json` 与 desktop/terminal-browser 两个 `dev:open --json` 结果，并分别用 `$toolkit:playwright-cli` attach。
- Then：status 的 slotId、ownerSessionId、leaseNonce、manifest state、ownership、appPath/userData 与 lease 一致；两个 CDP endpoint 都属于同 slot/session/revision，且 surface 分别正确。
- 失败判断：status 依赖 ambient CDP、隐藏 shared/dedicated ownership、nonce 不一致，或 endpoint 属于 Stable/其他 slot。

### BSP-010 磁盘不足时先安全清理再 fail closed

- Given：通过 `RUNWEAVE_BETA_POOL_MIN_FREE_BYTES` 构造当前 `freeBytes < max(configuredFloor, plannedWriteBytes * 3)`；同时准备可清理未引用 release/日志、active slot、shared 服务和 Stable 基线。
- When：启动 Beta Session。
- Then：系统只清理 pool 内可证明安全的未引用资源，重新计算后仍不足则拒绝启动；错误包含 free/configured/planned/required/cleaned/retained bytes；active/shared/Stable/current/previous 不变。
- 失败判断：空间不足仍启动、plannedWriteBytes 估算失败却按 0 继续，或删除受保护资源。

### BSP-011 显式 `--instance` 不能绕过容量

- Given：分别准备 requested `pool-01` 空闲、requested `pool-01` 已占用、`dvs-xxx`、`custom-name` 四个独立输入。
- When：执行 Beta dry-run 与真实 start。
- Then：合法空闲 slot 可获取；合法占用 slot 立即失败且不回退；非 pool 名称在 dev-session 层被拒绝；低层 legacy 命令仍可显式操作其 instance；不会创建 custom App。
- 失败判断：非法名称进入池、显式占用时偷偷换槽，或 legacy 入口被无关破坏。

### BSP-012 dry-run 全程只读且不承诺槽位

- Given：记录 pool root、session registry、5 个 lease/metadata、App/slot 目录的存在性、摘要与 mtime，并准备一个并发真实 start。
- When：执行 `pnpm dev:session --profile beta --dry-run --json`，随后让并发 start 占用 dry-run 快照中的 idle slot。
- Then：dry-run 输出 policy/capacity/requestedSlotId、`authoritative:false` 的 snapshot，assignedSlotId/leaseNonce 为 null；所有记录路径摘要与 mtime 不变；后续真实 start 可得到不同结果且不视为错误。
- 失败判断：dry-run 创建/修改任何状态、获取临时 lease，或承诺实际 assigned slot。

### BSP-013 shared Backend/App Server 不归槽位清理

- Given：planner 选择 shared Backend/App Server，记录 shared PID、home、lock、token、event log 与内容摘要；Beta Electron 使用一个 slot ready。
- When：停止 Beta、运行 pool janitor 与磁盘 retention。
- Then：只停止/清理 slot-owned Electron/userData；shared PID 继续存活，home/lock/token/event 摘要不变；manifest 明确显示 shared ownership。
- 失败判断：shared 资源被写入 lease、被 stop/delete/prune，或状态输出把 shared 声称为 slot-owned。

### BSP-014 损坏/未知 lease schema 保持占用

- Given：分别构造未知 schemaVersion、JSON 损坏、symlink、nonce 与 manifest 不一致四组独立 lease。
- When：执行 start janitor 和新的 slot acquire。
- Then：对应 slot 均标记 broken/occupied，不覆盖、不删除、不沿 symlink，错误指出具体失败证据；其他健康 idle slot 仍可分配。
- 失败判断：猜测修复、覆盖 lease、删除未知资源、路径逃逸，或一个坏 slot 阻断全部健康 slot。

### BSP-015 start 失败按 reset 结果释放或保留 lease

- Given：两组独立故障注入：A 在服务 ready 前失败但 identity-safe stop/reset 成功；B 在 reset 删除 mutable state 时失败。
- When：分别执行 Beta start。
- Then：A manifest 为 failed 且 lease 已释放；B manifest 为 stale/broken 且 lease 保留，后续请求不能复用该 slot，并获得 cleanup-stale 指引。
- 失败判断：A 永久泄漏 lease，或 B 未完成 reset 却释放 lease。

### BSP-016 legacy 只盘点，cleanup/purge 显式且可恢复

- Given：准备 inactive trusted legacy、active legacy、无可信 identity legacy、symlink/path-escape legacy 和 Stable 基线；所有组独立。
- When：先运行自动 start janitor 与 `legacy-inventory --json`，再仅对 inactive trusted instance 执行 `legacy-cleanup --instance <id> --json`、`legacy-restore --operation <id> --json`、再次 cleanup 和 `legacy-purge --operation <id> --confirm <id> --json`。
- Then：自动 janitor/inventory 不删除任何 legacy；trusted cleanup 原子进入 quarantine 并写 journal/恢复命令，restore 可恢复，purge 只有 operationId 与 confirm 一致才删除；active/unowned/symlink/path-escape/Stable 均拒绝。
- 失败判断：按 glob 自动删除、active/无 owner 被清、无 journal 无法恢复、错误 confirm 仍 purge，或 Stable 被修改。

### BSP-017 stop/reset 后 warm 重试仍复用同一槽位

- Given：同一隔离 validation HOME 中 `pool-01` 已有 warm App、warm-state 与 App Server Runtime；按 warm-state 的实际 update mode 记录 Desktop 基线：`mode=app` 时记录 App identity 且允许 `runtimeReleaseId=null`，`mode=runtime` 时还必须记录 Desktop Runtime current release；上一 owner 已完成 stop/reset，manifest 为 `stopped` 或 identity-safe `failed`，`pool-01` lease 已释放，mutable user state 已清空；同时记录 App Server current release 与 Stable 摘要。
- When：显式执行 `pnpm dev:session --profile beta --instance pool-01 --json` 启动 session A，用 `$computer-use` 确认窗口后执行 `pnpm dev:stop --session <sessionA> --json`；确认 stop/reset 与 lease release 完成，再在同一 validation HOME 中再次显式请求 `pool-01` 启动 session B。
- Then：A 与 B 都分配 `pool-01`，各自 manifest/lease 的 ownerSessionId 与 nonce 在其生命周期内一致且两轮 nonce 不同；B 只能在 A 的 reset、stopped/failed manifest 落盘和 lease 释放后获取槽位；不创建或切换到其他 pool App/slot；既有 warm App、warm-state、按 update mode 实际存在的 Desktop Runtime release 与 App Server Runtime 归属链保留，Stable 摘要不变。
- 失败判断：A 未安全收敛便让 B 获取 lease、B 随机切换其他 slot、创建新的 App/slot、复用 A 的 nonce、删除既有 warm App/runtime、把 `mode=app` 的合法 `runtimeReleaseId=null` 误判为环境阻塞、修改 Stable，或在 Given 不成立时仍强行重试。Computer Use 服务不可用时只把窗口证据标记为环境 `blocked`，不得据此判产品失败。

## 覆盖清单

- 主路径：BSP-001、BSP-002、BSP-006、BSP-009。
- 边界值：BSP-003 覆盖 release/log 上限；BSP-004 覆盖容量 5/6；BSP-010 覆盖磁盘阈值上下界。
- 非法输入：BSP-011、BSP-014、BSP-016。
- 状态迁移：BSP-005、BSP-007、BSP-015 覆盖 starting/ready/stopping/stopped/failed/stale/broken。
- 并发与迟到：BSP-004、BSP-005、BSP-008、BSP-012。
- 幂等与去重：BSP-002 重复 start/stop；BSP-016 cleanup/restore/purge operation identity。
- 数据与协议：BSP-006、BSP-009、BSP-014 验证持久文件和 manifest/lease/CDP 合约。
- 安全与权限：BSP-006 防跨 owner 数据泄漏；BSP-007/BSP-013/BSP-016 防越权清理。
- 回归兼容：BSP-002 禁止 per-session target；BSP-011 保留低层 legacy；BSP-013 保留 shared impact closure。
- 网络失败不单独覆盖：本需求不引入远程网络依赖；App Server/Backend 不可用由 BSP-015 的 start failure 路径覆盖。

## 通过标准

- 所有必跑门禁通过；
- BSP-001 至 BSP-016 均有可定位到本次 validationSessionId、slotId、leaseNonce、manifest 和命令输出的证据；
- 任意失败不得以重跑、默认浏览器、ambient CDP、截图或静态检查替代真实行为结论；
- 验收结束关闭本轮新建 tab、detach、stop Dev Session，并确认 dedicated 资源与 lease 已按预期收敛。
