# tmux output watcher 最新代码评审

评审日期：2026-06-09

评审范围：当前工作区最新未提交变更，重点覆盖 `TmuxOutputWatcher`、tmux `pipe-pane` 接入、runtime 恢复路径、移动概览回退、App composer 图标依赖收敛。

验证命令：

- `git status --short`
- `git diff --stat`
- `pnpm --filter @runweave/app typecheck`
- `pnpm --filter ./backend typecheck`
- `pnpm --filter ./backend test -- tmux-output-watcher tmux-service`

验证结果：App 类型检查通过，backend 类型检查通过，backend Vitest 命令通过。最后一个命令实际执行并通过了 backend 当前匹配到的 58 个测试文件、367 个测试。

## 架构 / 策略发现

### P1 - tmux output transport 文件无容量边界，可能绕过既有 scrollback 限制耗尽磁盘

- 当前决策：新增 `TmuxOutputWatcher` 使用 `tmux pipe-pane` 把 pane 输出写入 `tmux-output/<terminalId>.log`，再用定时轮询按 offset 读取并写回 `TerminalSessionManager.appendOutput()`。引用：`backend/src/index.ts:306`、`backend/src/terminal/tmux-output-watcher.ts:61`、`backend/src/terminal/tmux-output-watcher.ts:65`、`backend/src/terminal/tmux-output-watcher.ts:143`、`backend/src/terminal/tmux-output-watcher.ts:151`、`backend/src/terminal/tmux-output-watcher.ts:167`、`backend/src/terminal/tmux-service.ts:432`。
- 为什么它在系统层面可能是错的：系统已有 `ScrollbackBuffer` 对持久 scrollback 做字节上限裁剪，`appendOutput()` 也走这个有界缓冲；但 watcher 的中转 `.log` 文件只增长 offset，不做 truncate、rotate、清理或配额。长时间运行的高输出 tmux session 会在持久化目录下积累完整原始输出，相当于绕过已有容量控制，形成磁盘耗尽风险。
- 更好的候选方案：
  - 推荐：把 `pipe-pane` 接到受管理的流式消费者，而不是普通持久文件；例如启动受 backend 生命周期管理的 helper/pipe consumer，读到数据后立即进入 recorder，并在进程退出时关闭 pipe。交付复杂度中等，但容量边界清晰。
  - 可接受：保留文件中转，但实现消费后 truncate/rotate，并设置 per-session 和全局配额；需要处理 inode、并发写入和 offset 重置，复杂度高于直接流式消费。
  - 平台/工具链方案：如果只需要恢复 detached 期间输出，优先评估 tmux hook/control-mode 或按需 `capture-pane` 的增量方案，避免长期复制完整输出到第二份无界日志。
  - 不推荐：继续只依赖 polling offset。offset 是读取进度，不是容量控制。
- 迁移/过渡风险说明：修复时需要清理已生成的 `tmux-output/*.log`，并对仍在运行的 tmux session 重新安装 pipe；如果选择流式方案，需明确 backend 停止期间是否承诺继续采集 detached 输出。

### P2 - tmux pipe 生命周期没有被建模为受管资源，关闭/重启语义不清晰

- 当前决策：`watchSession()` 启动 `pipe-pane`，但 `unwatchSession()` 和 `dispose()` 只删除内存 map、关闭 polling timer，不调用 tmux 停止 pipe；服务关闭时也只 `dispose()` watcher。引用：`backend/src/terminal/tmux-output-watcher.ts:55`、`backend/src/terminal/tmux-output-watcher.ts:65`、`backend/src/terminal/tmux-output-watcher.ts:91`、`backend/src/terminal/tmux-output-watcher.ts:99`、`backend/src/index.ts:485`、`backend/src/terminal/tmux-service.ts:432`。删除 session/project 会 kill tmux session，但普通 backend shutdown 会保留 recoverable tmux session。
- 为什么它在系统层面可能是错的：output capture 实际上是一个跨 backend 进程和 tmux session 的外部资源。当前没有 owner 和终止协议，会导致 shutdown 后 tmux pane 仍可能保留旧 pipe/cat 进程；下一次启动又重新 `pipe-pane` 到同一路径并可能截断旧文件，既不可靠保留离线输出，也不明确释放外部资源。
- 更好的候选方案：
  - 推荐：为 watcher 增加明确的 `PipeRegistration` 生命周期，记录 target/filePath，`unwatch/dispose/session-delete/project-delete` 都能显式停止 tmux pipe；这样资源归属清楚，恢复行为可预测。
  - 可接受：如果产品要求 backend down 期间继续收集 tmux 输出，则把 spool 文件设计成 durable log：append-only、启动时先 drain 再重新 pipe，并持久化 checkpoint。成本更高，但语义自洽。
  - 不推荐：既不停止 pipe，也不把文件当 durable log 处理。它让恢复行为依赖 tmux 对重复 `pipe-pane` 的隐式行为和 shell 重定向副作用。
- 迁移/过渡风险说明：显式 stop pipe 可能改变 backend 停止期间的输出采集能力；需要先确认这是非目标，还是要升级为 durable offline capture。

## 代码 / 实现发现

### P2 - `watchSession()` 不幂等，重复 ensure runtime 会重新 pipe 并截断中转文件

- 为什么这是风险：`watchSession()` 没有检查 session 是否已经在 `watchedSessions` 中，直接执行 `pipePaneOutput()`，随后把 offset 重置为 0。`pipePaneOutput()` 使用 `cat > <file>`，重复调用会重新打开并截断同一个文件。`ensureTerminalRuntime()` 在 tmux runtime 缺失时都会调用 watcher；WebSocket reattach、HTTP input 触发 runtime 恢复、启动时 watch existing session 都可能走到这里。未被 polling 读走的窗口期输出会丢失，且重置 decoder/recorder 会让行为更难推理。
- 具体位置：`backend/src/terminal/tmux-output-watcher.ts:55`、`backend/src/terminal/tmux-output-watcher.ts:60`、`backend/src/terminal/tmux-output-watcher.ts:65`、`backend/src/terminal/tmux-output-watcher.ts:77`、`backend/src/terminal/tmux-service.ts:438`、`backend/src/terminal/runtime-launcher.ts:51`、`backend/src/terminal/runtime-launcher.ts:135`、`backend/src/routes/terminal.ts:516`、`backend/src/ws/terminal-server.ts:133`。
- 可执行修复方向：`watchSession()` 对同一 session/target 已存在 watcher 时应 no-op，除非显式 force recreate；如果必须重建 pipe，应先暂停旧 pipe、drain 文件、再切换，避免 `cat >` 截断未消费数据。相关测试要覆盖“重复 watch 不重复 pipe、不截断、不丢 offset”。

### P2 - 新增测试只覆盖 happy path，缺少容量、幂等和 dispose 行为

- 为什么这是风险：当前 `tmux-output-watcher.test.ts` 只验证文件里写入 `hello\n` 后会调用 `appendOutput()`，`tmux-service.test.ts` 只验证 pipe 命令参数。没有覆盖上述最危险的行为：重复 `watchSession()`、`dispose()` 是否停止外部 pipe、输出文件是否 truncate/rotate、session exit/delete 后是否 unwatch。类型检查和现有测试通过不能证明 watcher 在长期运行场景下安全。
- 具体位置：`backend/src/terminal/tmux-output-watcher.test.ts:17`、`backend/src/terminal/tmux-output-watcher.test.ts:51`、`backend/src/terminal/tmux-output-watcher.test.ts:54`、`backend/src/terminal/tmux-service.test.ts:519`。
- 可执行修复方向：补充单测覆盖：重复 watch 同一 session、poll 后文件容量处理、dispose/unwatch 的 tmux stop pipe 调用、session 变 exited 后 watcher 清理、pipe setup 失败不留下半注册状态。

## 已确认改善

- `app:dev` 当前默认不再启动 iOS live reload，只有 `APP_DEV_IOS=true` 或 `app:dev:ios` 才进入 iOS 链路。引用：`app-dev.mjs:17`、`package.json:16`、`package.json:17`。
- 移动概览接口已移除读时 tmux metadata 同步和 DB 写入，回到只读列表 + tail capture 模式。引用：`backend/src/routes/terminal-mobile-overview.ts:149`。
- App composer 从手绘符号切到 `IonIcon`/`ionicons`，方向上更符合已有 Ionic 工具链。引用：`app/src/components/TerminalCommandComposer.tsx:1`、`app/src/components/TerminalCommandComposer.tsx:67`、`app/src/components/TerminalCommandComposer.tsx:89`。

## 剩余风险 / 测试缺口

- 未做真实 tmux 集成测试；`pipe-pane` 的重复调用、shutdown 后 pipe 状态、重启后的文件行为仍需在真实 tmux 中验证。
- 未跑 Playwright E2E；App composer 图标替换只通过类型检查和代码阅读确认。
- 未验证长时间高输出 session 的磁盘增长曲线，这是当前最需要补的运维验证。
