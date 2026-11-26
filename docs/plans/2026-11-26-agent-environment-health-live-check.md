# Agent 环境体检与经验现场复验实施方案

> 状态：已实现；核心真实链路已验收，跨版本与专用 Toolkit 完整矩阵待补  
> 粒度：L3（跨运行时、鉴权与本机进程边界）  
> 配套验收计划：`docs/testing/experience/live-check.testplan.yaml`

## 使用场景与成功表现

用户在排查 Agent、Toolkit 或 Terminal Hook 问题时，可以先在现有“运行状态”入口看到当前节点的 Agent 工具链是否可信；打开知识收件箱中的受支持经验后，可以点击“现场复验”，由当前 Backend 在该经验所属的已登记仓库上执行一个产品内置、只读的检查，并返回本次真实进程或真实文件状态。

成功时应同时满足：

- 运行状态新增“Agent 工具链”能力域，明确显示 Toolkit 内容一致性和 Hook 会话归属；
- foreign tmux session 仍被 Hook 门禁拒绝，且拒绝原因可以在运行状态中看见；
- 经验详情只对静态注册了 Probe 的条目显示“现场复验”，请求方不能提交命令、路径、URL、环境变量或 Probe 名称；
- 现场复验只报告结果，不安装、不升级、不修复、不发送完成事件，也不自动把经验标记为已处理；
- 验收使用真实 macOS、真实 Backend/Desktop、真实 tmux/Hook/Codex 进程，不以单元测试、模拟器或测试夹具结果替代；Playwright 只作为附着真实 Desktop 的验收工具，不作为被产品检查的能力。

## 背景与产品判断

当前知识收件箱已经能展示经验正文、生成 Agent 引用和切换待处理状态，但无法回答“这条经验在我当前环境里现在是否成立”。Runtime Status 已提供 owner-reported、只读、脱敏的状态协议，却没有 Agent 工具链能力域。Hook 已经正确阻止 foreign tmux session 进入 completion、Activity、通知和监督链路，但这个拒绝只写 debug log，用户不可见。

保留下来的经验不应机械变成六个独立功能。MVP 把其中可持续复用、能在真实环境中安全检查的部分归并为三个产品能力：

1. **Agent 环境体检**：把 Toolkit 和 Hook 归属纳入 Runtime Status；
2. **Hook 归属诊断**：为已存在的拒绝门禁增加独立、脱敏的可见诊断；
3. **经验现场复验**：把少量经验映射到受信任的内置 Probe，而不是执行经验正文。

其余经验的处理方式：

- `macos-codesign-inline-requirement-argument` 作为安装器/打包链路内部可靠性事实，不提供单独按钮；
- `desktop-pr-build-dependency-path-filters` 保留为 CI 工程约束，不进入用户界面；
- `codex-skill-usage-audit-rollout-schema` 暂不做 Skill 使用收益统计，待有稳定的用户决策场景后另立方案。

## 目标

- 复用 Runtime Status 展示当前节点 Agent 工具链的只读健康事实；
- 在不放宽 Hook 归属门禁的前提下，让 foreign-session 拒绝可诊断；
- 让受支持经验可在其所属的真实仓库和真实节点上复验；
- 让 Probe 的选择、输入、运行时间、并发、结果和缓存都由服务端控制；
- 保持新旧 Desktop、Backend 和 Hook 的滚动兼容与可回滚性。

## 非目标

- 不执行经验正文、`actions`、`verification` 或 AI 生成的任何命令；
- 不提供任意 shell、任意路径、任意 URL、任意环境变量或用户自定义 Probe；
- 不自动安装、升级、修复、重启服务或修改配置；
- 不因复验通过或失败自动改变知识收件箱状态；
- 不改变 completion、TerminalState、Activity、通知、飞书或任务监督的现有门禁；
- 不在 MVP 中实现 Skill 使用分析、PR 影响预告、iOS UI 或 Windows 专属 Probe；
- 不新增单元测试或 TDD 资产，也不把模拟器/fixture 结果当作最终验收证据。

## 产品行为

### 1. Agent 环境体检

在现有运行状态抽屉新增 `agent-toolchain` 能力域，不新增独立设置页。Backend 作为当前节点 owner 报告以下稳定状态项：

| 状态项             | healthy                                                     | unhealthy                                               | 中性/受阻                                                             |
| ------------------ | ----------------------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------- |
| Toolkit 内容一致性 | 已安装版本、marketplace source 与缓存内容一致               | 同一版本的已发布内容和缓存内容不一致                    | 未安装为 `unconfigured`；无法读取为 `blocked`                         |
| Hook 会话归属      | 最近一次已接受的真实 Hook 归属证据晚于 foreign-session 拒绝 | 最近观察到经鉴权且归属于当前节点的 foreign-session 拒绝 | 尚未观察到可判定事件为 `checking`；旧 Hook 无诊断能力为 `unsupported` |

规则：

- 每项都使用稳定 `id`、观察时间和有限的 `validForMs`；不把每次轮询当作新故障；
- Toolkit 的被动检查最多每 60 秒执行一次，同节点并发读取复用同一个 Promise；Runtime Status 的普通轮询只读取最近快照；
- 只展示版本、来源类型、内容摘要是否一致、观察时间和 opaque 会话指纹；不展示 token、环境变量、home/cwd、完整路径、完整命令、Terminal 内容或 stack；
- “重新检查”仍只刷新 owner report，不触发安装、升级、修复或服务生命周期操作；
- 能力域异常按现有聚合规则只计一次，详情中保留各状态项的独立结果。

### 2. Hook 归属诊断

当 `runweave-hook-bridge.cjs` 发现实际 tmux session 与 `RUNWEAVE_TMUX_SESSION_NAME` 不同，继续在任何 completion/state/notification 逻辑之前返回。返回前仅做一次 best-effort 诊断上报：

1. 使用现有 `X-Runweave-Hook-Token`；
2. 请求新的 `/internal/terminal/hook-diagnostics`；
3. Backend 验证 token、Terminal session 存在、来源枚举和严格 body；
4. Backend 立即把 expected/actual session 转为本进程临时盐生成的 opaque 指纹，随后丢弃原值；
5. 诊断只进入内存中的 bounded snapshot，再投影为 Runtime Status 项。

正常归属不增加第二种 Hook 请求：现有 `/internal/terminal/agent-hook` 在完成 token、schema、Terminal session 与 pane/operation 身份校验后，只向 HookDiagnosticService 记录一次 `acceptedAttributionAt`。这项观察发生在业务状态写入之前且失败时 fail-open；它不改变 agent-hook 的响应、TerminalState 或 Activity 内容。Runtime Status 只有在看到这类已接受证据后才能显示 `healthy`，不能把“没有收到 foreign 事件”直接解释为健康。

约束：

- 上报失败或旧 Backend 返回 404 时，Hook 仍立即结束，不重试 completion，也不阻塞 Agent 退出；
- Endpoint 不调用 Terminal session store 写操作，不写 completion event，不发 Activity/通知，不触发监督；
- 同一 `terminalSessionId + source + reason + expected/actual 指纹` 在 60 秒内去重；
- 最多保留最近 100 个事件且最长 24 小时，Backend 重启即清空；
- Runtime Status 只显示“最近发生 Hook 会话归属不一致”、来源、次数、最近时间和 opaque 指纹，不显示原始 session 名；
- 最近 foreign 事件晚于 accepted evidence 时状态为 `unhealthy`；新的真实受管 Hook 通过既有身份校验后恢复为 `healthy`；尚无任一证据为 `checking`。MVP 不提供“忽略”或“清除”写操作。

### 3. 经验现场复验

知识收件箱详情按 Backend 装饰出的 `liveCheck` 决定是否显示按钮：

- `supported: true` 且条目、来源、仓库均可用：显示“现场复验”；
- `supported: false`、字段缺失或查看历史版本：不显示执行按钮，可显示“此经验暂无内置复验”；
- 点击后按钮进入“正在复验…”，完成后展示状态、摘要、观察时间、有限事实和有效期；
- `passed` 表示当前真实环境满足经验不变量；`failed` 表示检查已完成但事实不满足；`blocked` 表示权限、依赖、超时或仓库不可用导致无法判断；`unsupported` 表示服务端没有适用 Probe；
- 结果不会触发“已处理”。用户仍需根据结果显式点击现有状态按钮。

MVP 的静态映射如下：

| 经验 sourceId                                    | 内置 Probe                  | 真实证据                                                                   |
| ------------------------------------------------ | --------------------------- | -------------------------------------------------------------------------- |
| `skill-source-cache-content-verification`        | `toolkit-cache-consistency` | 当前节点真实 Codex CLI 的 plugin list、marketplace source 与缓存逐文件内容 |
| `runweave-hook-foreign-tmux-session-attribution` | `hook-session-attribution`  | Backend 收到的真实 Hook 诊断 bounded snapshot 与当前 Terminal session 身份 |

`playwright-cli-upgrade-entrypoint-version-boundary` 不再映射 Probe，也不进入 Runtime Status。它只描述一个低频、单工具版本入口问题，不满足通用产品能力的价值门槛；知识收件箱仍可展示该经验，但不提供现场复验按钮。

静态映射以 `repositoryId + source + sourceId` 为输入，只允许 `source === "experience"`。经验标题、正文、actions、verification 和 source revision 都不能选择或配置 Probe。

## 运行链路

```text
真实 Codex/tmux Hook ──受限诊断──> Backend Hook Diagnostics
                                         │
真实 Codex/Toolkit 文件 ──> Trusted Probe Registry
                                         │
                              Backend Runtime Status owner
                                         │
                          Web/Desktop 运行状态抽屉

知识收件箱详情 ── itemId + expectedContentVersion ──> Backend
                                                        │
                                    已登记仓库 + 静态 Probe 映射
                                                        │
                                   脱敏 InboxLiveCheckResult
```

## 协议与 API

### Shared DTO

在 `packages/shared/src/knowledge-inbox.ts` 增加可选字段，保留现有 `verification: string[]` 的文字语义，不复用该名称：

```ts
export type InboxLiveCheckState =
  | "passed"
  | "failed"
  | "blocked"
  | "unsupported";

export interface InboxLiveCheckFact {
  id: string;
  label: string;
  value: string;
}

export interface InboxLiveCheckResult {
  runId: string;
  state: InboxLiveCheckState;
  observedAt: number;
  summary: string;
  facts: InboxLiveCheckFact[];
  validForMs: number;
}

export interface InboxLiveCheckDescriptor {
  supported: boolean;
  mode: "read-only";
  capabilityId: "agent-toolchain";
  itemId: string;
  lastResult?: InboxLiveCheckResult;
}

export interface InboxLiveCheckRequest {
  expectedContentVersion: string;
}

export interface InboxItem extends InboxContent {
  // existing fields...
  liveCheck?: InboxLiveCheckDescriptor;
}
```

所有结果字段需执行长度和数量限制：`summary <= 240`，最多 12 个 fact，`label <= 80`，`value <= 240`。`runId` 使用 UUID。`lastResult` 只返回当前 Backend 进程中、同一 item/contentVersion 且未过期的结果；不写入知识收件箱数据库。

在 `packages/shared/src/monitoring/runtime-status.ts`：

- 向 `RUNTIME_STATUS_CAPABILITY_IDS` 增加 `agent-toolchain`；
- 保持 protocolVersion 为 1，因为新增能力域和 `InboxItem` 可选字段是加法兼容；
- 更新所有穷举的 capability label/domain 映射。

### 现场复验 API

新增：

```http
POST /api/knowledge-inbox/items/:itemId/live-check
Authorization: Bearer <existing token>
Content-Type: application/json

{"expectedContentVersion":"<64 hex>"}
```

服务端必须以 strict schema 拒绝额外字段。请求中不接受 `cwd`、文件路径、命令、参数、URL、环境变量、`probeId`、`repositoryId` 或 `sourceId`。

响应规则：

- `200`：返回 `InboxLiveCheckResult`，包括 `passed/failed/blocked/unsupported`；
- `400`：body 非法或包含额外字段；
- `401`：沿用知识收件箱 Bearer Token 鉴权失败；
- `404`：条目不存在或不在用户当前可见仓库范围；
- `409`：内容版本变化、来源失效或仓库登记已不可用；Probe 不启动；
- `503`：服务正在关闭或注册表自身不可用；环境检查失败应返回 `200 + blocked`，避免混淆协议不可用和被检环境不可用。

### Hook 诊断 API

新增内部请求：

```ts
interface HookAttributionDiagnostic {
  terminalSessionId: string;
  source: "claude" | "codex" | "trae" | "traecli" | "traex" | "pi" | "unknown";
  reason: "foreign_tmux_session";
  expectedSession: string;
  actualSession: string;
  observedAt: number;
}
```

`expectedSession` 与 `actualSession` 仅允许 1–128 个无控制字符的 tmux session token。Backend 还需用 `TerminalSessionManager` 核对 `terminalSessionId` 以及服务端已知的 `tmuxSessionName`；不匹配当前受管 session 的伪造请求返回 404/409，且不进入快照。成功返回 `202`，不返回 session 原值。

## Trusted Probe Registry

新增 `KnowledgeInboxLiveCheckService`，由 `KnowledgeInboxService` 在详情投影时查询 descriptor、在 POST 时执行。Registry 是代码内静态表，不读取 ExperienceRecord 中的可执行数据。

每个 Probe 必须遵守：

- 只接受服务端构造的 `{ repositoryId, repositoryRoot, itemId, contentVersion, signal }`；
- `repositoryRoot` 来自 `EvolutionRepositoryScopes.list()` 中与 repositoryId 重新校验成功的第一条可用路径；
- 使用 `spawn`/`execFile` 的固定可执行文件和固定参数，`shell: false`；
- 不继承与检查无关的 `RUNWEAVE_*`、`PLAYWRIGHT_*` 或凭据环境变量；
- 不联网安装、不调用 `pnpm dlx`/`npx`、不写文件、不修改 cache、不启动服务；
- 单次硬超时 15 秒，超时终止子进程并返回 `blocked`；
- 同一 `repositoryId + itemId + contentVersion + probeId` 单飞；并发调用复用同一 `runId` 与 Promise；
- 成功结果按 Probe 声明缓存 60 秒，失败/受阻最多缓存 15 秒；缓存仅在内存中；
- stdout/stderr 不直接进入响应或日志，只由 Probe 解析允许字段；异常 stack 不出边界。

固定 Probe 细节：

1. `toolkit-cache-consistency`
   - 运行真实 `codex plugin list --marketplace <固定 marketplace> --json`；
   - marketplace/plugin 名称来自产品内置常量，不来自请求；
   - 对 CLI 返回的 source 目录做 realpath 与允许根检查，再逐文件比较 source release 和 cache；
   - 只返回 installed version、source 类型、cache content 是否一致和缺失/差异文件数量，不返回绝对路径或文件内容。
2. `hook-session-attribution`
   - 不启动 shell；读取当前 Backend 的 HookDiagnosticService snapshot；
   - 以当前条目所属节点和受管 Terminal session 为边界，返回观察窗口内是否出现 foreign-session 事件；
   - 没有支持诊断的新 Hook 时为 `unsupported`，最近 foreign 证据较新时为 `failed`，最近 accepted attribution 较新时为 `passed`，尚无可判定事件时为 `blocked`；不得把“没收到事件”解释为通过。

## 文件范围与职责

### Phase 1：Agent 工具链 Runtime Status

- [x] `packages/shared/src/monitoring/runtime-status.ts`：增加 `agent-toolchain` capability。
- [x] `packages/shared/src/monitoring/service-management.ts`：补齐 capability 到配置域/管理快照的穷举映射。
- [x] `backend/src/agent-toolchain/service.ts`：由 Backend owner 执行 Toolkit 只读检查、TTL/single-flight、进程限制和脱敏投影。
- [x] `backend/src/runtime-status/provider.ts` 与 `service.ts`：注入 agent-toolchain 状态，不建立第二套状态协议。
- [x] `frontend/src/components/runtime-status-panel.tsx`、`runtime-status-notice.tsx`：增加“Agent 工具链”标签和现有抽屉展示。

Phase 1 完成标准：真实 Backend 返回 `agent-toolchain` 项；真实 Desktop/Web 抽屉能展示；结果中不存在路径、凭据、命令或终端内容；重复轮询不重复启动检查进程。

### Phase 2：Hook 归属诊断

- [x] `packages/agent-bridge/hooks/runweave-hook-diagnostics.cjs`：派生 sibling endpoint、执行一次短超时 best-effort POST，不复用 completion body。
- [x] `packages/agent-bridge/hooks/runweave-hook-bridge.cjs`：在 foreign-session 早退前调用诊断；保留早退位置和所有现有门禁。
- [x] `packages/agent-bridge/AGENTS.md` 所要求的生成资产：运行 `pnpm agents:build` 更新 Toolkit/Electron 分发副本，不手工维护第二份源码。
- [x] `backend/src/terminal/hook-diagnostics/service.ts`：严格校验后的去重、临时指纹、bounded snapshot 和状态恢复窗口。
- [x] `backend/src/routes/terminal/hook-diagnostics.ts`：Hook token 鉴权、strict schema、Terminal session 归属核对与 `202` 响应。
- [x] `backend/src/routes/terminal/state.ts`：现有 agent-hook 完成身份校验后记录 accepted attribution；诊断记录失败必须 fail-open，且不改变原响应与业务事件。
- [x] `backend/src/routes/registration/internal-terminal.ts`：在 `/api` 用户路由之前注册内部 Hook 路由，复用 `requireTunnelAuth`。
- [x] `backend/src/bootstrap/runtime-services.ts`、`runtime-services-contract.ts`：创建并清理 HookDiagnosticService，注入 Runtime Status 和路由依赖。

Phase 2 完成标准：在真实 tmux 中从受管会话触发 Hook 不产生诊断；从 foreign session 触发后只出现一条去重诊断，completion、TerminalState、Activity、桌面/飞书通知计数均不变化。

### Phase 3：知识收件箱现场复验

- [x] `packages/shared/src/knowledge-inbox.ts`：增加 `liveCheck` descriptor/request/result DTO。
- [x] `backend/src/knowledge-inbox/live-check.ts`：实现静态映射与 Probe registry；受限进程、超时、单飞、缓存和脱敏由 `AgentToolchainService` 统一承载。
- [x] `backend/src/knowledge-inbox/service.ts`：在当前版本详情/列表投影中装饰 `liveCheck`；历史版本不提供可执行 descriptor。
- [x] `backend/src/bootstrap/knowledge-inbox.ts`：注入 RepositoryScopes、HookDiagnosticService 与 Probe registry，并纳入 ResourceScope 清理。
- [x] `backend/src/routes/knowledge-inbox.ts`：增加 strict `POST /items/:itemId/live-check`，复用现有 Bearer 鉴权和 InboxError 映射。
- [x] `frontend/src/services/knowledge-inbox.ts`：增加 `runInboxLiveCheck`，body 只发送 expectedContentVersion。
- [x] `frontend/src/features/knowledge-inbox/inbox-detail.tsx`：增加按钮、运行态、结果区、请求中止、身份隔离和版本变化提示；稳定事件回调用 `useMemoizedFn`。

Phase 3 完成标准：两条受支持经验可以从真实详情页运行对应 Probe；额外输入被拒绝；旧结果不会显示到另一条经验；通过/失败/受阻都不改变 `processedAt/stateVersion`。

### Phase 4：文档、兼容与真实环境验收

- [x] `docs/architecture/runtime-status.md`：增加 agent-toolchain owner、事实白名单和过期语义。
- [x] `docs/architecture/terminal-completion-hooks.md`：记录诊断旁路和“零 completion 副作用”不变量。
- [x] `docs/testing/platform/runtime-status-providers.testplan.yaml`：增加 agent-toolchain owner、脱敏和轮询不重复启动检查的场景。
- [x] `docs/testing/runbooks/runtime-status-panel.testplan.yaml`：增加能力域展示和重新检查无修复副作用。
- [x] `docs/testing/experience/live-check.testplan.yaml`：已在真实 macOS/Beta/Desktop/Backend/tmux/Hook/Codex 上执行核心场景并保存证据；完整专用 Toolkit 和滚动版本矩阵见下方缺口。
- [x] 按仓库规则运行 acceptance；浏览器部分使用 `$toolkit:playwright-cli` 附着真实 Desktop renderer，Hook/CLI 部分使用真实 macOS 进程和 tmux。

## 安全与隐私边界

- **命令注入**：API 没有命令/参数/路径字段；Probe 由静态表选择，子进程必须 `shell: false`。
- **目录越界**：repositoryRoot 只能来自可用 repository registration，并在执行前重新计算 repository identity；请求不能指定 cwd。
- **凭据泄露**：Probe 使用最小环境；原始 stdout/stderr、错误 stack、Token 和环境变量不返回、不写业务日志。
- **内容驱动执行**：ExperienceRecord 只能决定展示文字，不能贡献 Probe ID 或执行输入。
- **Hook 伪造**：复用 Hook token，并以 TerminalSessionManager 的服务端事实核对受管 session；原始 tmux 名只在请求处理栈中短暂存在。
- **资源消耗**：15 秒硬超时、single-flight、短期缓存、Hook 去重和有界内存共同限制 CPU/进程/内存开销。
- **副作用**：Probe 只读；诊断路由与 completion/state/activity/notification 服务无引用关系。

高风险点是“把知识内容变成代码执行入口”和“诊断旁路意外进入完成通知主链”。实施 Review 时必须以模块依赖和真实事件计数证明这两个边界，而不能仅凭 UI 表现判断。

## 错误处理与用户文案

| 情况                  | API/状态         | 用户文案原则                                 |
| --------------------- | ---------------- | -------------------------------------------- |
| 内容版本已变化        | 409              | “经验内容已更新，请刷新后重新复验”           |
| 仓库已移除/不可用     | 409 或 `blocked` | 明确“所属仓库当前不可用”，不提示用户执行命令 |
| 固定运行时不存在      | `blocked`        | 说明缺少哪一类运行时，不展示搜索路径         |
| 真实检查不满足        | `failed`         | 展示 expected/actual 的安全版本或计数事实    |
| 超时                  | `blocked`        | “现场检查超过 15 秒，未得出结论”             |
| 服务端无映射          | `unsupported`    | “此经验暂无内置现场复验”                     |
| 网络或 Backend 不可用 | 请求失败         | 保留条目与上次结果，允许用户重试，不自动处理 |

## 兼容、迁移与回滚

- Shared 字段均为加法；`InboxItem.liveCheck` 可选，旧 Backend 下新 UI 隐藏按钮；旧 UI 忽略新字段。
- 新 Hook 调用旧 Backend 得到 404/网络失败后 fail-open 早退，既有完成门禁不变；旧 Hook 连接新 Backend 时仅缺少诊断，不影响主链。
- `agent-toolchain` 加入所有 capability 穷举映射；未知/旧来源按 `unsupported` 展示，不把协议缺失误报为 unhealthy。
- 不做数据库迁移：Hook 诊断、Probe 结果和 single-flight/cache 都只在内存中。
- 回滚顺序：先隐藏前端 live-check 按钮，再停用 Backend registry/路由，最后移除 Hook 诊断上报；任何阶段 completion 主链均保持原状。
- 若线上出现资源或隐私问题，可通过构建时常量先让所有 descriptor 返回 `supported: false`，无需修改经验状态或数据。

## 验证命令与预期

实现阶段先执行静态门禁：

```bash
pnpm --filter @runweave/shared typecheck
pnpm --filter @runweave/agent-bridge typecheck
pnpm --filter @runweave/backend typecheck
pnpm --filter @runweave/frontend typecheck
pnpm toolkit:verify-hooks
pnpm testplan:validate docs/testing/experience/live-check.testplan.yaml
pnpm docs:check
pnpm architecture:check
```

预期全部退出码为 0。静态命令只能证明类型、Hook 资产和文档契约，不构成产品行为验收。

最终行为验收必须执行 `docs/testing/experience/live-check.testplan.yaml`，并至少保留：

- 真实 macOS Desktop/Backend 版本与节点身份；
- 真实 Codex plugin list 和 tmux/Hook 的时间戳证据；
- Runtime Status 与知识收件箱真实页面截图；
- foreign-session 前后 completion、TerminalState、Activity、桌面/飞书通知均无新增的计数证据；
- 请求/响应中对路径、token、环境变量、完整命令、Terminal 内容和 stack 的泄漏检查。

任一关键场景只能由单测、模拟器、mock/fixture 或静态代码检查证明时，验收结论必须为“未完成”，不能标记通过。

## 真实验收结果（2026-11-26）

本轮在真实 macOS 上使用三个 Beta Dev Session、真实 Desktop/Backend、真实 Codex 和真实 tmux/Hook 执行。`dvs-ff37f2`（`pool-03`）覆盖健康状态、现场复验、API 安全边界和状态隔离；`dvs-11ad1d`（`pool-01`）覆盖无 Hook 证据时的 `blocked`；删除 Playwright 专项能力后，`dvs-d7be07`（`pool-03`）重新核对运行状态和普通经验详情。运行状态只剩 Toolkit 与 Hook，两处均不存在 Playwright 专项状态；通过真实 Experience API 发布 `playwright-cli-upgrade-entrypoint-version-boundary` 后，详情显示“此经验暂无内置现场复验。”且“现场复验”按钮计数为 0。页面通过仓库固定 Playwright CLI 附着 Desktop renderer 验收，但 Playwright 只承担 UI 自动化，不作为产品状态项或 Probe。未使用单元测试、模拟器、mock 或 fixture 作为行为结论。

| Case     | 结论     | 本轮真实证据                                                                                                                                                                                                                | 尚缺矩阵                                                                                              |
| -------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| LCHK-001 | 通过     | Backend 与 Desktop 均显示 `agent-toolchain`；Toolkit 与 Hook 状态项可见且没有 Playwright 专项版本检查；跨普通轮询时 Toolkit 的 `observedAt` 保持不变；完整响应未发现路径、凭据、命令、Terminal 内容或 stack。               | 无。                                                                                                  |
| LCHK-002 | 部分覆盖 | 真实 Codex Toolkit 检查了 260 个文件并检出当前安装已有的 9 个内容差异，结果为 `failed`；检查前后安装内容未被 Probe 修改。                                                                                                   | 未在专用账号完成“初始一致 `passed` → 人工改一个文件 → 恢复一致 `passed`”完整可恢复矩阵。              |
| LCHK-003 | 部分覆盖 | 真实受管 Hook 后状态为 healthy；真实 foreign tmux 后状态为 unhealthy，只显示 12 位 opaque 指纹；60 秒内重复触发聚合为 `count=2`；completion revision、TerminalState 与 Activity offset 不变；新的受管 Hook 可恢复 healthy。 | 未单独量化桌面通知、飞书通知与监督事件计数；页面未出现额外提示，但这不能替代计数证据。                |
| LCHK-004 | 通过     | 合法 body 返回 200；分别附加 `cwd/path/command/args/url/env/repositoryId/sourceId/probeId` 均返回 400；不存在 item 返回 404；错误/缺失 Token 返回 401；恶意 `command` marker 文件未创建。                                   | 无。                                                                                                  |
| LCHK-005 | 通过     | 真实页面持有旧 contentVersion 时，经正常发布新版本后复验返回 409 并提示刷新；刷新后新版本可运行；真实临时 Git 仓库移动后返回 409“内容已失效或所属仓库不可用”，未在失效路径启动 Probe。                                      | 无。                                                                                                  |
| LCHK-006 | 部分覆盖 | 缓存过期后同时发出两个真实 Toolkit 复验请求，两次均返回同一 runId `4dd6d3bc-f0f7-4338-816d-d30a917577f1`，证明同一检查单飞；页面按 item/contentVersion 隔离结果。                                                           | 未执行账号切换；未等待结果 TTL 再证明产生新 runId；跨条目未完成请求的 UI 竞态未单独留证。             |
| LCHK-007 | 通过     | 真实页面展示 Toolkit `failed` 和无 Hook 证据 `blocked`，受管 Hook 可产生 `passed`；三类响应只含白名单字段且未命中敏感 marker；复验不会改状态，显式点击“已处理”后只有目标条目 `stateVersion=1`。                             | 无。                                                                                                  |
| LCHK-008 | 未执行   | 代码和协议按加法兼容实现，但未把静态检查当作行为证据。                                                                                                                                                                      | 未准备上一稳定版 Hook、Backend、Frontend 的独立数据目录与滚动组合，因此新旧版本真实兼容矩阵尚未执行。 |

汇总：4 项通过，3 项部分覆盖，1 项未执行。产品核心链路已经在真实环境中成立，但跨版本滚动兼容和专用 Toolkit 可恢复矩阵仍是明确的剩余验收，不构成本轮阻塞，也不能宣称 8/8 required 全通过。Playwright 专项场景已随产品能力一起删除，不计入剩余矩阵。

截图证据：

- `artifacts/acceptance/dvs-ff37f2-live-check-failed.png`：Toolkit 现场复验 `failed`；
- `artifacts/acceptance/dvs-11ad1d-live-check-blocked.png`：无 Hook 证据时现场复验 `blocked`；
- `artifacts/acceptance/dvs-d7be07-agent-toolchain-without-playwright.png`：Agent 工具链只显示 Hook 与 Toolkit；
- `artifacts/acceptance/dvs-d7be07-playwright-experience-no-live-check.png`：Playwright 普通经验详情不显示“现场复验”按钮。

## 完成定义

- [x] 三项产品能力均按本方案进入同一个 `agent-toolchain` 心智模型，没有增加六个零散入口；
- [x] 所有可执行行为都来自静态 Trusted Probe Registry；
- [x] Hook foreign-session 门禁没有放宽，诊断与 completion 主链零耦合；
- [x] 现场复验不会自动修改知识收件箱状态；
- [ ] 新旧版本兼容路径和回滚路径已真实验证；LCHK-008 尚未执行真实滚动版本矩阵。
- [ ] 配套测试计划的所有 required case 在真机/真实进程上通过，并有可追溯证据；当前为 4 通过、3 部分覆盖、1 未执行。
- [x] 类型、lint、Hook 资产、测试计划格式、文档、架构与 patch whitespace 检查全部通过。
