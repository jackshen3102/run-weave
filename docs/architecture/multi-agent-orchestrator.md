# Agent Team / Loop Engine

Agent Team 让当前终端里的主 Agent 调度同一 tmux session 内的 worker pane。它的稳定边界是“终端里的 CLI agent + 后端薄路由 + pane 级任务包状态”，不是服务端直接调用 LLM API。

`multi-agent-orchestrator.md` 这个文件名保留给旧链接；当前模块名、路由和数据模型都以 `agent-team` 为准。

## 当前架构

核心组成：

- 主 Agent pane：绑定当前 terminal session 的主 pane，持有本次 run 的上下文，并通过 Agent Team sidecar 推进拆分和执行。
- Worker pane：按角色运行在同一 tmux session 的额外 pane 中，完成后通过 completion hook 和 outbox 回传 summary 或验收结果。
- 后端结果路由器：消费 terminal completion 事件，按 run/worker/pane 匹配 outbox，把结果折叠回 Agent Team run。
- 任务包：保存在项目 `.runweave/agent-team/<runId>.json`，是 UI、后端恢复和人工介入的共享状态源。

后端只负责状态守卫、pane 创建、prompt 注入和 completion/outbox 路由，不替主 Agent 做智能决策。worker 完成结果先进入结构化 outbox，再由 Agent Team 服务按当前 phase 和 loop 状态处理。

Loop 的完成信号来自 backend terminal completion feed：AI CLI hook 通过
`/internal/terminal-completion` 记录 `kind="completion"` terminal event，后端结果路由器再按
run、worker、pane 和 outbox 匹配。app-server Event Center 中的 `agent.completion` 当前只用于
ThreadRef 投影和受限 TerminalState Stop fallback，不会写入 completion feed，也不会直接推进
Agent Team loop。

## 默认角色

当前角色集合面向 Loop Engineering：

| roleId            | 职责                                               |
| ----------------- | -------------------------------------------------- |
| `code`            | 执行代码或文档改动。                               |
| `code_review`     | 复核改动，输出可执行的审查结论。                   |
| `behavior_verify` | 跑浏览器/行为验收，把通过、失败和证据写回 outbox。 |

worker 角色定义在 `packages/shared/src/agent-team.ts`；prompt 构造在 `backend/src/agent-team/prompt-builders.ts`。Agent Team 不再使用旧 `coder`、`reviewer`、`tester` 默认集合。

## 验收来源

Agent Team 的 `behavior_verify` 不再把后端泛化默认句子当作可执行验收合同。启动 run 时可以传入 `planFilePath` 和 `testCaseFilePath`；测试案例文件优先级最高，计划文件只作为主 Agent 生成测试案例的输入。

测试案例文件必须位于当前 project 的 `docs/testing/` 下，并以 `.testplan.yaml` 结尾；支持项目内相对路径或解析后仍在项目内的绝对路径。后端按 `docs/testing/test-plan-format.md` 严格解析最小 YAML schema，不兼容 Markdown 测试案例。只有 `required: true` 的 case 会进入 Agent Team acceptance；解析后的 acceptance 保留 `sourceCaseId`、`sourceFilePath` 和 `sourceHeading`，因此 UI、run JSON、worker prompt 和 outbox 都能追溯到同一个测试案例来源。

没有 `testCaseFilePath` 时，run 会先进入需要主 Agent 生成验收文件的状态：

- 有 `planFilePath`：主 Agent 应基于计划文件生成 `docs/testing/**/*.testplan.yaml`，再用 `generatedTestCaseFilePath` 提交拆分提案。
- 没有 `planFilePath`：主 Agent 应基于任务描述生成 `docs/testing/**/*.testplan.yaml`，再提交拆分提案。

如果拆分提案没有提供可解析的测试案例文件，后端会拒绝进入 worker split，而不是回退到旧的“核心改动按任务目标落地 / 关键回归用例通过”默认 acceptance。`behavior_verify` prompt 会逐条带上来源文件和 case ID；修复后的复验范围由 Loop Engine 根据失败、未执行、依赖和影响面收敛，不默认把所有已通过 case 全量重跑。

## 生命周期

一个 terminal session 同一时间最多绑定一个 active Agent Team run。run 的主状态为：

```text
intake
→ proposal
→ executing
```

稳定规则：

- 创建 run 后进入 `proposal`，状态为 `need_human`；`options.autoApproveSplit=true` 时直接进入 `executing`。
- 主 Agent 或用户仍可通过提案接口调整拆分提案。
- 人工确认拆分后创建或复用 worker pane，绑定 worker role、alias、`panelId` 和 `tmuxPaneId`，再向 worker pane 注入启动 prompt。
- `executing` 状态下，`behavior_verify` 的验收结果和代码 diff 作为 loop 进展信号。
- 开启本地 review checkpoint 时，每轮 `code_review` 通过后先形成 checkpoint commit；所有行为用例通过后，还要对任务基线到最新 checkpoint 做一次 final full review，才能结束 run。
- 连续无进展达到 `maxNoProgress`（默认 3）时触发熔断，run 进入 `need_human`，worker 冻结。
- `options.notifyMainOnHumanGate` 默认开启；run 首次进入 `need_human` 时通知主 Agent，但不授权 Agent 绕过拆分审批、finding disposition 等人工门禁。
- 人工 note 恢复后清空重复失败 fingerprint，重新计数，并把 note 注入主 Agent 上下文。

## Loop Engine

Agent Team 的 Loop Engine 由 `backend/src/agent-team/loop.ts` 维护：

- `round`：验收轮次。
- `bestPassCount`：历史最高通过数量，作为客观进展信号。
- `errorFingerprints`：归一化失败签名，用来识别重复失败。
- `noProgressCount` / `maxNoProgress`：无进展熔断计数。
- `stableFailThreshold`：同一 case 连续失败达到阈值后才反弹给 code pane。

当 stable fail case 尚未反弹时，后端会通过 `buildBounceBackPrompt` 注入 code worker pane；当验收通过数提升或出现明确 diff 进展时，无进展计数会清零。熔断只冻结后续自动注入，不删除 pane 或 outbox，方便人工聚焦现场。

## 修复交接与预算

`code_review` 或 `behavior_verify` 失败回弹后，Code Agent 不能只用 `status="completed"` 进入下一道门禁。后端会先建立 backend-owned `repairKey`，并要求当前 code outbox 的 `fixVerifications` 恰好覆盖这些 key。behavior 失败使用 `behavior_verify:<caseId>`；review 阻断项使用 `code_review:<invariantKey>`，其中 open P0/P1 finding 必须带稳定 `invariantKey` 和 `verificationMode: "runtime" | "structural"`。

runtime 修复交接必须记录真实产品复现、同场景 After 验证、`scenarioId`、`validationSessionId` 和证据；structural 修复可以使用 reviewer 给出的 harness 或静态契约证据，但必须复跑原证据入口。`fixVerifications` 只表示“可以交给独立 gate 复验”，不能让 code worker 给自己的修复判定 acceptance pass。缺失、过期、阻塞或不匹配的交接只允许一次 outbox 协议补交，仍无效则进入 `need_human`。

修复次数由 `loop.repairCycles` 单独计数，默认 `maxRepairAttempts=3`，create-run 只能设置 1 到 5。任意 diff、`noProgressCount`、`recheckAttempt` 或 verifier timeout 都不能重置同一 repairKey 的预算。第 2 次及以后处理同一 repairKey 时，code outbox 必须包含 `strategyAssessment`，说明上一轮机制为何失败以及是否需要调整状态所有权、事件边界或数据模型。同一 repairKey 达到预算后仍被独立 gate 判失败，run 进入 `need_human` 并保留各轮 handoff、review/behavior 失败摘要和当前现场。

## Review Checkpoint

`options.reviewCheckpointMode="local_commit"` 是显式开启的本地 Git checkpoint 模式；默认 `disabled`，不会改变现有 run。开启时后端先要求项目处于 Git 分支且工作区干净，再从当前 HEAD 创建 run 专属分支 `runweave/agt-<runId>`。checkpoint 只保留在本地，不 push、不 squash，也不替代后续正式提交或 PR 门禁。

review 范围由后端生成并写入 worker dispatch，reviewer 必须在 pane-scoped outbox 中原样回传：

- `full`：第一次 review，范围为任务基线到当前暂存树。
- `incremental`：后续修复 review，范围为上一 checkpoint 到当前暂存树。
- `final`：行为用例全部通过后，复核任务基线到最新 checkpoint；不再生成新 commit。

后端是唯一允许执行 Git 写操作的一方。它只用参数化 Git 命令暂存本次代码变化，排除 `.runweave/**` 和 `docs/review/**`，并拒绝敏感文件与超大未跟踪文件。review 通过后还会再次校验分支、HEAD、index tree 和未暂存漂移，再创建带 run/round/reviewer trailer 的 checkpoint commit。重启恢复时按 trailer 查找已经创建但尚未写回 run JSON 的 commit，避免重复提交。

`behavior_verify` 只允许验证 prompt 指定的 checkpoint SHA，并在 outbox 中回传 `verifiedCheckpointCommit`。计划文件和测试案例文件在 run 启动时记录 SHA-256；来源变化、外部 HEAD 漂移、工作树出现 checkpoint 之外的代码，或 worker 回传范围/SHA 不一致时，run 都会 fail closed 到 `need_human`。

## API 边界

主要 HTTP 入口位于 `/api/agent-team`：

- `GET /runs?projectId=...&terminalSessionId=...`：读取项目或当前 terminal session 的 run。
- `GET /runs/:runId`：读取单个 run。
- `POST /runs`：在指定 terminal session 上创建 run，可携带 `planFilePath` / `testCaseFilePath`，并可显式设置 `options.reviewCheckpointMode="local_commit"`。
- `POST /runs/:runId/propose-split`：提交主 Agent 或用户产出的拆分提案，可携带 `testCaseFilePath` / `generatedTestCaseFilePath` 生成可追溯 acceptance。
- `POST /runs/:runId/split-gate`：确认或驳回拆分提案。
- `POST /runs/:runId/resume`：人工 note 介入并恢复 loop。
- `POST /runs/:runId/focus-pane`：聚焦属于该 run 的主 pane 或 worker pane。
- `GET /runs/:runId/export`：导出复盘包，供 CLI 和人工排障读取 run、pane、outbox、history tail 与验收摘要。

旧 `/api/orchestrator/*`、Orchestrator 前端 tab 和 shared `orchestrator` 类型已下线；当前 UI 入口是 Terminal tab 右键打开 Agent Team，并在右侧 sidecar 显示 Agent Team tab。

CLI 复盘入口：

```bash
rw agent-team export <runId> --tail 1000 --json
rw agent-team export --project-id <projectId> --terminal-session-id <terminalSessionId> --history none --json
rw agent-team export <runId> --plain
```

导出结果用于回看一次 run 的任务包、run-bound panels、session-other panels、pane-scoped outbox、legacy session outbox、acceptance summary 和 warnings。它不替代可见终端流程，也不自动提交、push 或发布代码。

## 约束和风险

- Agent Team 依赖真实终端 agent、tmux pane、completion hook 和 outbox。hook 缺失或 outbox 缺 pane/run 标识时，结果不会可靠回流。
- pty runtime 不支持 worker pane split；Agent Team 主流程应运行在可 split 的 tmux terminal session 上。
- 结果路由器只按结构化 outbox、pane metadata 和任务包匹配，不判断 worker 输出质量。
- active run 会保留 Agent Team tab；禁用 panel split 只能隐藏普通控制条，不能让 active run 从 UI 中消失。
- 同一项目同一时间最多运行一个启用 review checkpoint 的 active run，避免多个 run 争用分支和 index。
- checkpoint commit 不是正式发布：push、PR、合并以及正式 hooks 仍应由主 Agent 或指定终端在可见流程中完成，不能绕过人工验收或熔断恢复。
