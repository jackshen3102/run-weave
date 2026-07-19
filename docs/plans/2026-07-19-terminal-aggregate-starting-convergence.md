# 终端聚合状态被僵尸 agent_starting 污染 — 最小安全修复计划

## 背景与现场证据

复盘对象:终端 `dd8353fe`(当前 worktree `agent-team-2` 的 Agent Team 会话,4 个 tmux pane 共享一个 terminal session)。

用户现象:「panel 是 running 的,但整体应该 running 才对」——即 panel 状态与终端整体状态错配。

### 实时取证(非推测)

数据源:tmux socket 会话 `runweave-dd8353fe`;后端存储 profile 目录下 `terminal-session-store.json`(`<browser-profile>/terminal-session-store.json`);后端日志 `<browser-profile>/logs/backend/backend-2026-07-19.jsonl`。

11:33 同一瞬间对齐快照:

| pane | alias           | tmux 真实(spinner)                    | 存储 panel.terminalState    |
| ---- | --------------- | ------------------------------------- | --------------------------- |
| 0    | main            | 无 spinner,`› Run /review` 空闲提示符 | `agent_idle`                |
| 1    | code-1          | 早已结束(`Worked for 34m 19s`)        | **`agent_starting`** ← 卡死 |
| 2    | code_review-2   | 结束                                  | `agent_idle`                |
| 3    | behavior_verify | 纯 shell                              | `shell_idle`                |

此刻四个 pane 实际都不在运行,但 `session.terminalState`(聚合)= `agent_starting`。

日志时间线(code-1 panel `05fa7385`):

- `02:08:26` `UserPromptSubmit → agent_running`
- `02:42:40` 该 panel 的 `Stop` 被 **拒绝**:`terminal-state.hook.ignored … ignoreReason: inactive_agent`
- 之后 agent-team 重新 dispatch,通过 `setAgentStarting` 把 code-1 打回 `agent_starting`
- 此后 **再无任何 hook** 把它推进到 `agent_idle`(它的 codex turn 其实早已结束)

### 根因(确切代码行)

1. `backend/src/terminal/application/panel-metadata.ts:90-92` `getPanelTerminalStateForActiveCommand`:reconcile 轮询时,只要 panel 的 `activeCommand` 仍是 `codex`(codex 进程还在前台,只是 turn 结束停在交互提示符),且 `previous.agent === agent`,就**原样保留** `previous`。于是僵尸 `agent_starting` 永不被轮询收敛。
2. `backend/src/terminal/terminal-state-service.ts:240 aggregatePanelTerminalState`:整体状态 = 各 running panel 的折叠,优先级 `agent_running` > `agent_starting` > `agent_idle`。code-1 的僵尸 `agent_starting` 于是把整体从「本该 idle」拽成 `agent_starting`。

> 结论修正:`agent_running` 是聚合最高优先级,任何真在跑的 panel **必然**让整体为 running,僵尸 `agent_starting` 压不住它。因此本次可复现、已取证的缺陷是 **A:无人运行时整体被僵尸 starting 拖住,显示「启动中」而非应有的 idle**。用户口述「应该 running」是对「状态不对」的直觉描述;实时证据全部指向 A,未捕获到「某 pane 真在跑但 stored 不是 running」的假阴性现场(记为 B,见下)。

## 目标与成功判据

- 目标:一个 codex worker panel 在其 codex turn 已结束、且**没有任何活跃启动租约/operation generation**时,不再被永久判为 `agent_starting`,从而不污染终端整体聚合状态。
- 成功判据(行为核对,本仓库不写单测):
  1. 复现场景:worker panel 经历过一轮 dispatch 且 codex turn 结束、无活跃 operation generation 时,`GET /api/terminal/session/:id/state` 返回的聚合状态不再是 `agent_starting`(应为 `agent_idle`)。
  2. 不回归:任一 panel 真处于 `agent_running` 时,整体仍为 `agent_running`(优先级不变)。
  3. 不回归:panel 首次真正启动、启动租约存在期间,仍显示 `agent_starting`(不误收敛)。
  4. `pnpm typecheck`、`pnpm lint` 通过。

## 修复方案(最小、只读收敛、不碰 hook 门禁)

### 核心原则

不放松 `agent-hook-processor.ts` 的 Stop 门禁(那会引入多 pane 串扰与重派竞态,是最不该松的地方)。改为在**收敛判据**上引入一条基于「确定性事实」的规则:`agent_starting` 只在存在活跃启动租约时可信;租约不存在时,一个 codex 命令在前台的 panel 应视为 `agent_idle`。

判据用现成 API,为确定性事实,不猜运行时长:

- `terminalSessionManager.hasPanelAgentOperationGeneration(sessionId, panelId)` — 是否有活跃启动 operation generation

> 现场校验修正(重要):`recentAgentActivity.phase` **不可用作判据**。实测 code-1 的 `phase=active`(codex 进程一直在前台,`observeActiveCommand` 就标 `active`),它反映「前台是不是 codex」而非「是否仍在启动等待 ready」。真正区分「正在启动」与「僵尸 starting」的确定性信号是 operation generation:`beginPanelAgentPreparation` 启动时设置它,`endPanelAgentPreparation` 启动结束时回滚(通常回滚到 null)。故 code-1 现状为 `op=null` 且 `hasPanelAgentOperationGeneration=false`,而首次真正启动期间为 true。判据只用 `hasPanelAgentOperationGeneration`。

### 落点(二选一,倾向 A2)

**A1(改 reconcile 收敛):** 在 `panel-workspace.ts` reconcile 循环里,当 `nextTerminalState.state === "agent_starting"` 且该 panel 无活跃 operation generation、`recentAgentActivity` 不处于 `active` 相位时,把 `nextTerminalState` 收敛为 `{ state: "agent_idle", agent }`。这会持久化修正 panel 自身状态,从源头消除僵尸。

**A2(只读聚合收敛,最小):** 保持 panel 存储不变,只在聚合读路径把「无活跃租约的 `agent_starting` panel」按 `agent_idle` 计。需要给 `aggregatePanelTerminalState` 的调用点补充「每个 panel 是否有活跃租约」的信息(纯函数保持纯,由调用方传入判定结果或改为接收 manager 查询回调)。

倾向 **A1**:它在 reconcile 这一唯一的 panel 状态权威更新点收敛,天然覆盖所有读路径(`terminal-state.ts`、`app-home-overview.ts`、`terminal-session-route-helpers.ts`),无需在多处读路径重复注入租约判定,改动面反而更小、更一致。A2 会散落在每个聚合调用点。

### A1 具体改动(预计 ~15 行 + 判据 helper)

- 文件:`backend/src/terminal/application/panel-workspace.ts`(reconcile 循环,`nextTerminalState` 计算之后)。
- 新增一个本地判据:`isStaleStartingWithoutLease(session, panel, nextTerminalState)` —— 返回 true 当且仅当 `nextTerminalState.state === "agent_starting"` 且 `!hasPanelAgentOperationGeneration(sessionId, panelId)`。
- 命中时把 `nextTerminalState` 降级为 `{ state: "agent_idle", agent: nextTerminalState.agent }`,走既有的 `terminalStateChanged` 分支持久化并发事件。
- 复用现有 line 170-189 已有的「清 starting 租约」清理逻辑保持一致,不新增清理路径。

## 边界与副作用评估

- **不放松门禁**:不改 `agent-hook-processor.ts` 的 ignore 分支;避免旧 operation / 其它 pane 的 Stop 误写正在 running 的 panel(文档明令禁止的「状态假成功」)。
- **不猜时间**:收敛判据是「无活跃租约」这一确定性事实,符合 `terminal-state.md`「系统不根据运行时长猜测 running」。
- **不误收敛真启动**:首次启动期间 operation generation / `active` 租约存在,`isStaleStartingWithoutLease` 为 false,仍显示 `agent_starting`。
- **运行态零影响**:`agent_running` 由 hook 独立驱动,判据只作用于 `agent_starting`,不触碰 running 优先级。

## 明确不在本次范围(避免混入)

1. **Defect B(未取证的假阴性)**:若某 pane 真在跑但 stored 不是 `agent_running`(漏 hook)。当前无现场证据,不在此计划推测性修改;若后续抓到现场再单独立项。
2. **持久 `session.terminalState` 脏 shell_idle**:多 panel 下 `activeCommand=null` 触发 `setShellActiveCommand` 把 session 持久值写成 `shell_idle`(`terminal-state-service.ts:46`)。读路径靠 panel 聚合绕过,不影响展示,但持久值本身脏。属独立缺陷,单独评估,不在本次改动。

## 验证步骤(完成前实际执行)

1. 最小改动后固定 patch 边界。
2. `pnpm typecheck`、`pnpm lint`。
3. 行为核对:构造/复用一个 worker panel 经历 dispatch→turn 结束→无活跃租约的场景,读 `GET /api/terminal/session/:id/state`,确认聚合从 `agent_starting` 收敛为 `agent_idle`;并确认另有 panel running 时整体仍为 running。
4. 若涉及 UI 验收,按 AGENTS.md 用 `$toolkit:runweave-dep-session` + `$toolkit:playwright-cli` 附着对应 CDP surface 取证(仅在需要页面级确认时)。
