# Codex 与 TraeX 能力对齐测试案例

本文档把 Codex 与 TraeX 能力对齐的长期边界转成可执行、可取证、可追溯的验收合约。目标不是为各个表象分别打补丁，而是验证 Runweave 建立了 provider-neutral thread identity、TraeX lifecycle reader 与 provider reconciler，并由现有 Terminal、Activity、App Server、App Home、恢复和 readiness 消费链路共同使用。

## 范围

覆盖：

- TraeX Hook 原始身份字段与 `~/.trae/cli/sessions/**/*.jsonl` 中 `session_meta.payload.id` 的精确对应，禁止按 cwd 或时间猜测 thread ID。
- Terminal / Panel 的 current 与 last thread 同时保存 provider 和真实 thread ID。
- `task_started`、`task_complete`、`turn_aborted` 与未知 lifecycle 的读取、投影、补偿、幂等和恢复。
- App Server `/threads/:id`、Activity、App Home preview、Terminal history 对同一 TraeX thread 的一致消费。
- reader 暂时不可用时的 degraded fallback，以及恢复后与真实 thread 的单记录收敛。
- 隔离 Dev Session 内的 tmux 丢失恢复、Agent Team TraeX readiness 和普通 Terminal ready-prompt 兜底。
- Codex 既有 thread/read、补偿和恢复行为不回退。

不覆盖：

- 不改写 TraeX CLI 自身的 session 文件格式、Hook contract 或 TUI；这些是外部输入。
- 不用 cwd + 最近时间匹配作为兼容方案；评审已把它判定为不可接受的身份来源。
- 不穷举所有未知 `payload.type`；只验证未知类型被保留为 raw 且不会臆造状态。
- 不操作用户现有 tmux session，不在 Stable 用户现场制造中断；破坏性场景只允许在本次 patch 对应的隔离 Dev Session 中执行。
- 不新增单元测试文件；协议和状态机用仓库脚本/临时 Node 脚本取证，浏览器页面用 `$toolkit:playwright-cli` 取证。
- 不新增鉴权规则；既有受保护接口鉴权是回归前提，不是本次能力对齐的需求。

## 需求追溯

| 评审需求                                                  | 对应用例                                 |
| --------------------------------------------------------- | ---------------------------------------- |
| 阶段 0：确认 Trae Hook 原始身份字段；同 cwd 并发不得串线  | AGT-TRAE-001                             |
| 阶段 1：provider-neutral current / last thread identity   | AGT-TRAE-002、AGT-TRAE-004               |
| 阶段 2：Trae JSONL lifecycle、preview、turns、未知事件    | AGT-TRAE-002、AGT-TRAE-003、AGT-TRAE-006 |
| 阶段 3：provider reconciler、漏事件补偿、去重             | AGT-TRAE-003、AGT-TRAE-005、AGT-TRAE-007 |
| 阶段 4：Terminal、Activity、App Server、App Home、history | AGT-TRAE-002、AGT-TRAE-004               |
| tmux 丢失后 `traex resume <threadId>`                     | AGT-TRAE-008                             |
| Agent Team TraeX readiness gate                           | AGT-TRAE-009、AGT-TRAE-010、AGT-TRAE-011 |
| 普通 Terminal TraeX ready-prompt 兜底                     | AGT-TRAE-012                             |
| Codex 既有能力不回退                                      | AGT-TRAE-013                             |

## 前提事实

- 长期边界：`docs/architecture/app-server-event-center.md`、`docs/architecture/terminal-state.md` 与 `docs/architecture/multi-agent-orchestrator.md`。
- Hook bridge 与 metadata 同步必须保留 provider-aware thread identity，不能把 Trae family thread 退化成 `unknown` 或裸 ID。
- Terminal / Panel 持久化必须同时保存 current/last thread 的 provider 与真实 thread ID。
- App Server `/threads/:threadId`、App Home overview、Activity 与 Terminal history 必须消费同一 provider-aware ThreadRef。
- tmux 恢复必须按 provider 选择 resume 命令；TraeX 只允许在匹配 `provider=traex` 且存在真实 thread ID 时注入 `traex resume <threadId>`。
- readiness 必须同时覆盖 Agent Team TraeX worker 与普通 Terminal Trae family ready prompt；旧输出、错误 pane 或启动失败不能提前放行。
- TraeX 原始真值文件位于 `~/.trae/cli/sessions/**/*.jsonl`，thread ID 来自 `session_meta.payload.id`；当前观测到的最小 lifecycle 为 `task_started`、`task_complete`、`turn_aborted`。
- 真实行为验收必须先按 `$toolkit:runweave-change-validation` 在只包含本次 patch 的 source root 运行无显式 profile 的 `pnpm dev:session --dry-run --json`，再从 `pnpm dev:open --session <id> --surface <surface> --json` 解析 URL/CDP；不得复用 Stable、默认浏览器或无关 Playwright session。

## 必跑命令与停止规则

以下门禁按顺序执行，任一真实失败即停；静态门禁通过不能替代后续行为用例：

```bash
pnpm --filter ./packages/shared typecheck
pnpm --filter ./backend typecheck
pnpm --filter ./frontend typecheck
pnpm --filter ./electron typecheck
pnpm --filter ./packages/shared lint
pnpm --filter ./backend lint
pnpm --filter ./frontend lint
pnpm --filter ./electron lint
git diff --check
pnpm dev:session --dry-run --json
```

浏览器用例必须使用 `$toolkit:playwright-cli attach --cdp=<dev-open 返回的 endpoint>` 附着本次 Dev Session，并保存 DOM、截图或网络响应证据。后端、协议和 JSONL 用例必须保存可执行脚本命令、关键输出、目标文件摘要与 API 响应。验证结束必须关闭本次新建的 Browser tab、detach，并执行 `pnpm dev:stop --session <id>` 确认资源清理。

## 覆盖清单

- 功能正确性：AGT-TRAE-001 至 AGT-TRAE-013 覆盖评审列出的全部阶段和消费入口。
- 边界与异常：AGT-TRAE-003、AGT-TRAE-005、AGT-TRAE-006、AGT-TRAE-010、AGT-TRAE-011 覆盖缺 Stop、reader 不可用、未知事件、启动失败和交互阻塞。
- 状态与时序：AGT-TRAE-003、AGT-TRAE-007、AGT-TRAE-008 覆盖补偿、重复观察与重启恢复；AGT-TRAE-001 覆盖同 cwd 并发隔离。
- 数据与协议：AGT-TRAE-001、AGT-TRAE-002、AGT-TRAE-004 验证 Hook、JSONL、Terminal、Activity、App Server 与 UI 的同一 identity；敏感 token 不进入证据或日志。
- 安全与权限：不新增规则；本轮只要求测试脚本使用 Dev Session 提供的鉴权上下文，证据必须脱敏，不把 Authorization、Hook token 或原始用户 prompt 写入文档。
- 幂等与去重：AGT-TRAE-005、AGT-TRAE-007 覆盖 fallback 合并和重复 lifecycle/补偿观察。
- 回归与兼容：AGT-TRAE-013 守护 Codex；AGT-TRAE-005 守护 reader 降级期间既有 Hook fallback。
- 可取证性：每条用例都指定真实 JSONL、API、持久化、tmux pane 或 `$toolkit:playwright-cli` 证据；不接受只读代码或 typecheck/lint 作为通过依据。

## 测试用例

### AGT-TRAE-001 同 cwd 并发 TraeX 会话使用各自原始 thread ID

前置条件：

- 在隔离 Dev Session 中创建两个独立 tmux-backed terminal/panel，二者 cwd 完全相同。
- 两个终端均可启动 TraeX，且测试脚本可读取本次新建的 `~/.trae/cli/sessions/**/*.jsonl` 与脱敏 Hook bridge 日志。

步骤：

1. 记录启动前已有 TraeX session 文件清单，只在两个终端中并发启动新的 TraeX session。
2. 分别提交带唯一无敏感标记 `AGT_TRAE_A`、`AGT_TRAE_B` 的无害 prompt，等待两个 JSONL 都写出 `session_meta.payload.id`。
3. 读取两个终端对应的 Hook 请求、Terminal/Panel metadata 与新建 JSONL；按终端/panel/tmux pane 关联，不使用 cwd + 最近时间推断。
4. 查询两个真实 ID 的 App Server thread，并保存 ID 对应关系。

期望：

- 两个 Hook thread ID 分别精确等于各自 JSONL 的 `session_meta.payload.id`，且两个 ID 不相同。
- Terminal、Panel、App Server 和 Activity 对每个终端只使用该终端的真实 ID，`AGT_TRAE_A` 与 `AGT_TRAE_B` 不串线。
- 可取证日志只记录允许列表中的 identity/type 字段，不包含 Authorization、Hook token 或完整用户 prompt。

失败判定：

- 任一 Hook thread ID 为空、来自 cwd/时间猜测、与 JSONL ID 不一致，或两个并发会话共享同一 ID。
- 任一 Terminal、Panel、Activity 或 App Server 记录指向另一终端的 thread。
- 证据日志泄露 token 或完整 prompt。

标签：identity,concurrency,protocol

### AGT-TRAE-002 TraeX 正常完成后所有消费端收敛到同一真实 thread

前置条件：

- 在隔离 Dev Session 中创建一个新的 TraeX terminal，并已通过 AGT-TRAE-001 所验证的原始身份路径取得真实 thread ID。
- 可访问该 Dev Session 的 Terminal API、Activity API、App Server thread API 与 Web terminal 页面。

步骤：

1. 提交一个可确定完成的无害 prompt，记录对应 JSONL 中的 `task_started` 与 `task_complete`。
2. 等待本轮 lifecycle 被 reader/reconciler 消费后，查询 Terminal/Panel metadata、Activity、`/api/app-server/threads/<真实ID>` 与 App Home overview。
3. 使用 `$toolkit:playwright-cli` 附着本次 Dev Session，打开 Terminal history/status UI 并定位该真实 thread。
4. 对照各端的 provider、thread ID、状态、preview、turn/interaction 归属和 detailRef。

期望：

- Terminal/Panel current 或 last thread 同时标识 TraeX provider 与同一个真实 ID，不只保存无归属 ID。
- `/api/app-server/threads/<真实ID>` 返回 200，thread/provider/detailRef、preview 与 turn 列表来自该 JSONL；不存在 `unknown-thread:traex:*` 作为该会话的最终记录。
- Activity 的 query/response/lifecycle 事实携带同一 thread ID，能关联到本轮 turn；App Home 和 Terminal history 展示同一 preview/status。
- `task_complete` 后状态收敛为非 running，且 current/last 语义与 Codex 对应行为一致。

失败判定：

- 真实 ID 查询 404、任一消费端 thread ID/provider 不一致、Activity 仍为空 ID，或 UI 把记录显示成 unknown-thread。
- `task_complete` 后仍保持 running，或 preview/turn 来自其他 session。
- 只提供静态代码、typecheck/lint 或未附着目标 Dev Session 的浏览器证据。

依赖：AGT-TRAE-001

标签：happy-path,threadref,ui

### AGT-TRAE-003 缺失 Stop Hook 时 turn_aborted 驱动状态补偿

前置条件：

- 在隔离 Dev Session 中创建新的 TraeX thread，并能控制测试输入使其 JSONL 写出 `task_started` 后以 `turn_aborted` 结束。
- 测试过程阻断或丢弃该 turn 的 Stop/completion Hook，但不阻断 JSONL reader/reconciler。

步骤：

1. 启动一个会持续执行的无害 turn，确认 App Server 投影为 running。
2. 中断该 turn，确认 JSONL 最后 lifecycle 为 `turn_aborted` 且本轮没有 Stop/completion Hook。
3. 等待下一次已配置的 TraeX reconcile 周期完成，读取补偿事件、Terminal state、App Server thread 与 Activity。
4. 再等待一个 reconcile 周期，确认没有重复副作用。

期望：

- 第一个有效 reconcile 周期内，thread 从 running 收敛为 idle/interrupted，并产生带 provider、真实 thread ID、observed lifecycle 和 compensation reason 的可追溯补偿事件。
- Terminal、App Server 与 Activity 对 interrupted/idle 的表达一致；补偿不是伪造 Stop Hook。
- 第二个周期不重复写入同一补偿副作用。

失败判定：

- 一个完整 reconcile 周期后仍为 running，或只能依赖迟到 Stop 才恢复。
- `turn_aborted` 被映射为 completed、补偿丢失真实 ID/provider，或第二周期产生重复事件/通知。

标签：reconciliation,interruption,idempotency

### AGT-TRAE-004 同一终端从 Codex 切到 TraeX 时 current/last thread 保留 provider 归属

前置条件：

- 在隔离 Dev Session 的同一 terminal/panel 中先创建并完成一个 Codex thread，记录其 provider 与 ID。
- 随后在同一 terminal/panel 中启动新的 TraeX thread，记录其 JSONL 真实 ID。

步骤：

1. 在 Codex 完成后读取 Terminal/Panel current/last thread metadata 与 history。
2. 切换到 TraeX，提交一个无害 prompt，分别在 TraeX running 和完成后读取同样数据。
3. 查询两个真实 ID 的 App Server thread，并使用 `$toolkit:playwright-cli` 查看 App Home/Terminal history 的 provider 与 thread 展示。

期望：

- TraeX 运行时 current thread 是 `provider=traex + TraeX ID`；历史 Codex ID 始终带 `provider=codex`，不会被解释为 TraeX。
- TraeX 完成后 last thread 是 `provider=traex + TraeX ID`，同时历史列表仍可独立查询 Codex thread。
- 两个 App Server thread 均按各自 provider/detailRef 返回，Activity 和 UI 不混合两者的 preview/turn。

失败判定：

- 切换后仍把旧 Codex ID显示为当前 TraeX thread，或只保存裸 `lastThreadId` 导致 provider 不可判定。
- 任一 provider 的 preview、turn、Activity 或状态出现在另一个 thread 下。

标签：state-transition,provider-isolation,history

### AGT-TRAE-005 reader 暂时不可用时 fallback 降级并在恢复后合并到真实 thread

前置条件：

- 在隔离 Dev Session 中可临时让 TraeX lifecycle reader 无法读取本次 session 文件，但 Hook bridge 与 App Server/Backend 仍正常。
- 已记录恢复读取权限/可用性的安全步骤，且只作用于本次测试文件或隔离配置。

步骤：

1. 暂时使 reader 不可用，启动新的 TraeX turn 并让正常 Hook 到达。
2. 查询 Terminal、App Server 与 Activity 的 fallback 状态和可见降级信息。
3. 恢复 reader，等待一次 reconcile，查询真实 JSONL ID、thread 列表与各消费端。
4. 重复触发一次 reconcile，检查记录数量与事件去重。

期望：

- reader 不可用期间 Hook 主流程仍成立，fallback 明确标识 degraded/identity unresolved，不伪装成真实 thread。
- reader 恢复后，fallback 的可归属数据合并到 JSONL 真实 ID，最终只有一条权威 thread；Terminal、Activity 和 App Server 都改用真实 ID。
- 重复 reconcile 不重新创建 fallback、真实 thread 或重复通知。

失败判定：

- reader 不可用导致 Hook 主流程完全失败，或 fallback 没有 degraded 标识。
- 恢复后永久保留 fallback 与真实 thread 两条记录、丢失已有事件，或重复 reconcile 增加重复副作用。

标签：degraded,recovery,deduplication

### AGT-TRAE-006 未知 lifecycle 类型保留 raw 且不臆造状态迁移

前置条件：

- 在隔离 fixture 或本次 Dev Session 的测试 session 文件中可追加一个唯一未知 `payload.type=agt_unknown_lifecycle` 事件。
- 追加前 thread 已处于可明确判断的 idle 状态，并已记录最后已知 lifecycle cursor。

步骤：

1. 写入合法 JSONL 事件，payload type 为 `agt_unknown_lifecycle`，并保留唯一 event/cursor 标识。
2. 触发 reader/reconciler，读取 thread detail、raw event/cursor、状态与日志。

期望：

- 未知事件可通过 thread detail 或诊断证据按 raw 形式追溯，cursor 正常前进。
- thread 保持写入前的已知状态，不被映射为 running、completed、interrupted 或其他臆造状态。
- 日志至多记录一次明确 warning，不把预期内未知事件记为不可恢复 error。

失败判定：

- 未知事件被丢弃且无法追溯、导致 reader 崩溃/停止后续消费，或改变 thread 状态。
- 同一未知事件在重复扫描中持续产生重复 warning/副作用。

标签：compatibility,unknown-event,raw-data

### AGT-TRAE-007 重复观察同一 lifecycle 不产生重复补偿副作用

前置条件：

- 在隔离 Dev Session 中准备一个具有稳定真实 thread ID、last projected event ID 与最后 lifecycle 的 TraeX session。
- 能连续触发至少两次 reader/reconciler 扫描而不修改该 JSONL。

步骤：

1. 记录第一次扫描前后的 App Server event、Activity fact、completion notification 与 thread projection 数量。
2. 在输入完全不变时再次触发扫描。
3. 对照 dedupe identity 与两次扫描后的持久化数量。

期望：

- dedupe identity 至少区分 `provider + threadId + lastProjectedEventId + observedLifecycle`。
- 第二次扫描不新增相同补偿事件、Activity fact、通知或 thread 记录，已有状态保持不变。

失败判定：

- 相同输入重复产生补偿、Activity、通知或重复 thread。
- 不同 provider 或不同 thread 使用相同 dedupe identity 而互相吞掉合法事件。

标签：idempotency,deduplication,persistence

### AGT-TRAE-008 tmux 丢失后只为匹配的 TraeX thread 注入 resume 命令

前置条件：

- 仅在隔离 Dev Session 中创建 interactive-shell launch 的 TraeX terminal，保存 `provider=traex + 真实 thread ID`，并归档销毁前 manifest/scrollback。
- 明确目标 tmux session/pane 属于本次 Dev Session；用户现有 terminal 不在操作范围。

步骤：

1. 安全销毁目标隔离 tmux session，保留 Runweave terminal 记录。
2. 通过产品的 terminal 恢复入口触发 runtime rebuild，捕获新 pane 输入与恢复日志。
3. 等待 TraeX 恢复并查询 Terminal/App Server thread。
4. 另建一个 provider 不匹配或 thread ID 为空的隔离样本，重复恢复入口。

期望：

- 有匹配 provider/真实 ID 的样本只注入一次 `traex resume <真实ID>`，恢复后的 Terminal/App Server 继续指向同一 thread。
- provider 不匹配或 ID 为空的样本不注入 TraeX resume 命令，并返回可定位的安全降级/错误。
- 恢复日志包含 terminal/session/thread 的脱敏关联信息，不泄露 token。

失败判定：

- 触及非本次 Dev Session 的 tmux、注入错误 ID/错误 provider 命令、重复注入，或恢复为新 thread。
- 缺 ID 时仍猜测 session 并执行 resume。

标签：tmux,recovery,boundary

### AGT-TRAE-009 TraeX TUI 真实 ready 后 Agent Team 才派发任务

前置条件：

- 在隔离 Dev Session 中配置 Agent Team worker command 为 TraeX，并准备可稳定出现的真实 TraeX ready prompt。
- 能捕获 worker pane scrollback、readiness 日志与首次任务输入时间顺序。

步骤：

1. 启动 TraeX worker，持续捕获 pane scrollback 与 Agent Team 状态。
2. 在 ready prompt 出现前后分别记录是否已派发 worker intent。
3. 等待 worker 接收唯一无害任务标记。

期望：

- ready prompt 出现前 worker 保持 starting/等待态，没有收到任务标记。
- 识别真实 ready 后才转为 ready/idle 并恰好派发一次任务；状态顺序和 pane 输入可取证。

失败判定：

- 启动命令发出后立即派发任务、未识别 ready 即放行，或 ready 后重复派发。
- 只凭固定 sleep 判 ready，没有验证 pane 的可观察状态。

标签：agent-team,readiness,happy-path

### AGT-TRAE-010 TraeX 启动失败时 Agent Team 阻止任务派发并给出错误

前置条件：

- 在隔离 Dev Session 中为单个测试 worker 配置一个可确定失败的 TraeX 启动条件，且不会影响用户环境。
- 能捕获 worker pane、API 响应、run JSON 与 Agent Team 日志。

步骤：

1. 启动该 worker 并等待 readiness 的失败/超时终态。
2. 检查 pane 输入、run phase/status、worker dispatch 和错误信息。

期望：

- worker intent 从未发送到失败的 TUI，run 不把该 worker 标记为 executing/ready。
- API/UI 返回包含 agent、worker/pane 与启动失败原因的可定位错误，不把失败降级成 ready。

失败判定：

- 启动失败仍派发任务、run 继续执行且无错误，或只记录无法定位的通用失败。

标签：agent-team,readiness,error-path

### AGT-TRAE-011 TraeX 停在交互提示时 Agent Team 不把提示误判为 ready

前置条件：

- 在隔离 Dev Session 中可让 TraeX 启动后停在一个真实交互提示，且该画面不等于 ready prompt。
- 能捕获 pane scrollback、readiness 判定与 worker 输入。

步骤：

1. 启动 TraeX worker并让其停在交互提示。
2. 等待 readiness gate 完成其识别/超时流程，期间检查是否派发 intent。
3. 若产品定义了安全自动处理的提示，则执行一次该分支并继续观察到真实 ready；否则保持阻止态。

期望：

- 交互提示不被误判为 ready，提示未解决前不派发 worker intent。
- 只有进入真实 ready UI 后才允许一次派发；不可自动处理时返回明确阻塞原因。

失败判定：

- 交互提示出现时任务已被输入、提示文本被当作 ready pattern，或超时后静默继续执行。

标签：agent-team,readiness,interactive-prompt

### AGT-TRAE-012 普通 Terminal 从 TraeX ready prompt 收敛为 agent_idle

前置条件：

- 在隔离 Dev Session 中创建普通非 Agent Team TraeX terminal。
- 使 metadata 暂时仍为 `agent_starting`，同时 pane scrollback 已出现真实 TraeX ready prompt。

步骤：

1. 触发 Terminal state refresh/overview 查询，记录 refresh 前后的 session/panel state。
2. 使用 `$toolkit:playwright-cli` 查看 Terminal UI 的状态标签。

期望：

- ready-prompt fallback 把 session/panel 从 `agent_starting` 收敛到 `agent_idle`，provider 保持 TraeX。
- Web UI 显示 idle/ready，不需要额外 Hook 才纠正状态。

失败判定：

- 已有真实 ready prompt 时仍长期显示 starting，或被误判为 running/shell idle/其他 provider。
- 只在 Agent Team 路径生效，普通 Terminal 不收敛。

标签：terminal-state,readiness,ui

### AGT-TRAE-013 Codex thread、补偿与 tmux 恢复行为不回退

前置条件：

- 在同一隔离 Dev Session 中创建一个新的 Codex thread，不复用用户现有 thread。
- 可访问 Codex thread/read、Terminal/App Server/Activity，并可在隔离样本上安全验证 tmux loss。

步骤：

1. 完成一个 Codex turn，核对真实 thread ID、preview、Terminal current/last、App Server detailRef 与 Activity。
2. 制造一次仅缺 Stop 的可控状态差异，等待现有 Codex compensator 收敛并检查去重。
3. 在另一个隔离 Codex terminal 中销毁目标 tmux，触发恢复并捕获 resume 命令。
4. 使用 `$toolkit:playwright-cli` 查看 App Home/Terminal history 的 Codex thread 展示。

期望：

- Codex 继续使用原有 thread/read 取得真实 ID、状态和 preview，provider-neutral 改动不改变其可观察语义。
- Codex compensation 仍能收敛且不重复；tmux 恢复仍只注入一次 `codex ... resume <真实ID>`。
- UI 和 Activity 不被 TraeX provider 数据污染。

失败判定：

- Codex 真实 thread 查询、preview、补偿、resume 或 UI 任一回退。
- provider-neutral 迁移把 Codex ID 误归属为 TraeX，或产生重复记录/通知。

标签：regression,codex,compatibility

## 验收通过标准

必须同时满足：

- 静态门禁与 `git diff --check` 全部通过，但不以此替代行为证据。
- AGT-TRAE-001 至 AGT-TRAE-013 全部 PASS；任一必跑用例真实失败即停止本轮并回传对应 case ID。
- 每条 PASS 都有目标 Dev Session 的真实 JSONL/API/持久化/tmux 或 `$toolkit:playwright-cli` 证据，且能从 case ID 追溯到本文件和输入评审。
- 同 cwd 并发、reader 降级恢复、缺 Stop 中断、tmux 丢失和 readiness 三分支均在隔离环境完成，没有操作用户现有 terminal/tmux。
- 最终不存在用默认泛化 acceptance、cwd/时间猜测 identity、静态检查或无关浏览器 session 代替真实验收的情况。
- 验收结束已关闭本次新建 tab、detach Playwright，并停止 Dev Session，确认 dedicated 资源清理。
