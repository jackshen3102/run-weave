# Agent Team completion 丢失恢复测试案例

## 范围

验证 Agent Team worker 已写入 pane-scoped outbox 后，在 completion 重复、backend 重启、App Server 不可用或直连请求失败的情况下，run 能继续推进且不会重复执行副作用。

不覆盖 worker 业务实现质量、Beta 功能本身、Agent Team UI 样式和一小时超时数值调整。

## 前提事实

- worker 结果写入 `.runweave/outbox/<sessionId>.panel-<panelId>.json`。
- run 真相位于 `.runweave/agent-team/<runId>.json`。
- 正常 Stop 会同时尝试 App Server `agent.completion` 和 backend `/internal/terminal-completion`。
- Agent Team 串行顺序为 `code -> code_review -> behavior_verify`；review/verify fail 应立即回弹 code。
- browser 页面验收必须使用 `$toolkit:playwright-cli`；CLI、日志和 JSON 只能作为辅助证据。

## 环境与证据

使用隔离项目和可独立重启的开发 backend，避免修改其它正在运行的 Agent Team run。每条用例记录：

- `projectId`、`terminalSessionId`、`runId` 和三个 worker panelId/tmuxPaneId；
- 执行前后的 run JSON；
- 对应 pane-scoped outbox；
- hook bridge、App Server event、backend 日志时间线；
- `$toolkit:playwright-cli` 读取到的 Agent Team sidecar 状态和截图。

## 必跑命令

按顺序执行，任一失败即停：

```bash
pnpm --filter @runweave/shared typecheck
pnpm --filter @runweave/backend typecheck
pnpm lint
git diff --check
```

以上仅是前置门禁，不能作为下列行为用例的通过证据。

## 用例

### ATCR-001 双通道 completion 同时成功时只推进一次

前置条件：backend 与 App Server 均健康；run 正在等待 `code_review`；review outbox 尚不存在。

操作：让 review worker 写入 `case_12=fail` outbox 并正常结束；保留 App Server 和 `/internal/terminal-completion` 两条上报；用 `$toolkit:playwright-cli` 观察 sidecar，保存 run/outbox/日志。

预期：run 只记录一次 `case_12` fail，只向 code pane 回弹一次；`loop.round`、`noProgressCount` 不因重复 signal 多增长；active role 变为 `code`。

失败判断：同一结果产生两条修复 prompt、重复 round、重复 fail 计数，或仍停在 `code_review`。

### ATCR-002 review 完成时 backend 重启后由 App Server 重放恢复

前置条件：run 正在等待 `code_review`；App Server 健康；可独立停止和启动 backend。

操作：review 写完 fail outbox 后、Stop 上报前停止 backend；确认 hook 日志中 App Server post 成功且直连 completion 失败；重新启动 backend；用 `$toolkit:playwright-cli` 观察 sidecar。

预期：backend 恢复后 10 秒内读取已有 review outbox，`case_12` 变为 fail并回弹 code；无需再次操作 review pane。

失败判断：只恢复 terminal idle、run JSON 不更新、等待一小时后才重试，或 behavior_verify 被错误启动。

### ATCR-003 初始 code 完成窗口丢失 completion 后自动启动 review

前置条件：run 的 active role 为 `code`；code outbox 尚不存在。

操作：code worker 写入 completed outbox时停止 backend，并让直连 completion 失败；随后恢复 backend；使用 `$toolkit:playwright-cli` 观察 worker 状态。

预期：恢复扫描识别精确 runId/role/panel 的 code outbox，只启动一次 `code_review`，run 记录对应日志并冻结 code。

失败判断：run 永久停在 code、创建多个 review prompt，或直接跳过 review 启动 behavior_verify。

### ATCR-004 behavior_verify completion 丢失后仍按结果完成或回弹

前置条件：准备两个相互独立的 run，active role 均为 `behavior_verify`；一个 outbox 全部 pass，另一个包含 fail。

操作：分别在 worker Stop 前停止 backend，写入对应 outbox并恢复 backend；用 `$toolkit:playwright-cli` 观察两个 run。

预期：pass run 进入 `done`；fail run 只回弹一次 code；两个 run 的 session/panel/outbox 不串扰。

失败判断：pass run 仍 running、fail run 被标 done、两个 run 相互消费 outbox或重复派发。

### ATCR-005 App Server 与直连 completion 都失败时由 outbox 扫描恢复

前置条件：run 正在等待 review；临时停止 backend 和 App Server；review pane 和项目文件系统仍可写。

操作：写入合法 fail outbox并结束 worker，确认两条网络上报均未成功；只恢复 backend，不人工重发 completion；用 `$toolkit:playwright-cli` 观察 sidecar。

预期：backend 启动扫描或 10 秒周期扫描消费 outbox并回弹 code；恢复不依赖 App Server 历史事件。

失败判断：run 保持 pending、必须手工再发 Stop，或恢复错误 worker。

### ATCR-006 baseline 为 null 时首次 outbox 被识别为新结果

前置条件：派发 review 时目标 outbox 不存在，run 中 `recheckOutboxMtimeMs=null` 且有有效 `recheckRequestedAt`。

操作：在 requestedAt 之后创建合法 review outbox，不发送 completion；等待一次周期扫描并用 `$toolkit:playwright-cli` 观察 sidecar。

预期：outbox mtime 晚于 requestedAt 即被消费，run 进入对应 fail/pass 后续状态。

失败判断：扫描因 baseline 为 null 永久跳过文件，或把 requestedAt 之前的文件当作新结果。

### ATCR-007 stale 或错身份 outbox 不得推进当前 run

前置条件：当前 run 正在等待 review；分别准备 runId 错误、role 错误、panelId 错误、sessionId 错误四个 outbox变体。

操作：每次只放入一个错误变体，触发 App Server signal并等待周期扫描；读取 run 和结构化日志。

预期：四个变体均不改变 acceptance、active role、loop 计数或 worker prompt；日志给出明确 stale reason且不包含敏感信息。

失败判断：任一错误文件推进 run、回弹 code或启动 behavior_verify。

### ATCR-008 正常直连但 App Server 不可用时保持兼容

前置条件：backend 健康，App Server 停止；run 正在等待 review。

操作：worker 写入 pass outbox并正常 Stop；确认直连 `/internal/terminal-completion` 成功；用 `$toolkit:playwright-cli` 观察 sidecar。

预期：review pass 后只启动一次 behavior_verify；App Server 不可用不阻断现有实时路径。

失败判断：系统强依赖 App Server、run 不推进或重复派发 verifier。

### ATCR-009 重复重放同一 App Server completion 保持幂等

前置条件：同一 review outbox 已成功消费并使 active role 离开 `code_review`；保留原 App Server event。

操作：通过隔离 event fixture 或重连消费方式再次投递同一 completion signal；读取 code pane、run JSON和日志。

预期：第二次 signal 被识别为 duplicate/stale，不修改 acceptance、round、noProgress 或 active role，也不再次发送 prompt。

失败判断：任何状态或 pane 输入发生第二次变化。

### ATCR-010 真正没有 outbox 时保留超时重试和升级语义

前置条件：隔离 run 正在等待 review，目标 outbox 始终不存在；把隔离 run 的 `recheckRequestedAt` 设置为超过一小时的过去时间，不修改生产 run。

操作：等待 watchdog 扫描；第一次检查重试派发；再次构造超过一小时且达到最大 attempt 的状态并扫描；用 `$toolkit:playwright-cli` 观察 sidecar。

预期：有结果时走即时 reconciliation；无结果时才进入原有 retry，达到上限后进入 `need_human`，证据明确是 outbox 缺失而非有效结果被忽略。

失败判断：未超时就重试、存在合法 outbox仍判超时、或达到上限后 run 继续无限等待。

## 覆盖说明

- 主路径：ATCR-001、ATCR-008。
- backend/App Server 依赖不可用：ATCR-002、ATCR-005。
- 状态迁移：ATCR-003、ATCR-004、ATCR-010。
- 并发与隔离：ATCR-004、ATCR-007。
- 幂等与重复事件：ATCR-001、ATCR-009。
- null/迟到结果边界：ATCR-006。
- 兼容回归：ATCR-008、ATCR-010。
- 鉴权和通用 payload 非法输入不覆盖：本改动不改变外部 HTTP 鉴权或请求 schema，继续由现有 hook 路由验证负责。
- UI 视觉样式不覆盖：本改动没有 UI 设计变化，只用 sidecar 状态作为行为证据。

## 验收通过标准

- ATCR-001 至 ATCR-010 全部通过并保留指定证据。
- 任一 worker 在 completion 丢失后，backend 恢复 10 秒内推进。
- 同一 outbox 无论收到多少 signal 都只产生一次状态迁移和一次后续 prompt。
- 错 run、错 session、错 pane、错 role 的 outbox 均不能被消费。
- 真正无结果的 worker 仍保持一小时超时、两次重试后升级人工的既有规则。

## 2026-07-11 本次实施验证记录

使用 `/tmp/runweave-atcr-*` 隔离 profile、独立 backend（5799）、独立 App Server（5899）和独立 frontend（5199），未改动现存 Agent Team run。

- 启动恢复 + null baseline：backend 启动前已存在合法 `behavior_verify` outbox，`recheckOutboxMtimeMs=null`；启动扫描以 `source=startup` 消费一次，run 从 running/round 1 进入 done/round 2，等待超过一个 10 秒 tick 后未重复推进。覆盖 ATCR-004 pass 分支、ATCR-005、ATCR-006。
- stale runId：当前 run 等待 `code_review`，pane outbox 使用错误 runId；启动扫描记录 `reason=outbox_run_id_mismatch`，run 保持 running、round 1、pending，Playwright sidecar 显示 `code_review` 和 `0✓`。覆盖 ATCR-007 的 runId 变体。
- App Server completion：合法 `agent.completion`（`completionReason=hook_stop`、`rawHookEvent=Stop`）在 outbox 落盘后进入 consumer；日志同毫秒记录 `source=app_server`、`reconciled=true`，run 进入 done。覆盖 ATCR-002 的重放接线核心路径。
- 重复 completion：run done 后再次投递同 pane completion，日志记录 `reconciled=false`；run 仍为 round 2，log 数量未变化。覆盖 ATCR-009。
- `$toolkit:playwright-cli`：真实页面 sidecar 显示“已完成”、`round 2`、`2✓`，并展示 App Server 证据 `agent.completion woke unified reconciliation`。
- 静态门禁：`pnpm typecheck`、`pnpm lint`、`git diff --check` 全部通过。

本次未逐条执行 ATCR-001、ATCR-003、ATCR-004 fail 分支、ATCR-007 的 session/pane/role 三个变体、ATCR-008、ATCR-010；这些用例涉及真实 worker prompt、网络故障窗口或一小时重试构造，保留为完整回归集，不能标记为已通过。
