# 2026-06-13 Voice Transcription Review

## 检查范围

- 当前分支：`feat/app-home-project-creation`
- Diff 范围：`HEAD` 到当前工作区，包含 staged 与 unstaged 修改
- 主要文件：
  - `app/src/components/TerminalCommandComposer.tsx`
  - `app/src/lib/voice-recorder.ts`
  - `app/src/pages/AppTerminalPage.tsx`
  - `app/src/services/voice.ts`
  - `backend/src/routes/voice.ts`
  - `backend/src/voice/transcription.ts`
  - `backend/src/voice/codex-app-server-client.ts`
  - `backend/src/index.ts`
  - `electron/src/main.ts`
  - `packages/shared/src/voice.ts`

## 验证摘要

- 已执行：`git status --short`
- 已执行：`git diff --stat`
- 已执行：`git diff --cached --stat`
- 已执行：`git diff --check -- . ':(exclude)docs/review'`，未发现 whitespace 错误
- 已执行：增量 `eslint --fix`，仅覆盖本次变更的 JS/TS/TSX 文件
- 已执行：`pnpm typecheck`
- 未执行浏览器验证：本次是 `review-only` 静态评审，且没有需要打开页面复现的步骤
- 未执行构建/测试：本次按只读评审约束聚焦代码与架构风险，没有修改或生成被评审对象

## 架构 / 策略发现

### P1 - 后端复用本机 Codex/ChatGPT 凭证调用私有转写接口，凭证边界和生命周期都不成立

**当前决策**

新增 `/api/voice/transcribe`，所有已登录 Runweave 客户端都可以调用；后端再启动 `codex app-server`，读取本机 Codex 的 ChatGPT token，并直接请求 `https://chatgpt.com/backend-api/transcribe`。

证据：

- `backend/src/index.ts:393` 将 `/api/voice` 挂在 `requireAuth` 后面，但没有更细的本机/设备/能力授权。
- `backend/src/voice/transcription.ts:7` 写死 ChatGPT backend-api 地址。
- `backend/src/voice/transcription.ts:118` 到 `backend/src/voice/transcription.ts:131` 手写 `Origin`、`Referer`、`User-Agent` 和 Bearer token 调用该接口。
- `backend/src/voice/transcription.ts:193` 到 `backend/src/voice/transcription.ts:227` 通过 `getAuthStatus({ includeToken: true, refreshToken: true })` 读取 Codex token。
- `backend/src/voice/codex-app-server-client.ts:60` 到 `backend/src/voice/codex-app-server-client.ts:68` 使用 experimental app-server 能力初始化。

**为什么这是风险**

系统层面把 Runweave 登录态、Codex 本机登录态、ChatGPT 网页后端接口混成一个信任域。只要拿到 Runweave access token 的客户端，就能消耗宿主机 Codex/ChatGPT 凭证做外部转写；同时该接口不是 Runweave 控制的稳定 API，字段、鉴权、风控、限流或 ToS 变化都会直接打断 App 功能。这个问题不是局部实现 bug，而是产品能力归属和凭证边界错误。

**更好的候选方案**

1. 推荐：后端接入显式配置的转写 provider，例如官方音频转写 API 或内部统一 AI 网关。凭证来自 Runweave 配置或用户显式授权，不从 Codex 本机会话中抽取。
2. 可选：App 端使用平台语音能力做本地转写，把文本提交给终端；后端不处理音频、不持有外部 AI 凭证。
3. 不推荐：继续包装 `chatgpt.com/backend-api`。交付快，但稳定性、合规性、审计和故障定位都不可控。

**迁移/过渡风险**

切到显式 provider 需要补配置、错误态和费用/限流策略；App 本地转写会带来 iOS/Android 能力差异。但这两类风险都比把宿主机 Codex 会话暴露成服务端转写凭证更可控。

**可执行修复方向**

先撤掉对 Codex token 和 ChatGPT backend-api 的依赖，把 provider 设计成显式配置的后端能力；在 API 层加入能力开关、限流、审计字段，并明确失败时 UI 如何降级。

### P2 - 语音 API 没有绑定 terminal/session，上线后无法按真实使用者和终端上下文审计或限流

**当前决策**

UI 只在 `AppTerminalPage` 中调用转写，但 shared request 和后端路由都是全局 `/api/voice/transcribe`，请求体只包含音频。

证据：

- `app/src/pages/AppTerminalPage.tsx:675` 到 `app/src/pages/AppTerminalPage.tsx:719` 只在前端 support log 里记录 `terminalSessionId`，没有发给后端。
- `app/src/services/voice.ts:13` 到 `app/src/services/voice.ts:23` POST 到全局 `/api/voice/transcribe`。
- `packages/shared/src/voice.ts:1` 到 `packages/shared/src/voice.ts:6` 请求协议没有 `terminalSessionId`、`projectId` 或调用来源。
- `backend/src/routes/voice.ts:22` 到 `backend/src/routes/voice.ts:36` 只解析音频并转写，不校验任何终端上下文。

**为什么这是风险**

语音入口目前是终端 composer 的辅助输入，但后端看不到“谁在哪个 terminal 上触发”。后续无法做按 terminal/session 的审计、频控、权限隔离，也无法把失败和 terminal 日志串起来。更严重的是，如果将来有其他客户端复用这个全局接口，会绕过 terminal 语义直接消耗转写资源。

**更好的候选方案**

1. 推荐：把接口收敛到 `/api/terminal/session/:id/voice/transcribe`，复用终端 session 校验，并在后端日志中记录 session/project 维度。
2. 可选：如果要做全局 voice service，就先定义独立的 capability、quota、审计模型，不要把 terminal-only UI 的能力暴露成无上下文全局 API。

**迁移/过渡风险**

接口路径和 shared DTO 会调整，App service 需要带上 `terminalSessionId`。迁移成本低，因为当前只有一个调用点。

**可执行修复方向**

将 voice route 纳入 terminal session 路由或在 request 中显式携带并校验 session；后端日志记录 session、调用来源、duration、provider status，不记录音频内容。

## 代码 / 实现发现

### P1 - 麦克风按钮在权限弹窗/启动期间可重复触发，可能泄漏多个录音流

**处理状态**

已在当前变更中处理：`TerminalCommandComposer` 新增 `starting` 状态和 `voiceStartInFlightRef` 启动锁，录音启动/权限弹窗期间会禁用麦克风按钮，并用 ref 阻止 React 重新渲染前的连续点击。

**为什么这是风险**

`handleVoiceClick` 只有 `idle | recording | transcribing`，点击后直到 `startVoiceRecording()` resolve 才进入 `recording`。用户在系统权限弹窗或启动等待期间连续点击，会并发执行多个 `getUserMedia`。后返回的 recording 会覆盖 `voiceRecordingRef.current`，先返回的 recording 对象可能丢失，里面的 `MediaStream`、`AudioContext` 和 `ScriptProcessorNode` 会继续运行且无法通过当前 ref 停止。

证据：

- `app/src/components/TerminalCommandComposer.tsx:99` 到 `app/src/components/TerminalCommandComposer.tsx:104` 只阻止 disabled 和 transcribing，不阻止 starting。
- `app/src/components/TerminalCommandComposer.tsx:136` 到 `app/src/components/TerminalCommandComposer.tsx:143` 等录音对象创建完成后才写入 ref 和设置 `recording`。
- `app/src/lib/voice-recorder.ts:20` 到 `app/src/lib/voice-recorder.ts:48` 每次启动都会创建新的 `MediaStream`、`AudioContext`、`ScriptProcessorNode`。
- `app/src/components/TerminalCommandComposer.tsx:168` 到 `app/src/components/TerminalCommandComposer.tsx:185` 卸载时只取消当前 ref 中的 recording。

**可执行修复方向**

增加 `starting` 状态或同步 mutex/ref，在第一次点击后立即禁用按钮；如果后续启动完成但状态已变化，必须 cancel 该 recording。也需要确保任何被覆盖的 recording 都会被显式 cancel。

### P2 - 后端相信客户端上报的 `durationMs`，没有从 WAV data 计算真实时长

**为什么这是风险**

后端限制 `MAX_DURATION_MS = 150_000`，但这个限制只检查客户端传来的 `durationMs`。请求者可以提交较长 WAV，同时把 `durationMs` 写成 1，后端仍会把音频转发给外部 provider。当前还有 10 MB 大小限制，但 24 kHz/16-bit/mono 下 10 MB 已经能超过 150 秒，足够造成费用、延迟和限流偏差。

证据：

- `backend/src/routes/voice.ts:12` 到 `backend/src/routes/voice.ts:17` 只要求 `durationMs` 是正数，没有 max，也没有和 WAV 内容关联。
- `backend/src/voice/transcription.ts:184` 到 `backend/src/voice/transcription.ts:190` 只检查 request.durationMs。
- `backend/src/voice/transcription.ts:258` 到 `backend/src/voice/transcription.ts:279` 校验 WAV 格式，但没有读取 data chunk 字节数计算真实时长。

**可执行修复方向**

在 `readWavInfo` 返回 `dataBytes`，用 `dataBytes / (sampleRate * channelCount * bytesPerSample)` 计算真实 duration，并以后端计算值执行上限校验；客户端 duration 只能作为观测字段，不能作为安全边界。

### P2 - Electron 退出路径修改和语音能力混在同一个变更中，回归归因边界不清

**为什么这是风险**

当前 diff 同时新增语音转写能力和修改 Electron `before-quit` 行为。`before-quit` 现在会 preventDefault，等待 CDP proxy 和 packaged backend stop 后再二次 `app.quit()`。这可能是合理修复，但它和语音功能没有直接因果关系；一旦出现“退出卡住 / 后端停止异常 / 自动更新退出异常”，很难从这次语音变更中定位。

证据：

- `electron/src/main.ts:712` 到 `electron/src/main.ts:732` 改变应用退出控制流。
- `electron/src/backend-runtime.ts:244` 到 `electron/src/backend-runtime.ts:260` packaged backend stop 有 5 秒兜底。
- `electron/src/terminal-browser-cdp-proxy.ts:260` 到 `electron/src/terminal-browser-cdp-proxy.ts:269` CDP proxy stop 依赖 `server.close` 回调。

**可执行修复方向**

将 Electron quit 行为拆成独立变更和独立验证；至少补充关闭流程验证说明，包括普通 quit、窗口关闭、自动更新触发 quit、backend 已退出、CDP proxy 有活动连接等场景。

## 剩余风险 / 测试缺口

- 没有看到新增 `voice` 后端路由、WAV 校验、Codex app-server client、App 录音状态机的自动化覆盖。
- 没有浏览器或真机验证麦克风权限、权限拒绝、重复点击、录音中切 tab/返回、转写超时、401/403/provider 失败等路径。
- 当前实现把错误展示复用到 `imageError`，短期可用，但长期会让图片上传和语音转写的 UI 状态耦合。
