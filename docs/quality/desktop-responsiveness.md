# 桌面整窗无响应取证

Electron 壳自动启动独立的诊断 Worker；不依赖 Web 页面里的“开始记录”。
需要更新桌面壳并重启后生效，只更新 Backend 或前端 runtime 不会安装此能力。
入口：[主线程与窗口监测](../../electron/src/desktop/responsiveness.ts)、
[独立取证 Worker](../../electron/src/desktop/responsiveness-worker.ts)。

## 故障发生时

1. 记下大致时间，以及其他应用是否也不能操作。条件允许时保留现场至少 10 秒，
   让自动取证完成；需要恢复工作时可以重启 Runweave。
2. 恢复后使用菜单 `File → Export Desktop Diagnostics`。诊断包中的
   `responsiveness/` 包含事件和 macOS 原生线程采样；重启不会主动清除这些文件。
3. 若菜单仍不可用，直接读取 `app.getPath("logs")/desktop-incidents/responsiveness/`。
   Stable 的实际目录以当前安装为准，常见为
   `~/Library/Logs/@runweave/electron/desktop-incidents/responsiveness/`。

## 如何区分原因

| 证据                                               | 可以支持的判断                                                                                         |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `main.stalled` / `main.recovered`                  | Worker 正常调度期间，主线程心跳连续至少 3 秒没有推进；结合 `sample-*.txt` 判断同步 I/O、计算或原生等待 |
| `renderer.unresponsive` / `renderer.probeTimeout`  | Electron 无响应事件或页面探针 5 秒未返回；必须对照主线程记录，探针超时本身不证明 renderer 是根因       |
| `window.state`、`window.focus` / `window.blur`     | 原生窗口焦点、enabled/focusable、子模态窗口、页面焦点、pointer-events、inert 和待显示遮挡层            |
| 原生输入计数和页面输入计数                         | 帮助区分输入是否到达窗口和页面；计数口径不同，不能要求数值相等，内嵌浏览器还有独立输入路径             |
| `observer.gap`、`system.suspend` / `system.resume` | 观察线程也停止调度或系统休眠；不会直接归因为应用主线程阻塞                                             |

可见窗口空闲时每 10 秒探查页面，状态不变时每 30 秒落一条状态记录；
输入后合并探查，最多每 2 秒一次，隐藏或最小化窗口停止页面探查。页面探针最多一个在途。
只记录布尔状态和次数，不记录输入内容、网页文本、地址、token 或 cookie。
原生采样包含进程及模块路径，不包含页面截图。日志仅保存在本机，不自动上传。

主线程和 Worker 的心跳检查各每秒一次。事件文件轮转为两份、每份最多 1 MiB。
macOS 栈采样间隔至少 5 分钟，每次启动后每小时最多 4 次；
每次采样 1 秒、间隔 20 毫秒，命令超时 10 秒，保留 5 份，每份完成后截断至 4 MiB。
写入队列最多 64 条，磁盘异常时丢弃并计数，避免反过来拖住 UI。
严重的全系统停顿、磁盘不可写、进程被直接终止仍可能导致证据不完整。

这些记录用于定位下一次故障；加入取证能力不等于已经修复历史整窗无响应问题。
