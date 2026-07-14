# Agent Team Readiness P1 增量代码审查

## 结论

通过。C4 `90c3b1102a45d0e47702461c194d58c597a2846a` 到当前 working tree 的 3 文件增量未发现未修复 P0/P1。原 invariant `agent-team.serial-dispatch-readiness-failure-state` 已关闭：Codex 的 `node` wrapper 需要 pane-local owner 条件与真实 Codex UI 条件同时成立；serial dispatch 的 session、worker pane 或 readiness 失败会一次写入可人工恢复状态，且不会消耗 repair attempt。

已知 P2 `recheck-watchdog-clock-lifecycle` 明确保留为 informational，未被本增量处理，也不作为本轮 blocker。C4 已包含的 AGT-WH-021 修改不在本次 diff 中。

## 固定边界

- base commit / HEAD: `90c3b1102a45d0e47702461c194d58c597a2846a`
- working-tree tree（隔离临时 index 计算，不改变真实 index）: `3c19e7d3ad71ee55d570d5f925f921936001b1fa`
- binary diff SHA-256: `fec30835055b239e6a489cc44f4012cf783a7d91496e314713a886f0e5278356`
- changed paths:
  - `backend/src/agent-team/agent-readiness.ts`
  - `backend/src/agent-team/service-serial-dispatch.ts`
  - `backend/src/agent-team/service-support.ts`
- diff size: 65 additions / 18 deletions
- `git diff --check`：通过

真实 index 仍为 C4 tree `74b17d61f7a71768d372b6bc5979fb9e71738384`；本审查未 stage 或修改源码。

## 核查结果

### 1. 不误认任意 node

`resolveActiveAgentOwner` 只有在以下条件同时成立时返回 `codex_node_wrapper`：目标 agent 为 `codex`、metadata 来源为 `pane_current_command`、解析后的可执行名为 `node`。该 owner 不允许使用已有 `agent_idle` 快捷路径；`isAgentUiReady` 必须继续读取目标 pane scrollback，并由 `hasStartedCodexUi` 判定通过。

独立 owner matrix 结果：Codex node + UI=true；Codex node 无 UI=false；node 的 metadata source 非 `pane_current_command`=false。

定位：`backend/src/agent-team/agent-readiness.ts:342-415`。

### 2. 非 Codex provider 无回归

node-wrapper 分支显式要求 `agent === "codex"`。TraeX/TraeCLI 继续使用既有 direct-owner 与 Trae ready prompt 逻辑。独立矩阵结果：TraeX + node=false；TraeX + traecli direct=true；TraeX + codex cross-provider=false。

定位：`backend/src/agent-team/agent-readiness.ts:394-415,565-583`。

### 3. 失败状态可恢复且原子

serial dispatch 的 session 缺失、worker pane 缺失、`ensureAgentReady` 抛错均进入 `pauseForWorkerDispatchError`。该 helper 在单次 `updateRun` 中设置：

- `status=need_human`
- `activeWorkerRole=null`
- `activeWorkerDispatch=null`
- 所有 workers `frozen=true`
- `loop.escalated=true` 并记录 `lastReason` 和暂停日志

`resumeRun` 可从 `need_human` 重新选择 active worker 并解除目标 worker 的 frozen 状态，因此不是无 dispatch 的不可恢复 running gate。

定位：`backend/src/agent-team/service-serial-dispatch.ts:120-190`、`backend/src/agent-team/service-support.ts:239-251`、`backend/src/agent-team/service-lifecycle.ts:351-395`。

### 4. repair cycle 边界

readiness 检查发生在 `acceptedRepairKeys` 解析和 `incrementRepairAttempts` 之前；失败 helper 只复制现有 loop 并设置 escalation 字段，不改变 `repairCycles[].attempts`。独立受控探针从 attempts=2 进入 `need_human` 后仍为 2。

定位：`backend/src/agent-team/service-serial-dispatch.ts:180-212`、`backend/src/agent-team/service-support.ts:239-251`。

## 验证证据

- `pnpm agent-team:verify-review-checkpoints`：通过全部 readiness/tmux/repair/checkpoint 检查。
- `pnpm --filter @runweave/backend typecheck`：通过。
- `pnpm --filter @runweave/backend lint`：通过。
- 独立 inline owner matrix：7/7 通过。
- 独立 inline pause-state probe：`need_human/null/null`、workers frozen、attempts 2→2。
- `.runweave/evidence/dvs-8854aa/readiness-p1/node-wrapper-probe.json`：真实 pane `%49` 为 `node`/`pane_current_command`，Codex UI 存在时接受，无 UI 时拒绝。
- `.runweave/evidence/dvs-8854aa/readiness-p1/dispatch-failure-probe.json`：生产 serial-dispatch 受控 readiness 异常收敛到可人工恢复状态，repair cycles 不变。
- `status-ready.json` / `status-stopped.json`：fullstack 隔离环境曾 ready，随后 stopped；隔离 source root 已移除，5002/5173/6100 当前均无 listener。

## Findings

- P0/P1 remaining：无。
- P1 resolved：`agent-team.serial-dispatch-readiness-failure-state`。
- P2 informational：`recheck-watchdog-clock-lifecycle`。完成态/暂停态 run 的 watchdog clock 清理仍未处理，位于 `backend/src/agent-team/service-recheck.ts:62-70,109-145`；这是明确排除的既有问题，不影响本轮 P1 结论。

## 残余验证边界

现有 runtime 证据由真实 pane owner 探针与受控 production-method failure probe 组成，没有重新启动一轮完整 Agent Team serial dispatch。代码路径、独立矩阵和仓库 verifier 相互印证，未发现需据此升级为 P0/P1 的缺口。
