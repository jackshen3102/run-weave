# 终端 tmux 持久化修复复评

## 结论

Stable/Beta/local 的生命周期切分方向成立。在仓库规定的标准启动路径下，没有发现 Beta 或本地退出会误清 Stable tmux 的入口：Stable 的清理列表恒为空，Beta profile 由 Beta 控制脚本显式隔离，本地 `pnpm dev` 会清除从 Stable 终端继承的 channel。

该方案不是零副作用。Beta/本地退出后不再保留后台终端是明确接受的产品行为；tmux 查询异常改为向上抛出后，用户可能遇到一次可重试的打开失败，但不会再把超时误判成 session 丢失。P1 启动时延风险已解决，当前完整 diff 仍有 1 个 P2 元数据问题。

## 发现

### 已解决：启动环境同步按 session 串行重试，同一故障 Socket 最坏阻塞 Stable 初始化 195 秒

- 位置：`backend/src/terminal/tmux-session-environment-sync.ts`、`backend/src/bootstrap/runtime-services.ts`
- 原风险：每个 running tmux session 都独立执行 Socket 操作。当前 Stable store 有 39 个 running tmux session；同一 Socket 不响应时，每个命令最多等待 5 秒，理论最坏等待为 `39 × 5s = 195s`。
- 处理结果：恢复 `#289` 的非阻塞启动和并发上限原则；环境刷新改为按 Socket 分组、最近活跃优先、Socket 并发 2。每个 Socket 只清理和探测一次，Socket 异常后熔断该组；健康 Socket 仍刷新全部 session，保证后台 Agent 获得新 Backend/App Server 环境。

### P2：旧 Socket 不存在时，在新 session 建立前就持久化 `recoverable: true`

- 位置：`backend/src/terminal/runtime-launcher.ts:97-114`
- 风险：旧 Socket 和新 Socket 都没有目标 session 时，代码先把 metadata 指向新 Socket并记录“migrated”，然后才进入重建。如果后续创建失败，存储和日志会表达一个尚未完成的迁移。
- 修复方向：将当前动作记录为 retarget；仅在新 Socket 已有目标 session，或新 session 创建成功后，再标记迁移完成和 `recoverable: true`。

## 明确接受的副作用

- Beta/本地 Backend 正常退出会停止其 tmux server，因此其中的 shell、Agent 和后台命令不会跨退出保留。这是本轮确认的目标行为。
- `hasSession()` 遇到 timeout、权限或基础设施错误时会返回失败，而不是自动恢复 thread。表现可能是一次终端打开失败，需要重试；代价是不会再静默丢弃原 tmux 状态。
- Stable 会长期保留自身 tmux server、Socket 和少量配置文件；卸载应用或永久删除 profile 时不会自动清理，这是“Stable 不能丢 tmux”的直接代价。

## 残余边界

- Beta/本地只有在 Backend 收到正常 `SIGINT`/`SIGTERM` 并进入 shutdown handler 时清理；崩溃或 `SIGKILL` 无法执行进程内清理，可能留下临时 tmux server。
- 标准本地入口 `pnpm dev` 会清除 `RUNWEAVE_DESKTOP_CHANNEL`。若绕过它，直接从 Stable 终端执行 backend package 的 dev 命令，子进程可能继承 `stable` 并按持久策略运行；这不是仓库规定的开发入口。
- Beta 控制脚本和 Dev Session 都显式覆盖独立 `BROWSER_PROFILE_DIR`。若手工启动 Beta 并强制把 profile 指向 Stable profile，旧 Beta 持久 Socket 清理可能触达同 profile 的持久 server；标准路径不会形成该配置。

## 已确认安全的部分

- `electron/src/desktop-config.ts:49` 使用编译期 channel 覆盖环境变量，正式 Stable packaged Backend 能稳定识别为 `stable`。
- `backend/src/bootstrap/runtime-services.ts:312-321` 对 Stable 生成空清理列表；退出路径只遍历该列表，不读取任意 session store Socket，避免脏 metadata 扩大删除范围。
- Beta updater 在 `scripts/runweave-beta-operations.mjs:56-69` 显式设置独立 profile、channel 和 userData，不依赖父进程推断。
- 更新器改用 `ps -axo pid=,comm=`，匹配真实 App bundle 可执行文件；tmux 参数中的 `.app/Contents/` 不再参与判断。

## 检查证据

- `git diff --check`：通过。
- `pnpm -C backend typecheck`：通过。
- `pnpm -C backend lint`：通过。
- 39-session 定向 harness：健康场景刷新 39 个 session，仅执行 2 次 Socket 清理和 2 次探测；单 Socket 故障只产生 1 个失败，另一 Socket 的 19 个 session 正常刷新。
- `pnpm agent-team:verify-review-checkpoints`：通过，包含真实 tmux App Server 环境刷新 checkpoint。
- Beta `dvs-1a44ca / pool-04` 创建真实终端后停止：临时 Socket 与 tmux server 均消失。
- Beta `dvs-e51f53 / pool-04` 停止：旧 Beta 持久 PID `53010` 被回收；Stable tmux PID `53705`、`57543` 和对应 session 保持存活。
