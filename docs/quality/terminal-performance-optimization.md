# 终端输入回显性能优化实验总结

## 背景

前端在打开多个终端、且终端历史输出和后台持续输出都很多时，用户输入内容的回显可能出现卡顿。这个问题的风险点不只在单个 active terminal 的渲染，也在 inactive terminal 是否仍然持续占用主线程、是否有高频日志干扰，以及性能基准本身是否真的测到了用户感知的输入回显。

本次实验的目标是用类似 Ralph / Autoresearch 的方式做优化：先建立可重复的基线，再在隔离分支里尝试候选方案，串行跑基准，对比数据后只保留有效方案。

## 实验方法

### 1. Worktree 隔离

每个候选方向都在独立 worktree / branch 中运行，避免候选代码互相污染，也避免在 `main` 上直接试错。最终保留的关键分支包括：

- `perf/terminal-event-timing`：终端性能基准修正与 inactive terminal renderer 优化。
- `fix-terminal-http-snapshot-race`：修复 active HTTP snapshot 覆盖 live WS 输出的竞态。

### 2. 串行执行基准与 E2E

Playwright / E2E / benchmark 使用固定端口和固定临时存储路径，不能并行运行。因此本次实验后续全部按串行执行：

- 单个 E2E 命令完成后，再启动下一个 E2E。
- 5 次性能基准由 runner 内部串行执行。
- 不在多个 worktree 同时跑 Playwright，避免端口和 `/tmp/browser-viewer-e2e-*.json` 冲突。

### 3. 先修正测量口径

最开始的 benchmark 用 accessibility / text polling 等待 marker 出现在终端文本里，看到的 p95 约为 1.9s。后续诊断证明这主要是 screen reader / accessibility 文本观测方式带来的测量噪声，不代表真实 paint 延迟。

最终改成在终端输出链路里记录三类 probe：

- `terminal.output.received`：前端收到 WS output 的时间。
- `terminal.output.rendered`：`terminal.write(...)` callback 返回的时间。
- `terminal.output.painted`：write callback 后经过两次 `requestAnimationFrame`，用于近似用户可见 paint 的时间。

后续所有优化都使用 `output.painted` 作为输入回显主指标，而不是 accessibility 文本轮询结果。

### 4. 红绿回归测试验证竞态

在 `fix-terminal-http-snapshot-race` 中，先写了一个 E2E 复现 active terminal 的竞态：

1. 拦截 `GET /api/terminal/session/:id`，让 HTTP snapshot 延迟返回旧 scrollback。
2. 先通过 WS 输入并渲染 live marker。
3. 再释放旧 HTTP snapshot。
4. 修复前，旧 HTTP snapshot 会 `terminal.reset()` 并覆盖 live marker。
5. 修复后，如果 HTTP 请求期间已经收到过 WS snapshot / output，则丢弃这个 HTTP snapshot。

这个测试先在旧代码上失败，再在修复后通过，用来证明修复覆盖了真实问题。

## 基准指标解释

### echo paint p95 中位数

含义：用户输入一段 marker 并按 Enter 后，到这段回显内容进入浏览器后续 paint 的延迟。

计算方式：单次 benchmark 会输入多次 marker，先取单次运行内的 p95；再跨 5 次运行取这些 p95 的中位数。

这个指标最接近用户感知的“输入回显是否卡顿”。例如 `33ms` 大约是 60Hz 屏幕两帧以内的延迟。

### output render duration p95 中位数

含义：前端调用 `terminal.write(...)` 到 xterm write callback 返回之间的耗时。

它衡量 xterm 写入、解析、排队这一段处理是否重，但不等同于最终可见 paint。这个数很低时，说明瓶颈不在 `terminal.write` 本身。

### open duration p50

含义：benchmark 打开 active terminal 页面并完成基准准备的中位耗时。

这里不只是普通空终端首屏时间，还包括测试为了模拟压力场景所做的准备，例如创建多终端、注入大量历史内容、进入 probe 状态。因此它适合用于同一基准下横向对比，不应直接解释为普通用户打开空终端的耗时。

### long task count 中位数

含义：benchmark 过程中浏览器主线程超过 50ms 的 long task 数量的中位数。

这个指标和输入卡顿相关，因为长任务会阻塞键盘事件处理、渲染和 paint。`0` 表示中位运行没有观察到超过 50ms 的主线程阻塞任务。

### frontend perf log count

含义：benchmark 中捕获到的 `[terminal-perf-fe]` 前端性能日志数量。

本次优化后，终端高频性能日志默认关闭，所以正常基准中该值应为 `0`。这个指标用于确认 benchmark 没有被 console logging 自身干扰。

## 基线

基线来自修正后的 paint-probe benchmark，而不是旧的 accessibility / text polling 结果。

配置：

- 8 个 terminal session。
- 每个 session 12,000 行 seed output。
- 30 次输入 probe。
- 5 次串行运行。

基线结果：

| 指标                              |      基线 |
| --------------------------------- | --------: |
| echo paint p95 中位数             |      36ms |
| output render duration p95 中位数 |     0.6ms |
| open duration p50                 | 2053.27ms |
| long task count 中位数            |         1 |
| frontend perf log count           |         0 |

## 保留的优化

### 1. 默认关闭高频终端性能日志

前后端原来存在大量 `[terminal-perf-fe]` / `[terminal-perf-be]` 高频日志。忙终端场景下，console logging 本身可能干扰主线程和 I/O。

优化后默认关闭，只在显式诊断时打开：

- 前端：`VITE_TERMINAL_PERF_LOGS=true` 或 localStorage `viewer.terminal.perfLogs=true`
- 后端：`TERMINAL_PERF_LOGS=true`

### 2. active terminal 保留完整 surface，inactive terminal 改为 headless watcher

优化前，`TerminalWorkspace` 会为每个 session 挂载一个完整 `TerminalSurface`。inactive terminal 虽然被移动到屏幕外，但仍然有完整 xterm 实例、renderer addon、WebSocket、输出写入和相关事件处理。

优化后：

- active terminal 才挂载完整 `TerminalSurface`。
- inactive terminal 使用轻量 `TerminalHeadlessConnection`。
- headless watcher 仍然保留 WS 连接，用于 activity、bell、metadata 通知。
- 切回 active 时通过 live scrollback 恢复画面。

这个方案减少了 inactive xterm renderer 对主线程的占用，同时保留后台活动提醒语义。

### 3. 丢弃过期 HTTP snapshot，避免覆盖 live WS 输出

在 active terminal 恢复画面时，HTTP snapshot 和 WS snapshot / output 可能并发返回。如果 HTTP snapshot 较晚返回且 scrollback 较旧，直接 `terminal.reset()` 会清掉已经通过 WS 渲染的 live output。

修复方式：

- 为 WS snapshot / output 增加内容版本号。
- HTTP snapshot 请求发出时记录当前版本。
- HTTP 返回时，如果期间 WS 内容版本已经变化，则丢弃该 HTTP snapshot。

这样可以避免旧 HTTP snapshot 覆盖 live WS 输出。

## 最终结果

最终修复后的分支：

- `fix-terminal-http-snapshot-race`
- 提交：`3262b3f fix: prevent stale terminal snapshot overwrite`

最终 5 次串行基准：

```bash
pnpm perf:terminal -- --candidate=snapshot-race-guard --iterations=5 --artifact-dir=artifacts/terminal-perf/snapshot-race-guard-5run
```

对比结果：

| 指标                              |      基线 |  最终结果 |     变化 |
| --------------------------------- | --------: | --------: | -------: |
| echo paint p95 中位数             |      36ms |      33ms |     -3ms |
| output render duration p95 中位数 |     0.6ms |     0.2ms |   -0.4ms |
| open duration p50                 | 2053.27ms | 2027.16ms | -26.11ms |
| long task count 中位数            |         1 |         0 |       -1 |
| frontend perf log count           |         0 |         0 |     持平 |

## 结论

这次实验最重要的收益不是把输入回显从秒级优化到毫秒级，而是先证明秒级 p95 是测量方式导致的假象，然后用更接近用户感知的 paint-probe 指标继续优化。

最终保留的方案带来三点实际收益：

- 输入回显 paint p95 保持在 30ms 级别，并从 36ms 降到 33ms。
- inactive terminal 不再持续创建和驱动完整 xterm renderer，主线程 long task 中位数从 1 降到 0。
- 修复了 active HTTP snapshot 和 live WS output 的竞态，避免旧 scrollback 覆盖新输出。

后续如果继续优化，应优先用同一套 paint-probe benchmark 验证真实用户感知延迟，而不是回到 accessibility / text polling 指标。
