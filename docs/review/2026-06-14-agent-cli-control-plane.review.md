# Agent CLI 控制面变更评审

评审模式：`review-only` 强力模式
评审范围：当前工作区相对 `main@71f4225` 的未提交变更，包含未跟踪文件。
检查命令：`git status --short --untracked-files=all`、`git diff --stat`、`git diff --check -- . ':(exclude)docs/review'`、按文件阅读 diff 与相关现有实现。
说明：未运行会启动服务或可能产物写入的完整测试命令；本次只做只读审查并写入本报告。

## 架构 / 策略发现

### P1：terminal-events 被扩展成控制面同步通道，但只覆盖 create，导致外部 agent 删除/变更后 UI 状态必然漂移

- 当前决策：共享协议新增 `project_created`、`terminal_session_created` 两类事件，后端在项目/终端创建成功后写入 `/ws/terminal-events`，Web/App 只合并新增 project/session。
- 为什么它在系统层面可能是错的：本次 CLI 同时新增了 `rw terminal delete` 这种会改变后端状态的外部控制能力，但事件协议没有 `terminal_session_deleted`，后端 delete 路由也没有发布事件。结果是外部 agent 清理终端后，Web/App 已打开页面仍会保留一个已经不存在的 tab/card，直到刷新或其它全量加载发生。这个形态把 terminal-events 从“状态/通知事件流”变成了“不完整的读模型同步层”，后续 project update/delete、session exited/delete、reorder 都会重复出现同类问题。
- 证据：
  - `packages/shared/src/terminal-protocol.ts:333` 只定义 `project_created` / `terminal_session_created`，没有删除或变更事件。
  - `backend/src/routes/terminal-project-routes.ts:117` 发布 `project_created`。
  - `backend/src/routes/terminal.ts:491` 发布 `terminal_session_created`。
  - `backend/src/routes/terminal.ts:770` 的 `DELETE /session/:id` 只销毁 runtime/session，`backend/src/routes/terminal.ts:805` 直接返回 204，没有发布任何 terminal event。
  - `frontend/src/components/terminal/terminal-workspace.tsx:469` 与 `app/src/hooks/use-app-session.ts:333` 只消费 created 事件和 state 事件。
- 更好的候选方案：
  - 推荐方案：把 terminal-events 明确升级为 read-model invalidation/change 机制。新增 `terminal_session_deleted`、`project_deleted`、必要的 `project_changed/session_changed`，客户端在收到事件后要么精确 apply，要么按 project/session 维度 refetch 权威列表。
  - 可选简化方案：不要继续扩展 WebSocket CRUD 事件；CLI 外部变更后 Web/App 通过已有 overview/session list 的定时或重连 refetch 收敛，terminal-events 仍只负责 terminal state/completion/notification。
  - 不推荐方案：继续补单个 create 事件。这会让每个新增 CLI 能力都需要手写一份前端 merge 逻辑，且很难证明 UI 和后端最终一致。
- 迁移/过渡风险：新增事件类型需要 Web/App 同时兼容老连接和重复事件；如果选择 refetch，需要控制频率和离线时的失败处理。风险可控，但必须比当前 create-only 模型更明确。
- 修复方向：先明确 `/ws/terminal-events` 的职责。如果承担控制面同步，就补齐删除/变更事件与客户端移除逻辑，并补 E2E 覆盖 `rw terminal delete` 后 Web/App 消失；如果不承担，就在连接恢复或 CLI 外部变更场景做权威列表 refetch。

### P2：新增控制面事件仍依赖 500 条内存窗口，无法保证离线/长断线后的外部变更可恢复

- 当前决策：`TerminalEventService` 继续只保留最近 500 条内存事件，客户端用 `after` cursor 做 catchup；本次把项目/终端创建也放进同一条事件流。
- 为什么它在系统层面可能是错的：过去 terminal-events 主要是 transient 的状态/通知；现在它承载“外部 agent 创建后 UI 无刷新可见”的控制面契约。Web/App 离线或后台较久、agent 批量创建终端、completion/state 事件较多时，旧 cursor 之前的 create event 会被挤出窗口。客户端没有 gap 检测，也不会在 catchup 缺失时 refetch，所以 UI 会静默漏项目/漏 tab。
- 证据：
  - `backend/src/terminal/terminal-event-service.ts:4` 固定 `MAX_TERMINAL_EVENTS = 500`。
  - `backend/src/terminal/terminal-event-service.ts:31` 每次记录后只保留最后 500 条。
  - `backend/src/terminal/terminal-event-service.ts:50` 对旧 `afterId` 只过滤 `id > after`，无法告诉客户端 cursor 已早于保留窗口。
  - `frontend/src/features/terminal/use-terminal-events-connection.ts:141` 与 `app/src/hooks/use-app-terminal-events-connection.ts:187` 直接用 cursor/baseline 连接，没有 gap fallback。
- 更好的候选方案：
  - 推荐方案：为事件服务增加 gap 信号，例如 `listAfter()` 返回 `{ events, resetRequired }`；客户端遇到 reset 后全量 reload projects/sessions/overview，再恢复 cursor。
  - 可选平台化方案：如果这条流以后会承载跨设备控制面状态，改成持久 event log 或按 resource version 的变更订阅，而不是进程内数组。
  - 不推荐方案：单纯调大 500。它只能推迟问题，不能解决进程重启、长断线和高频事件挤压。
- 迁移/过渡风险：全量 refetch 会增加一次 HTTP 请求；持久化事件会增加存储和清理成本。当前阶段更适合 gap + refetch，而不是直接上复杂持久事件系统。
- 修复方向：至少让 catchup 能发现“cursor 已不可恢复”，并触发 Web/App 权威列表刷新；把这个场景纳入测试文档和 E2E。

## 代码 / 实现发现

### P1：`terminal create --inherit-from` 不继承父 session 的 project，且父 session 不存在时会静默落到默认项目/家目录

- 为什么这是风险：CLI 新增 `--inherit-from` 后允许不传 `--project-id` 和 `--cwd`，调用者会理解为“继承父终端上下文”。但后端默认解析只从父 session 取 `cwd`，`projectId` 仍取显式值或默认项目；如果父 session 不存在，`cwd` 也会回落到 project path/home。外部 agent 可能在错误 project 下创建终端，随后 Web/App 通过新增事件同步出错误归属，后续 handoff、preview、清理都可能指向错误项目。
- 具体文件 + 行号：
  - `packages/runweave-cli/src/commands/terminal.ts:73` 读取 `--inherit-from`。
  - `packages/runweave-cli/src/commands/terminal.ts:77` 在有 inherit 时把 `projectId` 改为可选。
  - `packages/runweave-cli/src/commands/terminal.ts:80` 在有 inherit 时把 `cwd` 改为可选。
  - `backend/src/routes/terminal-session-route-helpers.ts:53` 只读取 inherited session 的 `cwd`。
  - `backend/src/routes/terminal-session-route-helpers.ts:57` `projectId` 仍来自 payload 或默认 project。
  - `backend/src/routes/terminal-session-route-helpers.ts:71` 返回的 `projectId` 甚至不是上面解析出的默认 project，而是 `payload.projectId`。
  - `packages/runweave-cli/src/commands/terminal.test.ts:158` 只断言 CLI 序列化了 `inheritFromTerminalSessionId`，没有覆盖后端实际继承 project/cwd。
- 可执行的修复方向：在后端 resolve create defaults 时先解析父 session；如果传了 `inheritFromTerminalSessionId` 但找不到父 session，返回 404/400；如果找到了父 session，`projectId` 默认使用父 session 的 project，`cwd` 默认使用父 session cwd，显式 `--project-id/--cwd` 仍可覆盖。补 backend route 测试：非默认项目父 session、缺失父 session、显式覆盖 project/cwd。

### P2：`rw app overview` 绕过现有鉴权上下文，profile token 过期时不会自动 refresh

- 为什么这是风险：`rw project` 和 `rw terminal` 都通过 `resolveAuthContext()` 走统一 refresh 逻辑；新增 `rw app overview` 却通过 `resolveCliBaseUrl()` 直接取当前 token，并由 `AppHttpClient` 裸 `requestJson()`。当 profile 中 access token 过期但 refresh token 仍有效时，`project list` 可以自愈，`app overview` 会直接 401。对外部 agent 来说，这会让“应用概览发现”成为最不稳定的入口。
- 具体文件 + 行号：
  - `packages/runweave-cli/src/commands/app.ts:22` 使用 `resolveCliBaseUrl()`。
  - `packages/runweave-cli/src/client/app-http-client.ts:10` 直接调用 `requestJson()`。
  - `packages/runweave-cli/src/client/app-http-client.ts:14` 只把当前 access token 放入 header，没有 refresh。
  - `packages/runweave-cli/src/client/auth-context.ts:24` 到 `packages/runweave-cli/src/client/auth-context.ts:29` 是现有过期 token refresh 入口。
  - `packages/runweave-cli/src/client/auth-context.ts:85` 到 `packages/runweave-cli/src/client/auth-context.ts:103` 是请求 401 后自动 refresh 并重试的路径。
  - `docs/plans/2026-06-13-agent-cli-control-plane.md:158` 明确要求 app overview “保持现有 401 错误处理和自动 refresh 行为”。
- 可执行的修复方向：`rw app overview` 应使用 `resolveAuthContext()`；`AppHttpClient` 构造函数接收 `AuthContext` 并调用 `auth.requestJson()`，或抽出通用 authenticated client。保留 health 的 `resolveCliBaseUrl()` 特例，因为 health 明确允许未登录。补测试：profile access token 过期、refresh token 有效时，`app overview` 先 401 后 refresh 再成功。

### P3：测试文档没有覆盖“创建事件窗口丢失”和“外部删除 UI 收敛”，会让上面两个策略缺口继续漏检

- 为什么这是风险：`docs/testing/runweave-cli-control-plane-test-cases.md` 已经把 Web/App 无刷新新增列成目标契约，但删除测试只检查 CLI/list/show，WebSocket 测试只覆盖 create 和 state，不覆盖 delete 或 catchup gap。即使当前自动化全部通过，也不能证明新增控制面对真实 UI 一致。
- 具体文件 + 行号：
  - `docs/testing/runweave-cli-control-plane-test-cases.md:15` 声明 CLI 创建会经 terminal-events 推送到 Web/App。
  - `docs/testing/runweave-cli-control-plane-test-cases.md:165` 到 `docs/testing/runweave-cli-control-plane-test-cases.md:169` 删除测试只验证 CLI/backend 结果。
  - `docs/testing/runweave-cli-control-plane-test-cases.md:175` 到 `docs/testing/runweave-cli-control-plane-test-cases.md:184` WebSocket UI 同步测试只覆盖 create、catchup 不重复、active 不抢占、App 新增、state 合并。
- 可执行的修复方向：补测试用例但不一定马上实现自动化：`rw terminal delete` 后 Web tab/App row 移除或触发全量 refetch；事件窗口丢失时客户端进入 reload；父 session 继承非默认项目；app overview refresh token。涉及浏览器验证时继续使用 `$playwright-cli`。

## 残余风险 / 测试缺口

- 未实际运行 `pnpm --filter ... test/typecheck/build`；本报告基于静态 diff、相关源码阅读和 `git diff --check`。
- 未做浏览器验证；本次 review-only 没有打开页面。后续如验证 Web/App 行为，必须使用 `$playwright-cli`。
- 当前变更包含前端 E2E 和后端/CLI 单测，但缺少针对鉴权 refresh、inherit 后端行为、delete UI 同步、event retention gap 的覆盖。

## 建议优先级

1. 先修 `--inherit-from` 后端语义，因为它会直接创建错误归属的 session。
2. 修 `rw app overview` 的鉴权 refresh，避免 agent 入口不稳定。
3. 明确 terminal-events 的职责：要么补齐 CRUD/change/gap，要么改成 invalidation/refetch，不要停留在 create-only。
