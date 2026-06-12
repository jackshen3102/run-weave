# App Support Logs Review

评审日期：2026-06-12

评审范围：当前 worktree 中 App support logs 相关改动，包括 `app/src/features/support-logs/*`、App 页面入口、HTTP/WebSocket 记录点、Capacitor 依赖、相关计划/资产文件。

评审模式：强力模式。该变更跨 App UI、认证、HTTP、WebSocket、诊断日志、native 分享插件与文档资产，涉及隐私、导出和终端交互性能。

## 架构 / 策略发现

### P2: 当前支持日志系统绕开已有诊断日志架构，形成第二套隐私和生命周期模型

当前决策：新增 `SupportLogProvider` 在 App 启动后安装全局 recorder，并默认把 App 事件写入 IndexedDB / memory store，再由 App 内 sheet 导出 JSON。现有后端已经有 `/api/diagnostic-logs`，共享包也有 `DiagnosticLogRecord` / `DiagnosticLogResult` 契约。

为什么它在系统层面可能是错的：现有诊断日志文档明确要求显式 start/stop、记录中状态可见、前后端同一套语义、stop 时批量合并，并且“不应默认长期记录日志”。新实现默认长期采集 App 认证、网络、终端事件，且使用独立类型、独立脱敏、独立存储和独立导出路径。结果是 App 支持日志和后端诊断日志无法按同一个 recording window 合并，隐私策略也会漂移。

证据：

- `app/src/features/support-logs/SupportLogProvider.tsx:65` 安装全局 recorder，`app/src/features/support-logs/SupportLogProvider.tsx:70` 立即记录启动事件。
- `app/src/features/support-logs/support-log-recorder.ts:28` 暴露无 recording 状态的 `recordSupportLog`，`app/src/features/support-logs/support-log-recorder.ts:39` 直接异步追加到 store。
- `app/src/features/support-logs/support-log-store.ts:7` 到 `app/src/features/support-logs/support-log-store.ts:12` 定义 App 本地长期容量上限。
- `backend/src/index.ts:452` 到 `backend/src/index.ts:454` 已挂载 `/api/diagnostic-logs`。
- `packages/shared/src/diagnostic-logs.ts:1` 到 `packages/shared/src/diagnostic-logs.ts:29` 已定义共享诊断日志契约。
- `docs/quality/ai-diagnostic-logging.md:184` 到 `docs/quality/ai-diagnostic-logging.md:206` 描述前后端合并流程；`docs/quality/ai-diagnostic-logging.md:262` 到 `docs/quality/ai-diagnostic-logging.md:267` 要求显式生命周期。

更好的候选方案：

1. 推荐：复用现有 diagnostic-logs 作为底座，App 只实现移动端入口和前端 buffer，在用户显式开始记录后采集，结束时批量上报到 `/api/diagnostic-logs/stop` 与后端日志合并。交付速度中等，但共享契约、脱敏和生命周期一致，后续维护成本最低。
2. 可接受：如果产品确实需要离线、未登录也可导出的“支持包”，保留独立 App support logs，但把类型和脱敏能力下沉到 `packages/shared`，明确 always-on retention policy，并新增 native export 验收。交付更快，但仍要承担第二套诊断系统的运维成本。
3. 不推荐：继续在 App 内维护独立、默认开启、长期存储的诊断系统。它短期最快，但会持续增加隐私审计、导出兼容、前后端关联和事件命名治理成本。

迁移/过渡风险说明：如果已有 QA 流程依赖当前 App sheet 的离线导出，需要先保留入口文案和导出体验，再把内部日志来源切到共享 recorder 或共享 redactor；同时要定义登录前无法访问后端时的本地缓冲策略。

## 代码 / 实现发现

### P1: 导出前脱敏规则不足，错误字符串和堆栈里的敏感内容可能原样进入支持包

为什么这是风险：支持包是面向人工排障导出的 JSON。当前全局错误处理会记录 `error.message` 和前 6 行 `stack`，HTTP 和认证失败也会记录错误字符串；但 App redactor 只按字段名脱敏，或只在字符串本身可以被 `new URL(value)` 解析时移除查询参数。实际堆栈、错误消息、服务端 message 常见形式是多行文本或嵌入式 URL / header，例如 `Authorization: Bearer ...`、`...?ticket=...` 出现在一整段字符串中，这些不会被当前 App redactor 命中。

证据：

- `app/src/features/support-logs/SupportLogProvider.tsx:41` 到 `app/src/features/support-logs/SupportLogProvider.tsx:46` 把 `errorMessage` 和 `stack` 放入日志字段。
- `app/src/features/support-logs/SupportLogProvider.tsx:72` 到 `app/src/features/support-logs/SupportLogProvider.tsx:89` 注册全局 error / unhandledrejection 采集。
- `app/src/services/http.ts:75` 到 `app/src/services/http.ts:87` 记录 `errorMessage`。
- `app/src/features/support-logs/support-log-redaction.ts:31` 到 `app/src/features/support-logs/support-log-redaction.ts:67` 只处理整串 URL 或敏感 key，不扫描普通字符串中的 header、cookie、URL query token。
- 对比现有后端 redactor，`backend/src/diagnostic-logs/recorder.ts:70` 到 `backend/src/diagnostic-logs/recorder.ts:127` 已有字符串级 URL/header 脱敏能力。
- `app/src/features/support-logs/support-log-export.ts:54` 到 `app/src/features/support-logs/support-log-export.ts:68` 会把 redactor 结果直接放进导出包。

可执行修复方向：不要维护弱化版 App redactor。把现有诊断日志 redaction 提取到共享包并复用，至少要扫描每个 string 中的 Authorization、Cookie、敏感 query key 和嵌入式 URL；对全局错误默认只保留错误类型、短 hash、必要安全消息，stack 需要先经过字符串级脱敏再导出。

### P1: 新增 native 分享依赖没有同步到 iOS SPM 工程，真机“分享日志”主路径会不可用

为什么这是风险：UI 主操作是“分享日志”，native 平台下实现依赖 `@capacitor/filesystem` 和 `@capacitor/share`。当前只改了 JS package 和 lockfile，iOS SPM 仍然只注册了 `CapacitorKeyboard`。在 native App 里动态 import 可以成功，但 plugin 调用会因为原生端未注册而失败；catch 后回退到 `<a download>`，这在 iOS WebView 里通常不是可靠的文件导出/分享路径。

证据：

- `app/package.json:18` 到 `app/package.json:21` 新增 `@capacitor/filesystem` 和 `@capacitor/share`。
- `app/src/features/support-logs/support-log-export.ts:95` 到 `app/src/features/support-logs/support-log-export.ts:124` native 平台依赖这两个插件写 Cache 并调用 Share。
- `app/src/features/support-logs/support-log-export.ts:129` 到 `app/src/features/support-logs/support-log-export.ts:137` 失败后只回退到浏览器 download。
- `app/ios/App/CapApp-SPM/Package.swift:13` 到 `app/ios/App/CapApp-SPM/Package.swift:24` 仍只包含 `CapacitorKeyboard`，没有 Filesystem / Share 的 SPM dependency 和 product。
- `app/src/features/support-logs/SupportLogSheet.tsx:197` 到 `app/src/features/support-logs/SupportLogSheet.tsx:211` 把“分享日志”和“下载日志”作为用户可见主操作。

可执行修复方向：运行并提交 Capacitor iOS sync 产生的原生工程变更，确保 `Package.swift` / resolved 文件包含 Filesystem 和 Share；然后用真机或模拟器验证分享 sheet 能拿到实际 JSON 文件。若不想引入 native plugin，就移除 native share 分支，改成已验证可用的 Web Share/File fallback，并把 UI 文案改成真实能力。

### P2: 终端输入路径每次输入都写支持日志，会重新引入高频日志导致交互卡顿

为什么这是风险：`TerminalRenderer` 的 `onInput` 接到 `sendInput`，这是终端交互的热路径。当前每次发送、排队或丢弃输入都会 `recordSupportLog`，而 store 每次 append 后都会 `getAll()` 读全量 IndexedDB 再按容量 trim。忙终端和快速输入时，这会在主线程旁路制造大量 IndexedDB 事务、JSON stringify 和 Blob 估算，和项目之前“默认关闭高频终端性能日志”的方向冲突。

证据：

- `app/src/pages/AppTerminalPage.tsx:611` 到 `app/src/pages/AppTerminalPage.tsx:617` 把 `TerminalRenderer` 的 `onInput` 直接接到 `sendInput`。
- `app/src/hooks/use-app-terminal-connection.ts:390` 到 `app/src/hooks/use-app-terminal-connection.ts:423` 在 input sent / queued / dropped 上逐次记录日志。
- `app/src/features/support-logs/support-log-store.ts:147` 到 `app/src/features/support-logs/support-log-store.ts:150` 每次 add 后都调用 trim；`app/src/features/support-logs/support-log-store.ts:121` 到 `app/src/features/support-logs/support-log-store.ts:130` 的 trim 会读全量 records 并估算 JSON bytes。
- `docs/quality/terminal-performance-optimization.md:5` 已把高频日志列为输入回显卡顿风险；`docs/quality/terminal-performance-optimization.md:107` 到 `docs/quality/terminal-performance-optimization.md:114` 说明高频终端性能日志默认关闭，只在显式诊断时开启。

可执行修复方向：终端 input 热路径不要逐事件写持久日志。改为聚合计数、采样或只在显式诊断窗口打开时记录；IndexedDB trim 不应每 append 读全库，可以按计数阈值、时间窗口或 export 前执行。

### P2: `docs/plans/2026-06-11-app-support-logs.md` 看起来是导出的日志样本，不是计划文档

为什么这是风险：该文件位于 `docs/plans` 且扩展名为 `.md`，但内容是完整 JSON 日志 bundle，包含本机 route、API host、userAgent 和认证失败事件。若随功能一起提交，会污染计划目录，也会把本地诊断样本当作文档资产长期留存。

证据：

- `docs/plans/2026-06-11-app-support-logs.md:1` 到 `docs/plans/2026-06-11-app-support-logs.md:12` 是 JSON bundle，而不是 Markdown 计划。
- `docs/plans/2026-06-11-app-support-logs.md:21` 到 `docs/plans/2026-06-11-app-support-logs.md:24` 包含本地 route、host 和 userAgent。
- `docs/plans/2026-06-11-app-support-logs.md:43` 到 `docs/plans/2026-06-11-app-support-logs.md:53` 包含认证失败事件。

可执行修复方向：如果需要保留设计说明，改成真正的 Markdown plan；如果只是手工导出样本，不要纳入提交。需要样本时使用脱敏 fixture，并放到明确的测试/示例目录。

## 验证摘要

- `git status --short --branch`
- `git diff --stat`
- `git diff --check -- . ':(exclude)docs/review'`，无输出
- `pnpm --filter @runweave/app typecheck`，通过
- `pnpm --filter @runweave/app build`，通过；Vite 仍有大 chunk 警告

未执行浏览器验证：本轮是 review-only 静态评审，没有打开页面复现。若后续验收“分享日志”或 sheet 交互，必须按仓库约束使用 `$playwright-cli`，native 分享还需要 iOS 模拟器/真机验证。

## 残余风险 / 测试缺口

- 未跑 iOS native sync / Xcode 构建，native plugin 注册问题来自当前工程文件静态证据。
- 未实际导出支持日志文件检查脱敏结果；当前 P1 基于代码路径和现有 redactor 能力差异。
- 未验证 IndexedDB 热路径性能；P2 基于 `TerminalRenderer onInput` 热路径和每 append 全量 trim 的复杂度判断。
