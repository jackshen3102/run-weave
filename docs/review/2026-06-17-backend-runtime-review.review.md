# electron backend-runtime review

日期：2026-06-17

范围：`electron/src/backend-runtime.ts` 当前未提交改动；为确认接口影响，读取了 `electron/src/main.ts`、`electron/src/application-menu.ts`、`electron/src/desktop-incident-logger.ts`、`backend/src/server/profile-lock.ts`、`backend/src/utils/path.ts`。

评审强度：强力模式。原因是改动影响 Electron packaged backend 启动、profile lock 生命周期、进程终止和诊断日志，属于运行时行为和可运维性变更。

## 架构 / 策略发现

### P2: Electron 复制后端 profile lock 协议，长期会形成双主实现

当前决策：

- `electron/src/backend-runtime.ts:142` 重新实现 `expandHomePath`。
- `electron/src/backend-runtime.ts:162` 重新推导 packaged backend 的 profile 目录。
- `electron/src/backend-runtime.ts:175` 重新读取并解释 `backend.lock.json`。
- `electron/src/backend-runtime.ts:264` 在 Electron 侧根据 lock owner、PPID 和命令行判断是否杀掉 orphan backend。
- 后端真实锁协议定义在 `backend/src/server/profile-lock.ts:5`、`backend/src/server/profile-lock.ts:79`，profile 路径真实定义在 `backend/src/utils/path.ts:39`。

为什么这是系统层面的风险：

Electron 现在依赖后端内部锁文件名、默认 profile hash、owner 字段和 stale lock 行为。一旦后端调整 `resolveStoragePaths`、lock owner 格式、lock 文件名，或增加新的锁状态，Electron 侧的恢复逻辑不会自动跟着变化。结果可能是：误判没有锁、误杀旧 runtime、漏掉真正 orphan、或者在用户现场输出和后端实际行为不一致的诊断信息。这个问题不是局部代码风格，而是生命周期所有权不清晰：锁由后端创建和释放，但异常恢复由 Electron 私自解释。

更好的候选方案：

1. 推荐方案：让后端拥有 profile lock 恢复策略。Electron 只传入一个明确的 packaged 模式环境变量，例如允许后端在 `acquireBackendProfileLock` 内识别 `runtimeReleaseId`、PPID、命令行后回收 orphan。交付速度中等，需要改后端启动路径；复杂度更低，协议只有一个 owner；运维风险最低，因为错误信息、恢复和锁清理在同一层。
2. 过渡方案：把 lock 文件名、owner 解析、profile 目录解析抽成一个 backend-owned runtime helper，由 Electron 和后端共同调用。交付速度较快，但要避免放进 `packages/common`，因为这不是 Web/App 前端公共代码；也不应随意放进 `packages/shared`，除非保持纯 TS 合约且不引入 Electron/backend 运行时副作用。
3. 不推荐方案：继续在 Electron 内维护独立锁恢复逻辑。短期改动最少，但每次后端 lock 或 storage 变更都需要人工同步，现场故障会越来越难判断。

迁移/过渡风险：

把恢复移动到后端会影响启动失败时机和错误文本，需要保留现有 incident event 或错误摘要，确保 Electron 仍能展示可诊断信息。过渡期间可以先增加一个小的共享解析函数或 contract assertion，避免两个实现继续漂移。

## 代码 / 实现发现

### P2: `outputTail` 以原始字符串进入桌面诊断，字符串内容没有按敏感值脱敏

为什么这是风险：

`electron/src/backend-runtime.ts:566` 开始收集 backend stdout/stderr tail，并在启动失败事件里通过 `outputTail` 写入 incident details（`electron/src/backend-runtime.ts:592`）。相邻实现中，`DesktopIncidentLogger` 的脱敏主要按对象 key 匹配敏感字段（`electron/src/desktop-incident-logger.ts:54`、`electron/src/desktop-incident-logger.ts:73`）。但 `outputTail` 是字符串数组，key 只叫 `outputTail`，数组里的每条日志字符串不会按内容再次过滤。

这会导致 backend stdout/stderr 中若出现 `Authorization: Bearer ...`、`RUNWEAVE_HOOK_TOKEN=...`、URL query token、cookie 或其它明文 secret，导出的 `main.jsonl` / diagnostic package 会保留原文。诊断包通常会被用户分享给维护者，这是实际信息泄露风险。

具体位置：

- `electron/src/backend-runtime.ts:566`
- `electron/src/backend-runtime.ts:592`
- `electron/src/desktop-incident-logger.ts:54`
- `electron/src/desktop-incident-logger.ts:73`

可执行修复方向：

在写入 `outputTail` 前做字符串级脱敏，复用后端已有的 redaction 思路，至少覆盖 bearer token、query token、cookie、`KEY=value` 形式的 secret/token/password。更保守的做法是只记录最近 N 行的错误类型和首尾固定长度，并默认丢弃疑似敏感行。不要仅依赖对象 key 脱敏。

## 已核对但未列为问题

- 先前指出的 `process.kill` 与进程自然退出之间的 `ESRCH` 竞态，在当前工作区已通过 `killProcessIfLive` 处理。
- `recoverOrphanedPackagedBackendLock` 对非 orphan live owner 选择失败退出是合理的保守策略，避免杀掉仍由其它 Electron/后端持有的 profile。
- 本次未运行构建、类型检查或 Electron 打包验证；这是静态 review-only。

## 检查命令摘要

- `git status --short`
- `git diff -- electron/src/backend-runtime.ts`
- `nl -ba electron/src/backend-runtime.ts`
- `git diff -- electron/src/main.ts electron/src/application-menu.ts electron/src/desktop-incident-logger.ts`
- `nl -ba backend/src/server/profile-lock.ts`
- `nl -ba backend/src/utils/path.ts`
- `nl -ba electron/src/desktop-incident-logger.ts`
- `git diff --check -- electron/src/backend-runtime.ts electron/src/main.ts electron/src/application-menu.ts`
