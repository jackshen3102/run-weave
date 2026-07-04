# Agent Team / Loop Engineer 测试计划（面向缺陷挖掘）

> 被测对象：当前工作区未提交的 diff —— 用全新的 `agent-team` 模块整体取代上一代 `orchestrator`。
> 关联文档：`docs/plans/2026-07-03-agent-team-loop-engineer.md`（落地方案）、`docs/prototypes/multi-agent-workspace/`（原型）。
> 本计划目标：**验证功能达成验收标准 + 主动找出 diff 中的漏洞和边界问题**，不是走过场。

## 0. 变更范围快照（测试锚点）

改动横跨协议、后端、前端、hook bridge，且删除了整代 orchestrator：

协议 / 共享：

- `packages/shared/src/agent-team.ts`（新）：run/loop/worker/acceptance/note/outbox 数据模型 + DTO。
- `packages/shared/src/terminal-protocol.ts`：`TerminalCompletionEvent` / `...Payload` 增加 `panelId?` / `tmuxPaneId?`。
- `packages/shared/src/index.ts`：`export * from "./agent-team"` 取代 `./orchestrator`。
- 删除 `packages/shared/src/orchestrator.ts`。

后端：

- `backend/src/agent-team/*`（新）：`service.ts`、`loop.ts`、`outbox-resolver.ts`、`prompt-builders.ts`、`prompt-sender.ts`、`run-id.ts`、`errors.ts`、`storage/{agent-team-paths,json-file,run-store}.ts`。
- `backend/src/routes/agent-team.ts`（新）：`/api/agent-team/*` 路由。
- `backend/src/routes/terminal-panel-routes.ts`：抽出可复用 `createTerminalPanelSplit()`。
- `backend/src/routes/terminal-completion.ts`：`resolveCompletionPane()` + hook 上报补 `panelId`/`tmuxPaneId`。
- `backend/src/terminal/completion-event{-service,s}.ts`：完成事件透传 pane 字段。
- `backend/src/index.ts`：挂 `/api/agent-team`，删 `/api/orchestrator` 及 `setControlPlaneBaseUrl` 调用。
- 删除 `backend/src/orchestrator/*`、`backend/src/routes/orchestrator.ts`。

前端（Web desktop）：

- `frontend/src/components/terminal/terminal-agent-team-panel.tsx`（新）：三段 sidecar。
- `terminal-preview-panel{,-shell}.tsx`、`terminal-workspace-shell.tsx`、`features/terminal/preview-store.ts`：sidecar tab `orchestrator → agent-team`。
- `frontend/src/services/terminal.ts`：orchestrator API 全量替换为 agent-team API。
- 删除 `terminal-orchestrator-panel.tsx` + `orchestrator/` 子目录。

hook bridge：

- `electron/resources/hooks/runweave-hook-payload.cjs`、`plugins/toolkit/hooks/runweave-hook-payload.cjs`：completion body 补 `panelId`。

## 1. 前置门禁（必须先全绿，否则后续无意义）

| #   | 验证                  | 命令                                                                                             | 期望                                                                          |
| --- | --------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| G1  | shared 类型           | `pnpm --filter ./packages/shared typecheck`                                                      | exit 0                                                                        |
| G2  | backend 类型          | `pnpm --filter ./backend typecheck`                                                              | exit 0                                                                        |
| G3  | frontend 类型         | `pnpm --filter ./frontend typecheck`                                                             | exit 0                                                                        |
| G4  | frontend lint         | `pnpm --filter ./frontend lint`                                                                  | 0 error                                                                       |
| G5  | 空白/冲突残留         | `git diff --check`                                                                               | 无输出                                                                        |
| G6  | orchestrator 残留引用 | `grep -rn "orchestrator\|Orchestrator" backend/src frontend/src packages/shared/src`             | 仅 `agent-team.ts` 注释、`prompt-sender.ts` 注释；无 import / 路由 / 类型引用 |
| G7  | 死引用扫描            | `grep -rn "api/orchestrator\|OrchestratorService\|createOrchestratorRouter\|openOrchestrator" .` | 无命中（docs/prototypes 除外）                                                |

> 备注：本次已跑过 G1–G6，均通过；G6 命中仅剩两处注释性引用。G7 需在正式回归时复核。

## 2. 分层测试矩阵

### 2.1 协议 / 数据模型层（`agent-team.ts` / `terminal-protocol.ts`）

- P1 `TerminalCompletionEvent.panelId/tmuxPaneId` 为可选（`?`），旧的单 pane 上报（不带这两个字段）仍能构造、序列化不报错。→ 向后兼容。
- P2 `AgentTeamWorkerOutbox.acceptanceResults` 可缺省；缺省时编排层应视为「无验收信号」而非崩溃。
- P3 类型对齐：`RecordAgentTeamRoundRequest.acceptanceResults` 与 outbox 的 `acceptanceResults` 结构一致（caseId/status/evidence）。
- P4 `AgentTeamStatus` 枚举齐全（clarifying/running/need_human/done/failed）；注意 **没有任何路径会写 `done`/`failed`**（见 §4 缺陷 D9）。

### 2.2 后端 service 单元级冒烟（`tsx` 直跑，不新增单测）

按仓库约束用脚本化冒烟替代单测。建议写一个临时 `tsx` 脚本，用假的 `TerminalSessionManager`/`PtyService`/`TmuxService`（或 `tmuxService=undefined`）直接驱动 `AgentTeamService`，覆盖：

- S1 `startRun`：无 tmux 时 `mainPanelId=null`，run 落盘、phase=clarify、status=clarifying、注入 startup prompt（best-effort，失败不抛）。
- S2 `startRun` 幂等/冲突：同一 session 已有 active run（非 done/failed）→ 抛 409。
- S3 `proposeSplit(source=user)`（非 auto）→ phase=proposal、status=need_human、proposal 填充、默认 workers/acceptance 生效（3 worker / 2 用例）。
- S4 `proposeSplit(source=agent)` → clarify 追加一条 agent 消息、proposal.source=agent。
- S5 `proposeSplit` + `autoApproveSplit=true` → 跳过 gate 直达 executing、status=running。
- S6 `proposeSplit` 在 executing 阶段 → 409。
- S7 `submitSplitGate(rejected)` → 退回 clarify、proposal 清空。
- S8 `submitSplitGate(confirmed)`：workers.length===0（显式传空数组）→ 400；正常 → applySplit 进 executing。
- S9 `submitSplitGate` 无 pending proposal（phase≠proposal）→ 409。
- S10 `recordRound` 在非 executing → 409；在 need_human → 原样返回（冻结，不推进）。
- S11 `resumeRun` note 为空/纯空白 → 400；正常 → status=running、workers 全部 unfreeze、loop 计数与指纹重置、追加 humanNote（含 clearedFingerprints）、注入 note prompt。
- S12 `focusPane`：panelId 不属于该 run 且 ≠ mainPanelId → 404；属于则返回 run（tmux 缺失时静默跳过 select）。
- S13 存储：`run-store` 读写往返一致；`listRuns` 按 `updatedAt` 倒序；跨 project 扫描只返回 `projectId` 匹配项。

### 2.3 loop / 去抖 / 熔断（`loop.ts` 纯函数 —— 最该重点打）

`foldRound` / `shouldEscalate` / `fingerprintFailure` 是核心且可纯函数化测试，务必构造边界：

- L1 全 pass 一轮：consecutiveFail 清零、bouncedToPanelId 清空、bestPassCount 上升 → hadProgress=true、noProgressCount=0。
- L2 单轮 flip（fail 一次，cf=1 < threshold=2）：`newlyStableFailCaseIds` 为空、**noProgressCount 不增**（去抖生效）。
- L3 连续 fail 跨阈值：cf 从 1→2 时进入 `newlyStableFailCaseIds`（仅当轮触发一次），noProgressCount 才 +1。
- L4 **熔断真实轮数校验**（重点）：从全新 loop 连续「无进展轮」到熔断需要几轮？按代码推演：
  - round1 fail：cf=1，未达阈值 → noProgress=0
  - round2 fail：cf=2，stable → noProgress=1
  - round3 fail：cf=3 → noProgress=2
  - round4 fail：cf=4 → noProgress=3 → `shouldEscalate` true
  - 即 **需要 4 个无进展轮**，而 UI 文案写「连续 maxNoProgress(=3) 轮无进展将自动熔断」。→ 断言此不一致（见 D1）。
- L5 `hadDiff=true` 且用例仍 fail：hadProgress=true（diff 覆盖），noProgressCount 清零，即使有 stable fail 也不累加。→ 验证「有实质 diff」优先级。
- L6 pass 数回落再回升：bestPassCount 只增不减，导致「回到历史最高但未超过」时 passRose=false。构造 pass=1→fail(best=1)→pass=1，第三轮 passRose=false，若无 diff 则算无进展。→ 验证是否符合预期（潜在反直觉，见 D3）。
- L7 `fingerprintFailure` 归一化：
  - 数字/hex/路径被替换为 `<n>/<hex>/<path>`，大小写折叠、空白折叠、截断 160。
  - 构造两条「仅行号/路径不同」的错误 → 应得到同一指纹（去重进 errorFingerprints）。
  - 构造两条语义不同但结构相似的错误 → 是否被误判同类（过粗风险）。
  - 空字符串 / 超长字符串 / 含正则元字符 → 不抛异常。
- L8 指纹来源：stable fail 取 `evidence` 里第一条 `type==="text"` 的 ref，否则回退 `case.text`。构造无 text evidence 的失败 → 用 case.text 生成指纹。
- L9 `buildEscalationReason`：有 stuckCases 时列 caseId + 指纹类数；无 stuckCases 时「多轮无进展」兜底。
- L10 `acceptanceResults` 为空数组 `[]`：foldRound 仍 `round += 1`，但不计 noProgress、不计 progress。→ 验证空轮语义（round 会虚增，见 D6）。
- L11 结果里含 run.acceptance 不存在的 caseId：`resultById` 有多余项被忽略；缺失项保持原状。→ 不崩、不误判。
- L12 `shouldEscalate` 幂等：已 escalated=true 时不再重复触发（`!loop.escalated` 守卫）。

### 2.4 API 契约层（`routes/agent-team.ts` + zod）

对每个端点跑正/反例（`curl` 或 `tsx` supertest 风格），需带鉴权（`/api/agent-team` 挂 `requireAuth`）：

- A1 `GET /runs`：缺 `projectId` → 400；带 `terminalSessionId` 时返回 `{runs:[单条|空]}`；仅 `projectId` 返回列表。
- A2 `GET /runs/:runId`：非法 runId（含 `/`、空格、`..`）→ 400（`runParamsSchema` + `AGENT_TEAM_RUN_ID_PATTERN`）；不存在 → 404。
- A3 `POST /runs`：缺字段 / 多余字段（`.strict()`）→ 400；`task` 超空白 trim；`options.autoApproveSplit` 非 bool → 400。
- A4 `POST /runs/:id/propose-split`：body 可空（`req.body ?? {}`）；`workers[].role` 非枚举 → 400；`intent` 空串 → 400；多余字段 → 400。
- A5 `POST /runs/:id/split-gate`：`verdict` 非枚举 → 400；`confirmed` 但 workers 空数组 → service 抛 400。
- A6 `POST /runs/:id/round`：`acceptanceResults[].status` 非 pass/fail → 400；`evidence` 缺省 default `[]`；`evidence[].type` 非枚举 → 400。
- A7 `POST /runs/:id/resume`：缺 note → 400；空白 note → 400。
- A8 `POST /runs/:id/focus-pane`：缺 panelId → 400。
- A9 错误映射：`AgentTeamError` → 对应 statusCode + message(+details)；未知错误 → 500 且不泄漏内部堆栈（当前会把 `String(error)` 放进 `error` 字段，评估是否泄漏，见 D8）。
- A10 鉴权：无 token / 错 token → 401（`requireAuth`），且前端 401 会触发 `onAuthExpired`。

### 2.5 pane 归因 / hook bridge（`terminal-completion.ts` + `.cjs`）

- H1 hook 上报只带 `panelId`（来自 `RUNWEAVE_TERMINAL_PANEL_ID`）：`resolveCompletionPane` 用 panelId 命中 panel 补 `tmuxPaneId`；命中不到时 `tmuxPaneId=null`。
- H2 hook 只带 `tmuxPaneId`（无 panelId）：反查 panel 补 `panelId`。
- H3 两者都无（单终端）：都为 null，向后兼容。
- H4 panelId 传了但该 session 无此 panel（脏 env / pane 已关）：仍原样返回传入 panelId（不校验存在性）→ 评估是否会把完成事件归给一个已不存在的 pane（见 D5）。
- H5 `.cjs` 只补了 `panelId`，**没补 `tmuxPaneId`**（对比 protocol 支持两者）→ 确认这是有意（依赖后端反查）还是遗漏。
- H6 electron 版与 plugins/toolkit 版两个 `.cjs` 内容一致（本 diff 两处同步改动）→ 防止分叉。

### 2.6 pane split / 复用（`createTerminalPanelSplit`）

- SP1 HTTP `POST /api/terminal/sessions/:id/panels`（重构后）行为与重构前一致：返回 201 + workspace，panel 落盘、env 注入 `RUNWEAVE_TERMINAL_PANEL_ID`。→ 回归，确保抽函数无行为漂移。
- SP2 agent-team `applySplit` 复用同函数：`focus:false` 时不抢占 activePanelId；方向按 `boundWorkers.length % 2` 交替 right/down。
- SP3 alias 唯一性：`assertUniqueAlias` 对 `${role}-${n}` 冲突时抛错；applySplit 里单个 worker split 失败被 `catch` 降级为 `panelId=null`（不整体失败）。→ 验证部分 worker split 失败时 run 仍进 executing，但该 worker 无 pane（见 D7）。
- SP4 无 tmux（`tmuxService=undefined`）：applySplit 全部 worker `panelId=null`，仍进 executing → executing 阶段没有任何 pane 可用，loop 无信号来源。→ 评估该退化态是否应拦截。
- SP5 panel-split 默认关闭场景：startRun 里 `ensureTerminalPanelWorkspace` 是否真的把该 session 的 pane 能力打开（对齐风险点「panel-split 默认关闭」）。

### 2.7 存储 / 路径安全（`agent-team-paths.ts` / `run-store.ts` / `json-file.ts`）

- ST1 runId 注入：`assertSafeAgentTeamRunId` 拦 `../`、`/`、空白；`runFilePath`/`getRun` 均校验。
- ST2 **outbox 路径按 `sessionId` 命名**：`defaultOutboxPath` 用 `${sessionId}.json`，**未按 panelId 区分** → 同一 session 内多个 worker pane 完成时写同一文件，互相覆盖 / 读到别人的 acceptanceResults（重点缺陷 D2）。
- ST3 sessionId 未消毒进文件名：若 sessionId 含 `/` 或 `..`（理论上是受控 uuid，但值得确认来源）→ 路径穿越风险。
- ST4 `readJsonFile` 对损坏 JSON / 不存在文件返回 null（吞异常）→ resolveOutbox 返回 null → 不推进 loop（安全降级）。但也会吞掉「文件存在但格式错」的真实问题，无日志 → 可观测性缺口。
- ST5 `writeJsonFile` 非原子写（直接 writeFile）：并发写同一 run 文件时可能读到半写状态？配合 §2.8 并发看。
- ST6 `listRuns` 目录不存在返回 `[]`；`getRun` 跨所有 project 扫描 —— project 很多时的性能（4s 轮询叠加）。

### 2.8 并发 / 竞态（重点，多 Agent 天然并发）

- C1 `startRun` check-then-write 无锁：并发两次开启同一 session → 可能创建两个 run（都通过 existing 检查）。→ 验证是否需要串行化（D4）。
- C2 completion 事件串行化：`enqueue(runId)` 用 per-run promise 链保证同 run 的 round 顺序处理。构造快速连续两个 completion 事件 → 验证不并发折叠、loop 计数正确、无丢失。
- C3 `enqueue` 里 `applyRound` 读的是 `getRun`（磁盘最新），但 handleTerminalEvent 外层已读过一次 run；两次读之间状态可能变（如人工 resume）→ 验证不会用陈旧 run 覆盖新状态。
- C4 completion 事件与 HTTP `recordRound` 同时到达：两条路径都调 `applyRound`，HTTP 路径**不走 enqueue 串行化** → 与事件路径竞态，可能双计 round（D4）。
- C5 resume 与 completion 事件竞态：resume 把 status=running 后，一条在途 completion 立刻推进 → 是否「恢复即复燃」（对齐验收 #8）。

### 2.9 前端 UI 状态机（`terminal-agent-team-panel.tsx`）

- U1 无 project/session：显示「选择一个终端」空态。
- U2 无 run：`StartFlowSection`，autoApprove 勾选态可切换，开启按钮 busy 禁用。
- U3 clarify：渲染 clarify 消息流；两个按钮（用户主导 / 模拟 agent 主导）；auto 时按钮文案变「自动拆分并执行」。
- U4 proposal：`workerDrafts` 从 proposal 同步；加/删 worker（`ROLE_CYCLE` 轮转）；**验收用例草案只读、不可编辑**（对比方案验收 #2「验收草案可编辑」→ UI 缺口 D10）；确认按钮在 drafts 空时禁用。
- U5 确认拆分只提交 `workers`，不提交 acceptance → 后端用 proposal.acceptance 兜底。验证编辑 worker 后 acceptance 仍正确。
- U6 executing：round/noProgress 进度条按 `maxNoProgress` 格数渲染；level 阈值 `ratio>=0.66` 转 warn；pass/fail 计数正确。
- U7 手动模拟一轮（✓/✗）：一次 ✗ 因去抖不增计数（U 层观测应与 L2 一致）—— 用户点一次「无进展」但计数不动，可能困惑（体验缺陷，配合 D1）。
- U8 熔断态：显示 lastReason、`PaneFocusList`（仅有 panelId 的 worker）、note 必填才可恢复。
- U9 恢复后：计数清零、状态回 running、note 输入框清空（`.then(() => setResumeNote(""))`，注意仅在 runAction resolve 后清空，失败不清）。
- U10 轮询：4s 轮询 `loadRun`；切换终端时 reset + 重载；轮询与手动操作并发时 UI 是否闪烁/回退（乐观更新被轮询覆盖）。
- U11 401：任一请求 401 → `onAuthExpired`，不把 401 当普通错误展示。
- U12 focusPane 失败：`.catch(handleError)` 展示错误但不改 run 状态。

## 3. E2E 场景（`$playwright-cli`，按 AGENTS.md 必须实际执行并留证据）

对齐方案「验证方式」的 5 条主链路，逐条截图/DOM 取证：

- E1 开普通终端 → sidecar 切到「Agent Team」→ 点「开启流程」→ 断言进入澄清（sidecar 切 clarify、左侧 main pane 有主 Agent startup prompt）。
- E2 clarify → 「让主 Agent 拆分」→ proposal 卡出现 → 加/删 worker → 「确认拆分」→ 截图断言左侧 split 出 main + N 个 worker pane、右侧进 executing。
- E3 `autoApproveSplit=true`：开启 → 拆分 → **跳过 gate 直达 executing**（无 proposal 卡）。
- E4 构造一次稳定 fail（连点两次「无进展」跨阈值）→ 断言 noProgress 累加 + 用例标 ✗ + 「已抛回 code pane」标记出现（bounce 生效）。
- E5 连续无进展到熔断 → 断言熔断卡 + 归因文案 + 「聚焦 pane」深链能高亮对应 pane（tmux selectPane 生效）。
- E6 熔断后填 note 恢复 → 断言 note 注入 main pane、计数重置、status 回 running、**不立即复燃**（观察下一轮不马上再熔断）。
- E7 pane 只读/接管态：executing 平时 pane 只读旁观；熔断/接管态可手敲（对齐验收 #9）。

真实 completion 事件链路（比 UI 手动模拟更接近生产）：

- E8 让一个 behavior_verify pane 真的写出 `.runweave/outbox/<sessionId>.json`（含 acceptanceResults）→ 触发 Stop hook → 断言 `resolveOutbox` 读到、loop 按真实结果推进。**顺带验证 D2**：起两个 worker pane 都写 outbox，看是否互相覆盖。

## 4. 已识别的可疑点 / 潜在缺陷（需重点证伪或复现）

> 以下均来自对本 diff 的静态阅读，需在测试中确认是「真 bug」还是「可接受设计」。

- **D1 熔断轮数与 UI 文案不一致（高）**：`loop.ts` 因去抖（stableFailThreshold=2）实际需 **4 个无进展轮**才熔断（见 L4），但 UI/文案宣称 `maxNoProgress=3` 轮。且用户点第一次「无进展」计数纹丝不动（去抖），易被当成「按钮坏了」。需明确期望语义并统一文案 or 计数。
- **D2 outbox 按 session 命名导致多 worker 覆盖（高）**：`defaultOutboxPath` 用 `${sessionId}.json`，同一终端里多个 pane（多 worker）共享一个 outbox 文件。多 worker 完成时 acceptanceResults 互相覆盖，编排层可能读到错误 pane 的结果。方案 §0.1 明确要「per-pane 归因」，此处未按 panelId 分文件。**建议按 `<sessionId>-<panelId>.json` 或目录分片**。
- **D3 resume 未重置 bestPassCount（中）**：`resumeRun` 重置了 noProgressCount / errorFingerprints / consecutiveFail，但 **没重置 `loop.bestPassCount`**。恢复后若 passCount 回不到历史最高，passRose 恒 false，进展判定变严 → 可能「恢复后更容易再次熔断」，与验收 #8「不立即复燃」相悖。需测 E6 边界。
- **D4 并发双路径推进 loop（中）**：completion 事件走 `enqueue` 串行化，但 HTTP `recordRound` **不走 enqueue**。两者并发（真实 verify 完成 + 人手动记一轮）会竞态双计 round / 双写 run 文件（配合 D-store 非原子写）。startRun 也无锁（C1）。
- **D5 panelId 不校验存在性（中）**：`resolveCompletionPane` 对传入的 `panelId` 直接透传、不确认该 panel 属于此 session（H4）。脏 `RUNWEAVE_TERMINAL_PANEL_ID`（如 pane 已关或跨 session 继承的 env）会把完成事件错误归因。参考现网教训：hook 端口/归属继承父 shell 的坑。
- **D6 空轮虚增 round（低）**：`foldRound` 无条件 `loop.round += 1`，即使 `acceptanceResults` 为空/缺失（L10）。UI 显示的 round 数可能比真实验收轮次多。
- **D7 部分 worker split 失败静默降级（中）**：`applySplit` 单 worker split 失败 catch 成 `panelId=null` 仍进 executing。behavior_verify 若恰好没 pane，则 executing 永远收不到验收信号，loop 卡死也不会熔断（熔断依赖有 stable fail 计数，无信号则 noProgress 永不增）。
- **D8 500 响应回显内部错误串（低/安全）**：`handleServiceCall` catch 未知错误时把 `String(error)` 放进响应 `error` 字段，可能泄漏内部路径/堆栈片段。评估是否只在非生产返回。
- **D9 无 done/failed 终态写入（中）**：`AgentTeamStatus` 定义了 `done`/`failed`，但 service 无任何路径写这两个状态。run 永远停在 running/need_human。`startRun` 的「existing 非 done/failed 才 409」意味着一个 session 的 run **永远无法正常结束再开新的**（除非手删磁盘文件）。→ 生命周期收尾缺失。
- **D10 验收用例草案 UI 不可编辑（中）**：方案验收 #2 要求「可编辑提案卡（worker 增删 + 验收用例草案）」，但前端 `ProposalSection` 的 acceptance 是只读列表，且 `submitSplitGate` 前端不传 acceptance。→ 功能未完全达成验收标准。
- **D11 outbox 解析无日志（低）**：`readJsonFile` 吞所有异常返回 null；outbox 存在但 JSON 损坏时静默不推进，无 warn 日志，难排查（ST4）。
- **D12 freeze 语义名不副实（低）**：方案说「pane 级冻结 loop」，实现是**整 run 级**（靠 status=need_human 拦截 + workers.frozen 仅作标记）。`frozen` 字段无实际执行力，恢复时一刀切全部 unfreeze。与「per-pane 精准冻结」描述有差距。

## 5. 回归 / 爆炸半径（orchestrator 下线）

方案风险点明确点名此项，必须验证删旧模块无残留：

- R1 完成事件订阅：确认 `TerminalEventService` 的 completion 订阅**只有** agent-team resolver 消费，旧 orchestrator 订阅已干净移除（不多不少）。
- R2 `backend/src/index.ts`：`/api/orchestrator` 已删、`/api/agent-team` 已挂；`setControlPlaneBaseUrl` 调用删除后无其它调用方报错。
- R3 前端：sidecar 三 tab（preview/browser/agent-team）切换正常；旧 Orchestrator tab 与 `terminal-orchestrator-panel.tsx` 引用全无（G6/G7）。
- R4 旧落盘目录（run-store/role-store/sidecar-store）不再被写；新目录 `.runweave/agent-team/` 正常生成。历史遗留的旧目录不影响新流程读取。
- R5 `services/terminal.ts`：无任何组件仍 import 已删的 `listOrchestratorRoles` 等（typecheck 已覆盖，但确认无动态引用/字符串路由）。
- R6 `TerminalPreviewPanel` 删除了 `sessions`/`onSelectSession` 的使用但 `terminal-workspace-shell.tsx` 仍传入这两个 prop —— 确认为无害多余 prop（interface 仍声明），非编译错。建议记为待清理。

## 6. 执行顺序建议

1. §1 门禁全绿（快，先做）。
2. §2.3 loop 纯函数冒烟（`tsx` 直跑，最高性价比找逻辑 bug，重点 L4/L6/L7）。
3. §2.2 service 冒烟 + §2.4 API 反例。
4. §2.5–2.8 pane 归因 / split / 存储 / 并发（复现 D2/D4/D5/D7）。
5. §3 Playwright E2E 五链路 + E8 真实 outbox（对齐验收标准并取证）。
6. §4 逐条证伪/复现缺陷，§5 回归收尾。

## 7. 通过标准

- 门禁 §1 全绿。
- 方案「验收标准」9 条中，除 D10（验收草案可编辑）、D9（终态）等已识别缺口外，其余在 E2E 有截图/DOM 证据。
- §4 每条 D 项有明确结论：已复现（附最小复现步骤）/ 证伪（附证据）/ 判定为可接受设计（附理由）。
- 高优先级 D1/D2 必须有处置结论（修复或明确 backlog），不得静默放行。
