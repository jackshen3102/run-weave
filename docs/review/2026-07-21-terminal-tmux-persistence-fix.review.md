# 终端 tmux 持久化修复代码评审

## 结论

核心方向成立：更新器改为按真实可执行文件匹配，能够避免 tmux 因命令行环境参数包含 `Runweave.app/Contents/` 而被误杀；`hasSession()` 不再把超时吞成“会话不存在”也是正确的 fail-closed 方向。

当前版本已解决验证脚本断链、Beta/本地 tmux 生命周期问题和 P1 启动时延问题。仍有 1 个 P2 元数据问题，不属于本轮 Stable/Beta 生命周期策略的修改范围。

## 发现

### 已解决：移动导出后遗留旧导入，review-checkpoint 验证命令会直接启动失败

- 位置：`scripts/verify-agent-team-review-checkpoints/bootstrap-lifecycle-reconciliation.mjs:2`
- 风险：`syncExistingTmuxSessionEnvironments` 已从 `runtime-launcher.ts` 移到 `tmux-session-environment-sync.ts`，但验证脚本仍从旧文件导入。`pnpm agent-team:verify-review-checkpoints` 加载该模块时会抛出 `SyntaxError: ... does not provide an export named 'syncExistingTmuxSessionEnvironments'`。常规 TypeScript 检查不覆盖该 `.mjs`，所以此前门禁没有发现。
- 处理结果：验证脚本已改从 `tmux-session-environment-sync.ts` 导入，动态导入检查通过。

### 已解决：持久 Socket 没有接入 Dev Session/Beta 生命周期，会留下无法回收的 tmux server

- 位置：`backend/src/bootstrap/runtime-services.ts:100`
- 风险：所有 profile 默认改用 `~/.runweave/tmux/<profileHash>/tmux.sock`，包括会被停止或重置的 Dev Session/Beta profile。真实验证停止 `dvs-f39684` 后，Beta profile 的 `terminal-session-store.json` 已不存在，但 PID `53010` 和 4 个 tmux session 仍在该持久 Socket 上。它们继续持有旧 Backend/App Server URL、token 和应用路径环境，且默认 orphan scan 没有开启。后续每次临时 profile 都可能留下永久进程和陈旧环境。
- 处理结果：Stable 使用持久 Socket，退出时清理列表恒为空；Beta/本地使用临时 Socket，并在 Backend 正常退出时先停止自身拥有的 tmux server 再删除 Socket。Beta 额外清理同 profile 的旧版持久 Socket，清理范围不再信任 session store 中的任意历史路径，避免脏元数据误伤 Stable。

### 已解决：启动环境同步在 Socket 故障时按 session 串行等待，当前数据量最坏可阻塞 195 秒

- 位置：`backend/src/terminal/tmux-session-environment-sync.ts`、`backend/src/bootstrap/runtime-services.ts`
- 原风险：当前 Stable store 有 39 个 running tmux session，而每次 tmux 命令超时为 5 秒。同一 Socket 不可响应时会重复执行 `sanitizeGlobalEnvironment()`，理论最坏等待 `39 × 5s = 195s`，Backend 在同步完成前不能完成初始化。
- 处理结果：启动不再等待环境同步；同步按 Socket 分组、最近活跃优先并限制 Socket 并发为 2。每个 Socket 只做一次全局环境清理和 session 列表探测，故障后熔断该组；健康 Socket 内仍刷新所有存活 session。

### P2：迁移分支在新 session 尚未建立时就写入 `recoverable: true`，日志也把“改目标”称为“已迁移”

- 位置：`backend/src/terminal/runtime-launcher.ts:97-114`
- 风险：当旧 Socket 不存在且新 Socket 也没有 session 时，代码先持久化新 Socket 并设为 `recoverable: true`，随后才进入重建流程；日志却记录 `Migrated missing tmux session`。当前该字段影响有限，但失败时持久化状态和运维日志会表达一个尚未完成的迁移，未来消费者容易把它当成已恢复事实。
- 修复方向：把该动作命名为 retarget，或仅在新 Socket 已存在 session/新 session 成功创建后再标记迁移完成和 `recoverable: true`。

## 已确认安全的部分

- `scripts/runweave-update-operations.mjs` 和 `scripts/electron-local-update.mjs` 使用 `ps -axo pid=,comm=` 后只匹配 App bundle 内真实可执行文件。当前 Stable 实测识别 12 个 Runweave/Electron 进程，没有把 tmux 纳入结果；Stable 与 Beta 的 App 名也不会互相匹配。
- `hasSession()` 对超时等基础设施错误改为抛出，而不是返回 `false`，方向正确。调用方中涉及“会话不存在即标记退出”的 watcher 已改为错误时保守视作仍存在；其他直接调用方会返回暂时失败，不会误触发 thread 恢复。
- 旧 Socket 仍存活时继续附着旧 Socket，避免为了迁移主动杀掉用户现有终端，这个策略正确。

## 检查证据

- 动态导入 `bootstrap-lifecycle-reconciliation.mjs`：通过。
- 当前 Stable session store：39/39 为 running tmux session，分布在 2 个 Socket。
- 39-session 定向 harness：健康场景刷新全部 39 个 session，仅执行 2 次 Socket 清理和 2 次探测；单 Socket 故障只产生 1 个失败，另一 Socket 的 19 个 session 正常刷新。
- `pnpm agent-team:verify-review-checkpoints`：通过，包含真实 tmux App Server 环境刷新 checkpoint。
- Beta `dvs-1a44ca / pool-04` 创建真实终端后停止：临时 Socket 不存在、tmux server 不响应。
- Beta `dvs-e51f53 / pool-04` 停止：旧 Beta 持久 tmux PID `53010` 和 Socket 被清理；Stable tmux PID `53705`、`57543` 仍存活，对应 Socket 上分别保留 5、9 个 session。
- 新进程匹配：返回 12 个 `/Applications/Runweave.app/Contents/...` 可执行进程，不包含 tmux。

## 残余风险

- 这次根因没有对应的自动化更新器防回归用例；真实 Beta 更新验收通过，但后续修改进程匹配仍可能再次引入误杀。
- 已存在的旧临时 Socket session 不会主动搬迁；只有旧 session 确认丢失后才会改用新 Socket，因此存量终端仍可能经历一次恢复。
