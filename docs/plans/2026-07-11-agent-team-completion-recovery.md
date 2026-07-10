# Agent Team completion 丢失恢复实施计划

> 状态：已实施并完成核心恢复链路验证。配套验收用例：`docs/testing/agent-team-completion-recovery-test-cases.md`。

## 背景与问题

Agent Team 当前把 worker outbox 作为结果内容，但只有收到进程内 `TerminalEventService` 的 `completion` 事件时才读取该文件并推进 run。hook 同时向 backend 和 App Server 上报 completion；当 backend 正在重启时，直连 `/internal/terminal-completion` 会失败，App Server 虽能持久化并在 backend 恢复后重放事件，但当前重放处理只恢复 terminal idle 状态，不会唤醒 Agent Team。

本次现场中，`code_review` outbox 已正确落盘且 `case_12=fail`，但 backend 恰好在 Stop 上报时不可用。重启后的 run 仍停在 `activeWorkerRole=code_review`，说明结果文件存在，推进信号丢失。

## 目标

1. worker 结果已经落盘后，backend 短暂重启、直连 completion 丢失或 App Server 重放，都不能让 Agent Team 永久停住。
2. 正常情况下直连 completion 与 App Server completion 都到达时，同一 outbox 只能推进一次，不重复回弹、不重复启动下一个 worker、不重复累计 no-progress。
3. 初始 `code`、`code_review`、`behavior_verify` 三个串行阶段都具备同一套恢复语义。
4. 复用现有 outbox、run queue、`applyRound`、serial gate 和 watchdog，不引入第二套 loop 状态机。

## 非目标

- 不修改 worker 的业务职责、三类 worker 顺序或验收判定规则。
- 不把 App Server 改造成 Agent Team run 的存储源；run JSON 和 pane-scoped outbox 仍在项目目录。
- 不修改一小时复验超时和两次重试上限；本次只把“已有结果的恢复”从超时逻辑中分离出来。
- 不新增单元测试文件，不改前端 UI，不修改 Beta 自托管实现。

## 核心设计

### 1. 明确真相源

- pane-scoped outbox 是 worker 结果的持久化真相。
- terminal completion、App Server completion、backend startup 和 watchdog 都只是“检查 outbox”的唤醒信号。
- 任一信号到达时都进入同一个 reconciliation 方法，禁止各入口分别实现推进规则。

建议在 `AgentTeamService` 增加统一入口：

```ts
interface AgentTeamCompletionSignal {
  projectId: string;
  terminalSessionId: string;
  panelId?: string | null;
  tmuxPaneId?: string | null;
  cwd?: string | null;
  outboxPath?: string | null;
  source: "terminal_event" | "app_server" | "startup" | "watchdog";
}

reconcileCompletionSignal(signal: AgentTeamCompletionSignal): Promise<void>
```

该方法只负责定位当前 run/worker/outbox；实际结果折叠、失败回弹和串行 worker 派发继续调用现有 `resolveOutboxRound`、`applyRound`、`bounceFailuresToCode` 和 `dispatchSerialWorker`。

### 2. 严格匹配当前 worker

自动恢复时必须同时满足：

- run 为 `phase=executing`、`status=running`；
- outbox 的 `runId`、`sessionId` 与当前 run 完全一致；
- outbox 的 `role` 等于 `activeWorkerRole`；
- `panelId` 或 `tmuxPaneId` 与当前 active worker 一致；
- outbox 为合法 `completed|failed`，且能解析出当前 run 的 acceptance 结果，或满足现有 `code` 串行派发条件。

恢复扫描不接受缺少 `runId` 的 legacy outbox，避免旧文件推进新 run；现有实时 completion 路径可以保留兼容读取，但也必须经过 active role 检查。

### 3. 在 run queue 内完成幂等判断

所有 signal 先按 `runId` 进入现有 `enqueue`，进入队列后重新读取最新 run，再检查 active role 和 pending gate：

- 第一个 signal 成功处理 `code` 后，active role 变为 `code_review`，后续重复 code signal 自动失效。
- review fail 处理后 active role 变为 `code`，重复 review signal自动失效。
- review pass 后 active role 变为 `behavior_verify`，重复 review signal自动失效。
- behavior pass 后 run 变为 `done`，重复 signal 自动失效。

App Server 路径直接调用 reconciliation，不重新广播一个面向 UI 的通用 completion 事件，避免额外通知和双事件语义。

### 4. App Server 重放接线

保留 `handleAgentCompletionEvent` 现有 terminal state fallback。完成合法 Stop 事件解析后，由 `backend/src/index.ts` 把同一事件的 `projectId`、session、panel、tmux pane、cwd 传给 `AgentTeamService.reconcileCompletionSignal()`。

处理规则：

- outbox 尚未落盘：本次返回，不把 App Server cursor 卡住；周期扫描随后接管。
- outbox 已落盘且匹配 active worker：立即推进。
- outbox 不匹配当前 run：记录结构化 warning 后忽略，App Server cursor 正常前进。

### 5. 启动恢复与周期扫描

复用现有 watchdog 对项目和 running run 的遍历，拆成两个阶段：

1. 每 10 秒先扫描所有 executing/running run 的 active worker outbox；发现有效结果立即 reconciliation，不等待超时。
2. 只有未发现结果且 `recheckRequestedAt` 超过一小时，才进入现有 retry/escalation。

backend 初始化完成后立即执行一次相同扫描，不等待首个 10 秒 tick。

扫描范围必须覆盖：

- 初始 `code` outbox：依靠精确 `runId + role + panel` 判断是否属于当前 run。
- `code_review` / `behavior_verify`：同时使用现有 recheck 元数据判断新旧结果。

### 6. 修复 null baseline 语义

`recheckOutboxMtimeMs=null` 表示派发时 outbox 不存在，而不是“永远不能比较”。规则调整为：

- baseline 有值：要求当前 mtime 严格大于 baseline。
- baseline 为 null：要求 outbox mtime 晚于 `recheckRequestedAt`。
- 无法读取 mtime：本轮不消费，保留 pending，下一次扫描重试。

`finishedAt` 仅作为日志与证据，不作为唯一新鲜度依据，避免 worker 时钟或手工内容影响状态推进。

为覆盖初始 code、review/verify 以及失败回弹后再次进入 code 的同角色旧 outbox，run 持久化一个可选的 `activeWorkerDispatch`：记录本轮 role、pane、派发时间和派发前 outbox mtime。升级前的 running run 没有该字段时，优先从现有 recheck 元数据恢复边界，再回退到 run `updatedAt`；新 run 和后续每次派发都写入明确边界。

## 文件与职责

- `backend/src/agent-team/service.ts`
  - 提取统一 reconciliation 入口。
  - 本地 completion、App Server signal、startup scan、watchdog scan 共用该入口。
  - 将 fresh-result 扫描放到 timeout 判断之前。
  - 修复 null mtime baseline。
- `backend/src/app-server/handlers/agent-completion.ts`
  - 保持 terminal state fallback；返回或暴露已规范化的合法 completion 上下文。
- `backend/src/index.ts`
  - 把 App Server 重放 completion 接到 `AgentTeamService`，不再只更新 terminal idle。
- `backend/src/agent-team/outbox-resolver.ts`
  - 返回实际命中的 outbox 路径与 mtime，保证 freshness 比较使用的就是被解析的文件。
- `packages/shared/src/agent-team.ts`
  - 为 run 增加可选 `activeWorkerDispatch` 持久化字段；不改变 HTTP 请求或 outbox 协议。
- `docs/testing/agent-team-completion-recovery-test-cases.md`
  - 覆盖正常、重启、双事件、无 App Server、null baseline、stale outbox 和三类 worker。

completion signal 类型留在 backend 内部；shared 只增加前后端共同读取的可选 run 状态字段。

## 错误处理与日志

增加结构化日志，至少区分：

- `agent-team.completion.reconciled`：来源、runId、role、panelId、outbox mtime、结果数。
- `agent-team.completion.deferred`：outbox 尚未出现或暂时不可读。
- `agent-team.completion.stale`：runId/role/panel 不匹配，明确 reason。
- `agent-team.completion.duplicate`：signal 到达时 run 已不再等待该 worker。

日志不得记录 outbox 全文、token、Authorization 或 hook secret。

## 兼容、迁移与回滚

- run JSON 增加可选字段，不需要迁移项目文件。
- 新代码可以恢复升级前创建、仍处于 running 状态且 outbox 含正确 runId 的 run；首次再次派发后会自然补齐新字段。
- App Server 不可用时，现有直连 completion 和周期 outbox 扫描仍能推进。
- 回滚本改动只恢复旧事件处理代码；不会改写或删除现有 run/outbox。

## 实施步骤

1. 在 `AgentTeamService` 提取统一 reconciliation，并让现有 `handleTerminalEvent` 委托给它。
   - 验证：正常 code -> code_review -> behavior_verify 流程保持不变。
2. 接入 App Server completion signal。
   - 验证：直连 completion 人为失败后，重放事件仍消费 outbox。
3. 增加启动扫描和每 10 秒 fresh-result 扫描。
   - 验证：App Server 与直连都不可用时，backend 恢复后仍能从 outbox 继续。
4. 修复 null baseline 与 stale outbox 判定。
   - 验证：首次生成 outbox 可消费；旧 run、错 pane、错 role 文件均不能推进。
5. 执行静态门禁和配套真实行为用例。

## 验证门禁

任一静态命令失败即停，但静态检查不能替代行为验收：

```bash
pnpm --filter @runweave/shared typecheck
pnpm --filter @runweave/backend typecheck
pnpm lint
git diff --check
```

随后逐条执行 `docs/testing/agent-team-completion-recovery-test-cases.md`。涉及 Agent Team 页面状态必须使用 `$playwright-cli`；后台结论必须同时保留 run JSON、pane-scoped outbox、hook/App Server/backend 日志证据。

## 完成定义

- 正常双通道 completion 只推进一次。
- backend 在任一 worker 完成窗口重启，恢复后 10 秒内自动推进到正确下一状态。
- App Server 不可用时，outbox 扫描仍能恢复。
- stale/mismatched outbox 不推进 run。
- 一小时 watchdog 只处理真正没有结果的 worker，不再忽略 baseline 为 null 的有效 outbox。
- 配套用例全部通过，且没有新增单元测试文件。
