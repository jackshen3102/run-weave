---
name: diagnostic-log-debugging
description: Use when 用户明确点名这个 skill，或明确要求通过日志、诊断日志、日志记录、logs、diagnostic logs、log recording 来诊断、复现、debug 或定位问题。不要用于普通调试、常规开发、代码评审或一般 bug 修复。
---

# 诊断日志调试

## 默认规则

默认不要启用或展示 AI 诊断日志。这个 skill 只能显式启用：

- 用户明确点名这个 skill 时，才使用。
- 用户明确要求通过日志或诊断日志记录来定位、诊断、复现问题时，才使用。
- 如果用户只是要求普通调试，但没有要求通过日志定位问题，不要使用这个 skill。

## 怎么记录日志

诊断日志不会自动收集普通 `console.log`、stdout、stderr、子进程输出、运行时错误或已有日志文件。只有显式调用 AI 诊断日志工具函数写入的内容，才会进入本轮诊断结果。

前端记录方式：

```ts
import { aiDiagnosticLog } from "../features/diagnostic-logs/recorder";

aiDiagnosticLog("viewer connection state changed", {
  sessionId,
  previousState,
  nextState,
});
```

后端记录方式：

```ts
import { aiDiagnosticLog } from "../diagnostic-logs/recorder";

aiDiagnosticLog("terminal session restore requested", {
  terminalSessionId,
  runtimeKind,
});
```

埋点原则：

- 只在可疑路径、关键状态流转、请求开始/完成/失败、分支判断处加少量日志。
- `message` 写稳定事件名；`details` 放结构化字段，例如 id、状态、计数、错误类型和必要错误信息。
- 不记录 token、cookie、authorization、密码、完整敏感 URL、本地文件内容或大段日志正文。
- 不要为了收集日志去包裹全局 `console.*`、`process.stdout`、`process.stderr`、子进程输出或错误监听。
- 工具函数始终会打印到控制台；只有处于“记录中”窗口时，才会额外写入诊断日志收集器。
- 如果结果里没有预期日志，先确认记录窗口已经开始、用户路径确实执行到了该代码、调用使用的是 `aiDiagnosticLog(...)` 而不是普通 `console.log(...)`。

## 工作流程

1. 确认触发条件有效。
   如果请求只是普通调试，没有要求基于日志诊断，不要使用这个 skill。

2. 添加聚焦的 AI 诊断日志。
   按“怎么记录日志”里的方式，在前端或后端可疑路径中调用 `aiDiagnosticLog(...)`。只添加能解释可疑用户路径或状态流转的日志。不要宽泛包裹 console 输出、stdout、stderr、子进程输出、运行时错误或本地文件内容。

3. 只在排查期间启用诊断入口。
   在浏览器控制台或当前可用的浏览器调试工具中执行：

   ```js
   window.runweaveDiagnosticLogs.enable();
   ```

   右下角工具栏默认隐藏。不需要记录日志时，不要让它保持可见。

4. 通过 UI 录制复现过程。
   点击右下角 `AI 诊断日志` 入口，点击 `开始记录`，执行能复现问题的用户操作，然后点击 `结束记录`。优先使用 UI 控件，不要优先使用裸 HTTP 调用，这样才能捕获浏览器侧日志。

5. 检查诊断结果。
   使用结果弹窗、下载日志，或 `GET /api/diagnostic-logs/result` 查看时间线。在改代码之前，先定位第一个异常状态、请求、响应或状态流转。

6. 最小化修复。
   用最小代码改动解决根因，并遵循项目已有模式。对 React `.tsx` 和 UI hooks，不要新增单测；使用诊断日志记录和聚焦的集成检查。对纯 `.ts` 逻辑，必要时新增或更新有针对性的测试。

7. 验证修复。
   再次复现同一路径，确认用户可见行为已经修复，并确认诊断结果中包含预期的前端和后端证据。

8. 完成后关闭诊断入口。
   在浏览器控制台或当前可用的浏览器调试工具中执行：

   ```js
   window.runweaveDiagnosticLogs.disable();
   ```

## Runweave 注意事项

- 开始新一轮记录会清空上一轮内存中的诊断结果。
- 不存在 `/api/diagnostic-logs/clear` 接口。不要新增，也不要调用。
- 如果结束记录失败，先检查浏览器 console 和 Network。连接被拒绝通常意味着 dev server 或后端没有运行。
- 面向用户的状态消息要足够具体，能说明失败来自后端、网络，还是日志记录状态问题。
