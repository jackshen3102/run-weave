# Codex TerminalState 评审报告

日期：2026-06-10

评审范围：当前工作区未提交变更中与 Codex CLI 终端状态收敛相关的 App、Web frontend、backend、Electron hook、CLI、shared 协议改动。

评审强度：强力模式。原因是本次变更跨 App、Web、backend、Electron hook、CLI 和 shared 协议，且改变终端运行态契约。

## 架构 / 策略发现

### P1 Web mobile 仍保留本地状态推断，统一状态源没有真正覆盖 Web

当前决策：backend 的 mobile overview 只新增了 `displayStatus/displayStatusLabel`，但 shared `TerminalMobileOverviewSession` 没有携带完整 `TerminalState`；Web mobile 仍在 `buildMobileTerminalCards` 中基于 `activeCommand`、`command` 和 tail 变化调用 `inferTerminalState`，并用 `inferredWorkloadState` 驱动状态标签、筛选和项目汇总。

为什么它在系统层面可能是错的：这和本次“App/Web/CLI 只消费后端 TerminalState 判断 Stop、handoff 和展示”的目标冲突。用户在同一终端里看到的 App 详情、CLI handoff、Web mobile 列表会来自不同状态机：App/CLI 依赖 `/state`，Web mobile 仍依赖 tail/前台命令 heuristic。Codex hook 丢失、tail 静止、activeCommand 清空延迟时，Web mobile 可能继续显示 `agent_running`、`possibly_stuck` 或需要处理，而 App/CLI 已经认为是 `agent_idle/shell_idle`。

证据：

- `packages/shared/src/terminal-protocol.ts:238` 定义的 `TerminalMobileOverviewSession` 只有 `displayStatus/displayStatusLabel`，没有 `terminalState`。
- `backend/src/routes/terminal-mobile-overview.ts:84` 从 `TerminalStateService` 读状态，但 `buildDisplayStatus` 只把它折叠成三态展示字段。
- `frontend/src/features/terminal/mobile/terminal-card-view-model.ts:123` 仍调用 `inferTerminalState(...)`，`frontend/src/features/terminal/mobile/terminal-card-view-model.ts:144` 把结果写入 `inferredWorkloadState`。
- `frontend/src/features/terminal/mobile/MobileTerminalPage.tsx:182` 继续用 `card.inferredWorkloadState` 做筛选。
- `frontend/src/features/terminal/mobile/terminal-state.ts:33` 仍把 `claude/opencode/coco` 纳入 agent command heuristic，而本阶段目标是只支持 `codex`。

更好的候选方案：

1. 推荐：把完整 `TerminalState` 加进 `TerminalMobileOverviewSession`，Web mobile 的卡片状态、筛选、汇总都以该字段为准；tail heuristic 只作为“辅助说明/历史诊断”字段，不再驱动主状态。
2. 更简单方案：Web mobile 暂时只使用 backend 已有的 `displayStatus/displayStatusLabel`，删除或降级本地 `inferTerminalState`，先完成状态源收敛。
3. 平台/工具链方案：如果列表需要批量状态，新增 batch state/overview contract，而不是让 Web 复刻 backend 状态机。

迁移/过渡风险：Web mobile 的中文状态标签和筛选结果会变化，需要同步调整相关 UI 期望和 E2E；如果保留 tail heuristic 作为辅助字段，要明确它不能再影响主状态和操作入口。

## 代码 / 实现发现

### P1 `command="codex"` 被当作当前 Codex 状态来源，`activeCommand` 清空/变更可能无法把状态清回 `shell_idle`

为什么这是风险：计划中的核心语义是 `activeCommand=codex` 只表示“在 Codex CLI 内”，`activeCommand=null` 或非 Codex 要把状态推进到 `shell_idle`。当前实现把 session 的原始启动 `command` 也纳入 `isCodexSession`，导致只要 session 是以 `codex` 启动，即使 tmux 后续报告 `activeCommand="node"` 或清空，`setShellActiveCommand` 仍会保留/恢复 Codex 状态。这会让 Stop 按钮、handoff、mobile overview 在 Codex 已离开当前前台态后继续显示 agent 状态；hook route 的当前命令校验也会因为同一个 `isCodexSession` 放宽，继续接受非 SessionStart hook。

具体引用：

- `backend/src/terminal/terminal-state-service.ts:32` 先调用 `isCodexSession(sessionSnapshot)`，进入后会在 `backend/src/terminal/terminal-state-service.ts:33` 到 `backend/src/terminal/terminal-state-service.ts:39` 保留已有 Codex 状态或设为 `CODEX_IDLE`。
- `backend/src/terminal/terminal-state-service.ts:83` 到 `backend/src/terminal/terminal-state-service.ts:89` 的 `isCodexSession` 同时检查 `activeCommand` 和 `command`。
- `backend/src/routes/terminal-state.ts:106` 到 `backend/src/routes/terminal-state.ts:126` 的 hook 接受条件也使用 `isCodexSession(session)`，这会把同样的放宽逻辑带到 hook 写状态路径。
- `backend/src/terminal/terminal-state-service.test.ts:114` 到 `backend/src/terminal/terminal-state-service.test.ts:133` 明确把 `command="codex"` 且 `activeCommand="node"` 预期为 Codex idle/running，说明这不是偶然实现，而是被测试固化的行为。

可执行修复方向：让 `TerminalStateService` 的产品状态来源只接受 `activeCommand` 和 hook 事件；如果 tmux 下 Codex 子进程显示为 `node` 是真实兼容需求，应在 tmux metadata 读取层把“Codex CLI 的 node launcher”识别并转换成 `activeCommand="codex"`，或依赖 `SessionStart/UserPromptSubmit/Stop` hook 初始化状态，而不是让原始 `command` 永久参与当前态判断。对应补充一个回归测试：`command="codex"`、`activeCommand=null` 或非 Codex 时，active command 事件必须把状态清到 `shell_idle`。

## 验证记录

- `git diff --check -- . ':(exclude)docs/review'`：通过。
- `pnpm --filter ./backend test -- terminal-state-service terminal-state`：通过，60 个 backend test file / 382 tests 通过。
- `pnpm --filter ./backend typecheck`：通过。
- `pnpm --filter @runweave/app typecheck`：通过。
- `pnpm --filter @browser-viewer/shared typecheck`：通过。
- `pnpm --filter ./frontend typecheck`：通过。
- `pnpm --filter @runweave/cli test -- terminal`：通过。
- `pnpm --filter @browser-viewer/electron test -- hook-installer`：通过。

补充说明：首次尝试 `pnpm --filter @browser-viewer/runweave-cli test -- terminal` 时过滤器包名错误，输出为 `No projects matched the filters`；随后确认包名为 `@runweave/cli` 并重跑通过。

## 残余风险 / 测试缺口

- 未做浏览器页面复现；本轮是静态评审与命令验证。若要验证页面行为，必须按仓库约束使用 `$playwright-cli`。
- 现有测试覆盖了当前实现选择，但缺少“`command=codex` 时 activeCommand 清空/变更必须退出 agent 状态”的反向契约测试。
- Web mobile 状态收敛没有被现有 typecheck/test 捕获，因为协议层没有暴露 `TerminalState` 给列表卡片，UI 仍能在类型上自洽地使用旧 heuristic。
