# Multi-Agent Workspace Prototype

一次性 HTML + React 原型，用于收敛 **Multi-Agent 架构重构** 的核心意图。这一版把原型**套进 Runweave 真实的「项目 → 终端」架构**，让它更贴近产品现状：

- **顶部两行 tab（对齐真实终端页 chrome）**：第一行是**项目 tab**（Home + 项目切换 + 新建项目），第二行是**终端 tab**（当前项目下的终端 + 新建终端）。终端 tab 行只展示当前项目下的终端，和真实 `terminal-workspace-shell` 一致。
- **一个终端 = 一套 run**：Multi-Agent 的「run」不再是独立的顶部切换条，而是落到「终端」这一层——每个终端就是一套 Multi-Agent run，worker 就是这个终端里的 tmux split。
- **终端先是普通 shell，再显式开启流程**：新开的终端是普通 `zsh` 会话，右侧面板给一个「▶ 在此终端开启 engineering-rules 流程」入口；点了之后主 Agent 才接管，进入 `需求澄清 → 拆分提案 → 执行观测` 生命周期。
- **全屏终端主导布局**：左侧终端占据主体（核心），多个 Worker Agent 直接在同一个 tmux split surface 里跑；右侧面板被弱化成一个**观测 / log 面板**，只负责观察，不再承载繁重的流程细节。
- **可组合的流程**：需求讨论 / 计划 / 计划审批 / 代码执行 / 代码审查 / 人工验收 / 收尾 这些阶段不固定，可以按需开关组合（比如跳过计划审批，从计划直接到代码），由主 Agent 驱动推进。

这个原型不是产品合约，也不证明后端 / 协议 / 运行时已经支持。它只表达交互意图，供点、改、截图、收敛。

## 真实架构映射

| 原型元素                    | 真实产品对应                                  | 说明                                                    |
| --------------------------- | --------------------------------------------- | ------------------------------------------------------- |
| 顶部第一行项目 tab          | `terminal-workspace-shell.tsx` 顶部项目工具条 | Home 按钮 + 项目 tab + 新建项目，切项目会切下方终端列表 |
| 顶部第二行终端 tab          | `terminal-workspace-shell.tsx` 终端 tab 行    | 只展示当前项目下的终端；每个终端 = 一套 run             |
| 普通终端（plain）           | 新开终端默认的 shell 会话                     | 未开启流程，右侧是「开启流程」入口                      |
| 开启流程后的终端（flow）    | 主 Agent 接管的终端                           | 终端 tab 上带生命周期标签（澄清/提案/执行）+ 状态点     |
| tmux split 里的 worker pane | 同一终端 session 内的 tmux pane               | 由主 Agent 拆分产出                                     |

## 灵魂拷问收敛（原型 → 落地）

> 一轮针对「离实际落地还差什么」的灵魂拷问后的结论。这一版流程被定位成**全新的 agent-team / loop-engineer 流程**，**完全取代并废弃上一代 orchestrator**（`backend/src/orchestrator/*`、`packages/shared/src/orchestrator.ts`、前端 Orchestrator sidecar tab、`/api/orchestrator` 路由）——旧模块在落地时清理，不并存、不维护向后兼容。落地方案详见 `docs/plans/2026-07-03-agent-team-loop-engineer.md`。

### 已锁定的设计决策

1. **承载模型**：一个终端 = 一套 run；worker = 同一终端内的 tmux pane（底层 `tmux-service.splitPane()` 真实存在）。**不**沿用上一代 orchestrator「每个 worker 开独立 session」的默认。
2. **loop 信号**：以 A 方案（behavior_verify worker 按 markdown 验收用例操作 + 截图/DOM 断言）的结构化结论为信号源；`round`/`noProgress` 以 **per-run** 粒度计；「无进展」用客观信号优先（验收 pass 数是否上升、diff 是否变化、错误指纹是否重复），不叠一个会飘的 LLM 判官。
3. **熔断 → 接管 → 恢复**：熔断卡带**归因**（卡在哪个子循环、哪条用例、错误指纹）并**深链聚焦**到卡住的 pane；接管单位 = **per-run 暂停全部 worker pane**，落点是具体 pane（可手敲）；恢复时必须携带**人工干预 note**注入回 main agent 上下文，并重置错误指纹，避免恢复即复燃。
4. **验收证据回传**：扩展 worker outbox schema，加 `acceptanceResults: [{caseId, status, evidence[]}]`；失败用例的「抛回 code」由**编排层**决策发起（worker 之间零横向耦合）；A 方案非确定性，**起步即带去抖**——同一 caseId 连续 N 轮稳定 fail 才算真 fail，单轮 flip 不进 noProgress。
5. **可视终端的产品定位**：收敛为**「可信任放手 + 熔断精准介入」**，不是「多屏监工」。平时右侧 sidecar 给结论、pane 只读旁观且默认折叠/只高亮异常 pane；只有在熔断或人主动接管时，pane 才解锁手敲。可视化服务于「出事能钻进 pane 看真相」，而不是让人全程盯着 4 屏。
6. **崩溃 / 恢复**：暂列 backlog，不作为落地阻塞（tmux 现场本可 reattach/rebuild，遇到再优化）。

### 落地硬缺口（当前 shipping 代码为 0，方向已认可、待建）

1. `TerminalCompletionEvent`（`packages/shared/src/terminal-protocol.ts:399`）缺 `panelId`/`tmuxPaneId`——pane-as-worker 分不清是哪个 pane 完成，是 loop 拿信号的前置协议缺口。
2. loop 数据模型全缺——`loop{round,noProgressCount,maxNoProgress,escalated}`、错误指纹、去抖状态，全仓库只在本原型 JS 里存在。
3. pane 级「冻结 agent 循环、保留现场」能力缺——tmux 只能 kill/select pane，没有暂停 agent loop 的语义。
4. 「人工干预 note」结构 + 注入回上下文缺。
5. worker outbox 无 per-case pass/fail 结构（上一代 `OrchestratorWorkerOutbox` 仅 `artifacts`+free-text summary）。
6. A 方案去抖逻辑缺。
7. `rw propose-split` / Agent 主导触发链路缺——原型虚构，真实 `rw` 无任何编排命令。

## 启动

推荐用自带的 no-cache 服务脚本，**每次刷新都拿最新资源、无缓存**：

```bash
python3 docs/prototypes/multi-agent-workspace/serve.py 6189
```

打开：

```text
http://127.0.0.1:6189/
```

> `serve.py` 给所有响应加 `Cache-Control: no-store`；`index.html` 也带了 no-cache meta，`mock-state.json` 用 `?t=` 时间戳 + `cache: no-store` 兜底。普通 `python3 -m http.server` 也能跑，但可能命中浏览器缓存，需要强刷。

## 文件

- `index.html`：静态页面、样式和挂载点。样式含顶部两行 tab（项目/终端）+ 终端主导布局 + 右侧观测面板。
- `app.js`：React 原型逻辑（浏览器 ESM + htm，无构建）。项目/终端选择、普通终端 → 开启流程、以及流程三段面板。
- `mock-state.json`：模拟 project（多个）、terminal（每个终端一套 run，含 `mode: plain | flow`）、每个 flow 终端的生命周期（澄清/提案/执行）、终端 split 布局、log。
- `serve.py`：no-cache 静态服务脚本（原型辅助，不进入产品）。
- `prototype-preview.png`：浏览器验证截图（验证后保存）。

## 终端模式与流程入口

每个终端有一个 `mode`：

- **`plain`（普通终端）**：新开终端默认状态，就是一个 `zsh` shell。右侧面板是「▶ 在此终端开启 engineering-rules 流程」入口 + 说明。
- **`flow`（流程终端）**：点了开启后，主 Agent 接管本终端，进入下面三段生命周期。

## Run 生命周期（flow 终端）

flow 终端有三段生命周期，右侧面板按阶段切换职责：

1. **需求澄清 clarify**：主 Agent 与人对话澄清意图（人主导）。右侧是澄清对话 + 「自动确认拆分」开关。进入提案有两条路径：
   - **人主导**：人点「澄清完成 · 让主 Agent 拆分」。
   - **Agent 主导**：主 Agent 自己判断澄清充分，主动调 `rw propose-split` 触发提案（原型里用「▶ 模拟主 Agent 判断澄清充分」按钮演示）。后端置 `need_human`，前端轮询拿到 pending 提案后自动弹卡——复用现有 human-gate 那条触发链路。
2. **拆分提案 proposal**：主 Agent 产出「开 N 个 worker + 各自意图」的**可编辑提案**（增删/调整），**同时草拟一份验收用例（acceptance）**，人一并确认后才真正 split pane。**Worker 数量与验收用例由主 Agent 决定、人轻量把关**。
3. **执行观测 executing**：确认后左侧终端 split 出对应 worker pane（含 `behavior_verify` worker），右侧退回 `OBSERVE ONLY`，显示 **Loop 状态条**（轮次 + 无进展计数）+ **验收用例 + 证据** + log。

**自动确认拆分（`options.autoApproveSplit`）**：默认关，人确认拆分；打开后澄清完成直接 split、跳过 proposal 这道人工门——对齐代码里现有的 `autoApprovePlanGate` / `autoApproveVerifyGate` 配置模式。目标明确后，验收用例也随之自动采用，全程无需人介入。

**行为验证 worker（agent 盲区那层 + 意图对齐）**：在 `code_review` 和 `human_verify` 之间插一个 `behavior_verify` 阶段 + `behavior_verifier` 角色（挂 `playwright-cli`）。它读主 Agent 草拟、人确认的 markdown 验收用例（`.runweave/runs/<runId>/acceptance.md`，原型用 mock），跑 Playwright，把每条用例 pass/fail + 截图/DOM 证据写进 outbox evidence。**失败用例自动抛回 `code_agent`**，形成 `behavior_verify ↔ code` 子循环，这个子循环的每一轮喂进 noProgress 计数、被熔断管着。markdown 验收用例 = 被操作化的「澄清意图」，既验行为又验意图对齐——这就是「最后交给人的可验证产物」的来源。

> 起步用 A 方案：verify worker 直接按 markdown 用例操作 + 截图断言（灵活、快，但非确定性）。B 方案（先把 markdown 翻成 Playwright spec 再跑）作为后续增强，需与仓库「前端只留 E2E」约定对齐。

**无进展熔断升级（loop 的 escalation path）**：执行阶段把 loop 当一等公民观测。run 上有 `loop = { round, noProgressCount, maxNoProgress, escalated }`。这是 Loop Engineer 视角的关键补充——loop 自检（typecheck/lint/test）交给 agent 自己，**不重复护栏**；但 loop 需要一个「底」：连续 `maxNoProgress`（默认 3）轮无进展（reviewer / behavior_verify 反复 fail、同类错误修不动）就自动熔断，run 转 `need_human`、弹「已熔断 · 升级人工」卡，把卡住原因交回人，人介入后恢复 loop。这是 Loop Engineer 敢「放手」的前提。

> 注：本原型不实现「确定性自检断言」（typecheck/lint/unit），因为现在的 agent 改完代码会自发执行这些，用配置去提醒是反向的（退回 Harness Engineer）。loop 真正要闭的是 agent 盲区：行为/可观测性验证（Browser Use）、意图对齐、以及无进展熔断。

## 原型简报

- **用户目标**：在真实的「项目 → 终端」架构下驱动 Multi-Agent。终端一开始是普通 shell，需要时才在某个终端上开启 engineering-rules 流程；把注意力收回到「终端里真实发生的事」，右侧只做轻量观测；Worker 数量由主 Agent 按任务决定，不预先摆。
- **用户动作**：在项目 tab 之间切换；在项目下的终端 tab 之间切换；在普通终端里点「开启流程」；在需求澄清阶段与主 Agent 对话；审阅/微调主 Agent 的 worker 拆分提案并确认（或开自动确认跳过）；执行阶段看左侧终端、右侧 log。
- **主要流程**：选项目 → 选/建终端 →【plain】普通 shell →【开启流程】→【clarify】澄清意图 →【proposal】主 Agent 拆分提案 + 人确认 →【executing】split 出 worker pane，右侧 log 观测。
- **关键状态**：当前项目、当前终端、终端 `mode`（plain/flow）、flow 终端的 lifecycle（clarify/proposal/executing）与 status、`options.autoApproveSplit`、proposal 里的 worker 列表、每个终端的 split 布局、log 流。
- **明确非目标**：不实现真实 xterm / tmux / WebSocket / 后端 / LLM；不实现真实的项目/终端创建、增删改；不实现旧版右侧重流程面板里的逐项细节卡片；worker 数量不固定、不预配置。
- **影响的真实模块**：`frontend/src/components/terminal/`（terminal-workspace-shell、terminal-workspace、terminal-surface、terminal-preview-panel、orchestrator/_）、`packages/shared/src/orchestrator.ts`、`backend/src/orchestrator/_`。

## 产品核心功能（拟进入实施）

| 功能                        | 说明                                                                                                      |
| --------------------------- | --------------------------------------------------------------------------------------------------------- |
| 沿用项目 → 终端架构         | run 落到「终端」这一层：一个终端 = 一套 Multi-Agent run，套在真实的项目/终端 tab chrome 里                |
| 终端先普通、再显式开启流程  | 新终端是普通 shell（`mode: plain`）；在终端里显式开启 engineering-rules 流程后才进入 `flow`               |
| 全屏终端主导布局            | 左侧终端为主体核心，右侧面板弱化为观测区                                                                  |
| 需求澄清阶段                | 开启流程后第一阶段主 Agent 与人对话澄清意图，人主导                                                       |
| 主 Agent 决定 worker 拆分   | worker 数量/角色由主 Agent 在澄清后产出，不预先配置                                                       |
| 主 Agent 主动判断澄清充分   | 主 Agent 自己判断澄清够了，主动调 `rw propose-split` 弹提案（Agent 主导触发，复用 human-gate 链路）       |
| 拆分提案 + 人确认           | 提案可编辑（增删/调整），人确认后才 split pane                                                            |
| 自动确认拆分开关            | `options.autoApproveSplit` 配置项，开启则跳过人工确认直接 split                                           |
| Worker 进同一 split surface | 确认的 worker 在同一个终端 session 的 tmux split surface 内呈现                                           |
| 主 Agent 草拟验收用例       | 拆分提案时一并草拟 markdown 验收用例（acceptance），随拆分一起确认/自动采用                               |
| 行为验证 worker             | `behavior_verify` 角色读验收用例跑 Playwright，证据写 evidence；失败抛回 code agent（verify↔code 子循环） |
| 执行观测面板                | 执行阶段右侧 observe-only，承载 Loop 状态 + 验收用例/证据 + log，不承载重流程细节                         |
| 无进展熔断升级              | loop 连续 N 轮无进展自动熔断、`status=need_human` 升级人工，人介入后恢复（loop escalation path）          |

## 原型辅助功能（不进入产品实现）

| 功能                                                 | 说明                                                                                              |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 「+ 新项目」「+ 新建终端」生成的 mock 项目/终端      | 假数据，仅演示项目/终端 tab 切换；真实创建走产品既有链路                                          |
| 「▶ 在此终端开启流程」产出的固定 clarify 起手        | 演示 plain → flow 切换；真实开启流程/主 Agent 接管由产品链路驱动                                  |
| 「让主 Agent 拆分」按钮产出的固定 draft 提案         | 真实提案应由主 Agent 推理产出，这里是写死的演示数据                                               |
| 「▶ 模拟主 Agent 判断澄清充分」按钮                  | 模拟真实里 `rw propose-split` 被主 Agent 调用；真实触发来自主 Agent 自主判断，不是页面按钮        |
| 「✓ 有进展 / ✗ 无进展的一轮」按钮                    | 模拟 loop 反馈，真实里由 reviewer / behavior_verify worker 结果驱动 noProgress 计数，不是页面按钮 |
| 验收用例内容 + pass/fail/证据                        | 写死的演示用例与结果；真实里由主 Agent 草拟、behavior_verify worker 跑出                          |
| 「确认拆分」「加一个 worker」生成的 mock pane / 输出 | 假数据，演示 split 画面                                                                           |
| 澄清对话内容                                         | 写死的演示对话，不是真实 LLM 往返                                                                 |
| `serve.py`                                           | no-cache 本地服务脚本，仅用于开发原型                                                             |
| toast                                                | 仅原型反馈                                                                                        |

## 调整记录

- v0：左侧 tmux split 终端主导 + 右侧弱化 log/flow 观测面板 + 顶部多 run 切换条；flow 为可开关的组合式阶段。
- v1：去掉手动「派发 Worker」按钮。改为 run 三段生命周期（clarify → proposal → executing）：**worker 数量由主 Agent 在澄清后提案、人确认后才 split**；新增「自动确认拆分」配置开关可跳过人工门。右侧面板按生命周期切换（澄清对话 / 拆分提案 / observe-only log）。
- v2：clarify 阶段新增 **Agent 主导触发**——主 Agent 自主判断澄清充分、主动弹提案（原型用「▶ 模拟主 Agent 判断澄清充分」演示，对应真实的 `rw propose-split` 接口）。新增 `serve.py` no-cache 服务 + index.html no-cache meta + mock-state 时间戳兜底，确保刷新无缓存。
- v3（Loop Engineer 视角）：executing 阶段观测面板新增 **Loop 状态条 + 无进展熔断升级**。不加确定性自检断言（agent 自己会跑 typecheck/lint/test），只补 loop 的「底」：连续 `maxNoProgress`（默认 3）轮无进展自动熔断、升级人工、人介入后恢复。修单终端不撑满 canvas 的样式 bug。
- v4（行为验证闭环）：新增 `behavior_verify` 阶段 + 角色。proposal 卡加**验收用例草案**（主 Agent 草拟、随拆分确认或自动采用）；executing 加 **验收用例 + 证据**块（每条 pass/fail + 截图/DOM 证据，失败抛回 code agent）。左侧终端多一个 verify worker pane。这层补的是 agent 盲区（行为/可观测性验证）+ 意图对齐。
- v5（套进真实架构）：把顶部单一 run 切换条改成对齐真实终端页的**两行 tab**（项目行 + 终端行）。run 概念下沉到「终端」这一层——**一个终端 = 一套 run**，worker 是终端内的 tmux split。新增终端 `mode`：新终端先是**普通 shell（plain）**，右侧给「开启 engineering-rules 流程」入口，显式开启后才进入 clarify → proposal → executing。mock-state 从 `runs[]` 重构为 `projects[]` + `terminals[]`。
- v6（灵魂拷问收敛）：一轮「离落地还差什么」拷问后，新增「灵魂拷问收敛」章节，落定 6 条设计决策（承载模型 / loop 信号 / 熔断接管恢复 / 验收证据回传 / 可视终端定位 / 崩溃恢复 backlog）与 7 条落地硬缺口，并明确本流程是**全新 agent-team/loop-engineer 流程**，不受上一代 orchestrator 默认约束。落地方案见 `docs/plans/2026-07-03-agent-team-loop-engineer.md`。原型交互本身未改，仅补设计记录。

## 验证点

- 顶部两行 tab：第一行项目 tab（含 Home + 新项目），第二行是当前项目下的终端 tab（含新建终端）。切项目会切换下方终端列表。
- 普通终端（`shell`）：右侧是「▶ 在此终端开启 engineering-rules 流程」入口 + 说明；点击后终端转为 flow、进入 clarify。
- flow 终端 tab 上带生命周期标签（澄清/提案/执行）+ 状态点；三个 flow 终端分别处于 clarify / proposal / executing。
- clarify 终端：右侧是澄清对话 + 「自动确认拆分」开关；点「让主 Agent 拆分」进入 proposal。
- **Agent 主导**：点「▶ 模拟主 Agent 判断澄清充分」无需人点主按钮，直接 clarify → proposal 弹卡（自动确认开启时直达 executing）。
- 「自动确认拆分」打开后，clarify 直接跳到 executing 并 split pane，跳过 proposal。
- proposal 终端：worker 卡可增删，**下方有验收用例草案**，确认后进入 executing，左侧 split 出 main + 各 worker（含 verify）pane。
- executing 终端：右侧 `OBSERVE ONLY` 显示 Loop 状态条 + **验收用例/证据**（pass/fail + 失败抛回 code）+ log，左侧 split 终端含 `behavior_verify` pane。
- **无进展熔断**：连续点「✗ 无进展的一轮」到 `maxNoProgress`，终端转 `need_human`、弹「已熔断 · 升级人工」卡；点「✓ 有进展」清零计数；「恢复 loop」后熔断解除。
- no-cache：`curl -I http://127.0.0.1:6189/app.js` 返回 `Cache-Control: no-store`，刷新即拿最新资源。
