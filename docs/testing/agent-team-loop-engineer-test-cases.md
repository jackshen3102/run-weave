# Agent Team / Loop Engineer 测试案例

本文档是 Agent Team / Loop Engineer 的长期测试案例源文件。它基于当前本地代码和 `feat: add agent team loop engineer` 后续增量，覆盖新 `agent-team` 模块取代旧 `orchestrator` 后的真实用户流程、session 级 panel split 开关、agent readiness、pane-as-worker 执行模型、loop 熔断恢复和旧能力回归。

## 测试原则

- 只验证真实场景：必须启动真实 Runweave Web 或 Electron 桌面端，经过项目、终端、sidecar、tmux pane、hook/outbox、浏览器验收等用户可见链路完成验证。
- 浏览器页面验证必须使用 `$playwright-cli`；桌面端、系统弹窗、安装器、Electron 页面和终端页面联动可以使用 `$computer-use`，必要时两者组合。
- 禁止新增或依赖单测、Vitest、Node test、纯函数脚本、`tsx` 冒烟、mock service 单测或任何只验证内部函数的测试逻辑。
- CLI、HTTP、文件修改只能作为环境布置或辅助观测；最终通过依据必须来自浏览器或 Computer Use 看到的 UI、DOM、截图、终端画面、真实 hook 事件和真实 outbox 结果。
- 每个用例都要留下证据：截图或 DOM 摘要、关键终端画面、run 状态 JSON 片段、outbox 文件片段、事件日志片段。证据应能说明用户是否真的完成了该场景。
- 失败用例不直接归咎于实现缺陷；先记录可复现步骤、现场证据、期望和实际差异，再判断是缺陷、设计缺口还是测试环境问题。

## 被测契约

实现范围：

- 一个终端 session 绑定一套 Agent Team run；`projectId` 是存储命名空间，`terminalSessionId` 是实例绑定维度。
- Agent Team 入口不是全局常驻 tab；它依赖当前 terminal session 处于可运行的 tmux/panel 状态，并通过终端 tab 右键菜单打开。打开时会把 `panelSplitEnabled` 写入后端 session metadata。
- `panelSplitEnabled` 是服务端 session 状态，不再是浏览器 localStorage 偏好；刷新、换浏览器或 Electron 连接同一 backend 时应保持一致。
- run 生命周期：普通终端 -> 开启流程 -> `clarify` -> `proposal` -> `executing` -> `need_human` -> resume。
- run 会记录 `terminal` 配置；默认 agent command 是 `codex`，启动主 Agent 和 worker pane 前会先确保目标 pane 的 Codex UI ready，并自动处理 Codex trust prompt。
- worker 运行在同一 terminal session 的 tmux pane 中，而不是为每个 worker 创建独立 terminal session。
- `behavior_verify` worker 通过真实完成事件和 outbox 写入 `acceptanceResults` 推进 loop。
- loop 用 pass 数上升或实际 diff 作为进展信号；稳定 fail 进入 no-progress 计数；连续无进展后熔断升级人工。
- 熔断后右侧面板提供归因、pane 聚焦和人工 note 恢复；恢复会把 note 注入主 Agent 上下文。
- 旧 `orchestrator` 路由、类型、前端 tab 和订阅链路下线，用户入口切换为 Agent Team。

关键代码锚点：

- `packages/shared/src/agent-team.ts`
- `backend/src/agent-team/agent-readiness.ts`
- `backend/src/agent-team/service.ts`
- `backend/src/agent-team/loop.ts`
- `backend/src/agent-team/outbox-resolver.ts`
- `backend/src/routes/agent-team.ts`
- `backend/src/routes/terminal.ts`
- `backend/src/routes/terminal-completion.ts`
- `backend/src/routes/terminal-panel-routes.ts`
- `frontend/src/components/terminal/terminal-agent-team-panel.tsx`
- `frontend/src/components/terminal/terminal-workspace-shell.tsx`
- `frontend/src/services/terminal.ts`
- `packages/runweave-cli/src/commands/terminal-agent.ts`
- `electron/resources/hooks/runweave-hook-payload.cjs`
- `plugins/toolkit/hooks/runweave-hook-payload.cjs`

## 测试环境

建议使用临时 Runweave 配置、临时项目目录和临时终端，避免污染真实项目。

```bash
export RUNWEAVE_CONFIG_FILE="$(mktemp -d)/runweave-config.json"
export RUNWEAVE_BACKEND_PORT="${RUNWEAVE_BACKEND_PORT:-5001}"
export RUNWEAVE_BASE_URL="${RUNWEAVE_BASE_URL:-http://127.0.0.1:${RUNWEAVE_BACKEND_PORT}}"
export RW_BIN="node packages/runweave-cli/dist/index.js"
```

启动建议：

```bash
pnpm dev
$RW_BIN auth login --base-url "$RUNWEAVE_BASE_URL" --username admin
```

预检命令可以帮助排除构建问题，但不能替代最终验收：

```bash
pnpm --filter ./packages/shared typecheck
pnpm --filter ./backend typecheck
pnpm --filter ./frontend typecheck
pnpm --filter ./frontend lint
git diff --check
```

## 证据规范

每轮执行至少记录：

- 被测 URL 或 Electron 页面位置。
- 项目名、项目路径、`projectId`、`terminalSessionId`。
- Agent Team 当前 `runId`、`phase`、`status`、`loop.round`、`loop.noProgressCount`。
- `$playwright-cli` 截图或 DOM 摘要；桌面端流程则记录 `$computer-use` 截图。
- tmux pane 画面：main pane、code pane、behavior_verify pane 的可见 prompt 或 marker。
- 若涉及 completion/outbox：`.runweave/outbox/*.json` 内容片段、completion 事件片段、右侧面板对应 UI 变化。

通过判断优先级：

1. 用户可见 UI 与终端画面。
2. 真实事件和 outbox 结果。
3. 后端 run JSON 和日志。
4. CLI/API 返回值只能作为辅助，不作为单独通过依据。

## 入口与 Panel Split 用例

### AGT-ENTRY-001 默认不显示 Agent Team tab

步骤：

1. 用 `$playwright-cli` 打开 Web terminal workspace。
2. 创建或选择一个新 tmux terminal session。
3. 确认该 session 的 `panelSplitEnabled=false`。
4. 打开右侧 sidecar。

期望：

- sidecar tab 只显示 Preview、Browser，不显示 Agent Team。
- 顶部下拉菜单不再提供 Agent Team 入口。
- 项目目录下还没有新的 `.runweave/agent-team/*.json`。
- 左侧终端仍是普通 shell，没有自动注入 Agent Team prompt。

### AGT-ENTRY-002 终端 tab 右键打开 Agent Team

步骤：

1. 在 tmux terminal session 的 tab 上右键。
2. 点击 `Agent Team` 菜单项。
3. 观察右侧 sidecar 和 panel target bar。
4. 刷新页面后重新进入同一 terminal。

期望：

- 右键菜单中出现 `Agent Team`，且只有可运行的 tmux/panel session 才出现该项。
- 点击后写入服务端 `panelSplitEnabled=true`，右侧 sidecar 自动打开 Agent Team tab。
- 右侧显示“这是一个普通终端”和“在此终端开启 engineering-rules 流程”按钮。
- 刷新后 `panelSplitEnabled` 保持为 true，Agent Team tab 仍可见。
- 证据必须包含右键菜单截图、Agent Team tab 截图和刷新后仍可见的截图。

### AGT-ENTRY-003 Panel Split 开关是 session 级服务端状态

步骤：

1. 在 session A 右键启用 Panel Split 或 Agent Team。
2. 切换到同项目 session B。
3. 刷新浏览器，或用另一个浏览器窗口打开同一 backend。

期望：

- session A 的 panelSplitEnabled 保持 true。
- session B 不继承 session A 的 panelSplitEnabled。
- 换浏览器或 Electron 连接同一 backend 后，以后端 session list 返回值为准，不依赖 localStorage。
- 禁用 Panel Split 只隐藏控制条和 Agent Team 入口，不删除已有 pane；当 panelCount > 1 时禁用项必须不可用并有提示。

### AGT-BOOT-001 Agent Team 绑定当前终端而非整个项目

步骤：

1. 在同一项目下创建两个 terminal session：A 和 B。
2. 在 A 的终端 tab 右键打开 Agent Team，并点击开启流程。
3. 切换到 B，确认 B 默认没有 Agent Team tab；再通过右键打开 B 的 Agent Team tab。
4. 再切回 A。

期望：

- A 显示已进入 `clarify`。
- B 仍显示普通终端空态。
- A 和 B 的 UI 状态不会串线。
- run JSON 的 `projectId` 相同但 `terminalSessionId` 只等于 A。

### AGT-BOOT-002 切换项目不复用旧 run

步骤：

1. 在项目 A 的终端开启 Agent Team。
2. 切换到项目 B。
3. 通过终端 tab 右键打开项目 B 的任一终端 Agent Team tab。
4. 再切回项目 A。

期望：

- 项目 B 不显示项目 A 的 run。
- 项目 A 恢复显示原 run。
- `.runweave/agent-team` 文件只写在对应项目根目录下。

### AGT-BOOT-003 active run 优先保留 Agent Team tab

步骤：

1. 在终端 A 开启 Agent Team 并确认右侧进入 `clarify`。
2. 通过后端 session metadata 或 UI 尝试把 A 的 `panelSplitEnabled` 关闭。
3. 刷新页面并重新进入终端 A。

期望：

- 只要 A 存在非 `done`/`failed` 的 active run，Agent Team tab 仍应可见。
- UI 恢复原 run，而不是因为 panelSplitEnabled 关闭退回 Preview。
- 如果存在多个 pane，禁用 Panel Split 本身应被阻止并给出提示。

## 启动与 Agent Readiness 用例

### AGT-START-001 开启流程并注入主 Agent prompt

步骤：

1. 通过终端 tab 右键打开 Agent Team tab。
2. 在普通终端勾选或不勾选“自动确认拆分”。
3. 点击“在此终端开启 engineering-rules 流程”。
4. 观察右侧状态和左侧 main pane。

期望：

- main pane 先启动默认 agent command `codex`。
- 如果 Codex 出现 trust prompt，流程会自动按回车通过；证据中应看到 trust prompt 被处理或 Codex UI 已进入 ready。
- 右侧进入 `需求澄清`，状态为 `clarifying`。
- main pane 在 Codex UI ready 后收到启动 prompt，说明自己是主 Agent、生命周期和编排约束。
- run JSON 包含 `phase=clarify`、`status=clarifying`、`mainPanelId`、`options.autoApproveSplit`、`terminal.command=codex`。
- 如果 tmux workspace 初始化失败，UI 必须显示可理解错误或保持可恢复状态，不得进入半启动假成功。

### AGT-START-002 同一终端重复开启冲突

步骤：

1. 在终端 A 开启 Agent Team。
2. 通过刷新页面、打开第二个浏览器 tab 或快速重复点击，尝试再次开启同一终端。

期望：

- UI 不创建第二个 active run。
- 若触发后端冲突，右侧显示“This terminal already has an active agent-team run”或等价错误。
- `.runweave/agent-team` 中不会出现同一 terminal 的两个 active run 被 UI 同时引用。

### AGT-START-003 刷新页面恢复 run

步骤：

1. 开启流程并进入 `clarify`。
2. 刷新浏览器页面。
3. 重新进入同一项目、同一终端、同一 Agent Team tab。

期望：

- UI 通过轮询或初始加载恢复原 run。
- 即使 `panelSplitEnabled=false` 被误关，只要存在 active Agent Team run，Agent Team tab 仍应可见并恢复原 run。
- 终端画面和右侧状态保持一致。

### AGT-START-004 已有其它 Agent 时的冲突

步骤：

1. 在普通终端里先启动一个非 Codex agent，或让 terminal state 显示其它 agent 正在运行。
2. 通过右键打开 Agent Team。
3. 点击开启流程。

期望：

- 主 pane 启动阶段不应静默覆盖其它 agent。
- UI 展示 `Agent-team terminal is already using agent "..."`
  或等价冲突信息。
- run 不进入 `clarify` 假成功；终端现场不被清空。

### AGT-START-005 Codex 启动超时

步骤：

1. 临时让 `codex` 命令不可用或阻塞到超过启动等待时间。
2. 点击开启流程。
3. 观察右侧错误和 main pane 现场。

期望：

- 15 秒左右后返回启动超时错误。
- UI 保持可恢复，不进入 `clarify`。
- 用户能从终端画面判断是 agent 启动失败，而不是拆分或 proposal 失败。

## 澄清与提案用例

### AGT-CLARIFY-001 人主导提案

步骤：

1. 在 `clarify` 阶段点击“澄清完成 · 让主 Agent 拆分”。
2. 等待右侧切到 worker 拆分提案。

期望：

- `phase=proposal`，`status=need_human`。
- proposal 至少包含 `code`、`code_review`、`behavior_verify` 三类 worker。
- proposal 含验收用例草案。
- 右侧展示“确认拆分”和“驳回”。

### AGT-CLARIFY-002 Agent 主导提案

步骤：

1. 在 `clarify` 阶段点击“模拟主 Agent 判断澄清充分”。
2. 观察澄清消息流和提案卡。

期望：

- 澄清消息流追加 Agent 主动判断的消息。
- proposal.source 为 `agent`。
- UI 从轮询或操作结果进入 `proposal`。

### AGT-PROPOSAL-001 增删 worker 后确认

步骤：

1. 在 proposal 卡新增一个 worker。
2. 删除一个非唯一关键 worker，再确认拆分。
3. 观察左侧 tmux split 和右侧 executing。

期望：

- 确认按钮的 worker 数和当前草案一致。
- 左侧 split 出对应数量的 worker pane。
- 每个成功创建的 worker pane 收到对应角色 prompt。
- 右侧进入 `executing`，workers 列表带 `panelId`/`tmuxPaneId`。
- 验收用例仍来自 proposal，不因只编辑 worker 而丢失。

### AGT-PROPOSAL-002 空 worker 防误确认

步骤：

1. 在 proposal 卡连续删除所有 worker。
2. 观察确认按钮。

期望：

- “确认拆分”按钮禁用。
- 不会发起 split。
- UI 不进入 executing。

### AGT-PROPOSAL-003 驳回提案回到澄清

步骤：

1. 在 proposal 卡点击“驳回”。
2. 观察右侧阶段和日志。

期望：

- `phase=clarify`，`status=clarifying`。
- proposal 清空。
- 日志出现“人工驳回拆分提案，退回澄清”。
- 可以再次发起提案。

### AGT-PROPOSAL-004 验收用例草案可见性

步骤：

1. 进入 proposal。
2. 检查验收用例草案区域。
3. 记录是否可以编辑验收用例。

期望：

- 草案必须可见，并与后续 executing 的 acceptance 一致。
- 如果 UI 仍不可编辑，标记为设计验收缺口；不能把只读展示误判为通过“可编辑验收草案”。

## 自动确认用例

### AGT-AUTO-001 自动确认跳过人工门

步骤：

1. 在普通终端开启前勾选“自动确认拆分”。
2. 点击开启流程。
3. 在 `clarify` 阶段点击“澄清完成 · 自动拆分并执行”。

期望：

- 不出现 proposal 人工确认卡。
- 直接 split worker pane 并进入 `executing`。
- 日志包含“自动确认拆分已开启，跳过人工门，直接 split”或 Agent 主导等价文案。
- 生成 acceptance 用例，并显示在 executing 面板。

### AGT-AUTO-002 自动确认与 Agent 主导组合

步骤：

1. 开启流程时勾选自动确认。
2. 在 `clarify` 阶段点击“模拟主 Agent 判断澄清充分”。

期望：

- 直接进入 `executing`。
- 日志说明“main agent 判断澄清充分 + 自动确认开启，直接 split”。
- 不停留在 `need_human`。

## Pane 与 worker 用例

### AGT-PANE-001 worker pane 创建和 prompt 注入

步骤：

1. 完成一次普通提案确认。
2. 用 `$playwright-cli` 截图左侧 terminal surface。
3. 观察每个 split pane 的首屏内容和 active command。

期望：

- main pane 保留主 Agent 上下文。
- worker pane 数量等于确认的 worker 数量。
- 每个 worker pane 先启动默认 `codex`，ready 后再收到角色 prompt。
- 每个 worker pane 有角色、runId、意图和完成要求；prompt 不应被发送到 main pane 或其它 worker pane。
- `behavior_verify` pane 明确看到验收用例和写 outbox 要求。

### AGT-PANE-002 worker pane 继承 Agent Team terminal cwd

步骤：

1. 在一个 cwd 明确的项目终端开启 Agent Team。
2. 确认拆分后，在每个 worker pane 中观察 `pwd` 或 prompt cwd。

期望：

- worker pane cwd 与 Agent Team run 的 `terminal.cwd` 或项目 cwd 一致。
- 不应从浏览器当前目录、backend cwd 或其它 pane 泄漏出错误 cwd。
- 若后续调用方通过 `terminal.cwd` 覆盖 cwd，最终验证仍必须通过真实 worker pane 画面确认。

### AGT-PANE-003 split 不抢占主 pane

步骤：

1. 确认拆分前在 main pane 放置可见 marker。
2. 确认拆分后观察 active pane 和主 pane光标位置。

期望：

- split 创建 worker 时不强制把用户焦点抢到最后一个 worker。
- main pane 仍可被识别为主 Agent pane。
- 右侧 executing 默认 Observe Only。

### AGT-PANE-004 已有多 pane 终端上开启流程

步骤：

1. 先用真实 terminal panel split 在同一终端创建额外 pane。
2. 再打开 Agent Team 并开启流程。
3. 完成提案确认。

期望：

- Agent Team 能识别 main pane，不把已有手工 pane 错当 worker。
- 新 worker pane alias/role 不与已有 pane 冲突。
- 如果发生 alias/role 冲突，UI 显示明确错误并保持可恢复。

### AGT-PANE-005 非 tmux runtime 的入口与降级

步骤：

1. 创建一个 pty runtime terminal 或无法提供 tmux/panel workspace 的终端。
2. 打开该 terminal 的右键菜单和 sidecar。
3. 尝试通过已有 run 或直接 URL 恢复到 Agent Team。

期望：

- 正常情况下右键菜单不显示 Agent Team 入口。
- sidecar 不应显示可开启的新 Agent Team 空态。
- 如果已有历史 run，UI 可以只读展示或给出不可继续的明确提示。
- 不应进入一个没有任何可用 worker pane 的假 executing 状态。
- 如当前实现仍会以 `panelId=null` 进入 executing，记录为真实设计缺陷。

### AGT-PANE-006 聚焦 worker pane

步骤：

1. 让 run 进入 `executing` 并触发一次熔断。
2. 在熔断卡里点击“聚焦 code pane”或其它 worker pane。
3. 观察左侧 terminal surface。

期望：

- 左侧 tmux selected pane 切换到目标 worker。
- 右侧不改变 run 内容。
- 若 pane 已消失，UI 显示聚焦失败，不把错误吞掉。

### AGT-PANE-007 CLI panel agent 定向不串 pane

步骤：

1. 进入 executing，确认存在至少两个 worker pane。
2. 使用 CLI 作为环境动作执行：
   `rw terminal send "$TERMINAL_ID" --panel <code-pane-alias-or-id> --agent codex --text "继续" --json`
3. 用 `$playwright-cli` 观察左侧 terminal surface。
4. 再用 `--role behavior_verify` 执行一次定向发送并观察。

期望：

- agent 启动、clear、exit 和最终输入都进入目标 panel。
- `--panel` 优先于 `--role`。
- 其它 pane 不出现该输入或 agent control line。
- 通过标准以浏览器中真实 pane 画面为准，CLI JSON 只作为辅助证据。

## Executing 与 loop 用例

### AGT-LOOP-001 有进展的一轮

步骤：

1. 进入 `executing`。
2. 点击“有进展的一轮”。
3. 观察右侧 Loop 状态和验收用例列表。

期望：

- `round` 增加。
- `noProgressCount` 清零。
- acceptance 显示 pass 状态和 text evidence。
- 日志出现“有进展，noProgress 计数清零”。

### AGT-LOOP-002 第一次无进展不立即计数

步骤：

1. 进入 `executing`。
2. 点击一次“无进展的一轮”。
3. 观察 Loop 状态。

期望：

- acceptance 显示 fail。
- 因稳定 fail 阈值未到，`noProgressCount` 可能保持 0。
- 这个行为需要在测试记录中明确，防止被误判为按钮失效。

### AGT-LOOP-003 稳定 fail 后抛回 code pane

步骤：

1. 连续触发足够次数的“无进展的一轮”，直到某个 case 达到稳定 fail。
2. 观察右侧 acceptance 和左侧 code pane。

期望：

- 失败 case 显示“已抛回 code pane 修复”。
- code pane 收到带失败用例和证据的 bounce prompt。
- worker 之间没有横向通信；抛回动作来自编排层。

### AGT-LOOP-004 连续无进展触发熔断

步骤：

1. 从 executing 开始连续触发无进展轮。
2. 记录每轮 `round`、`noProgressCount`、acceptance 状态。
3. 等待进入 `need_human`。

期望：

- 右侧显示“已熔断 · 升级人工”。
- `loop.escalated=true`，`status=need_human`。
- `loop.lastReason` 说明卡在哪些 case 和错误指纹。
- 所有 worker 显示为 frozen 或不再被自动注入下一轮。
- 若 UI 文案写“连续 3 轮”但实际需要更多轮，应记录文案与实现的差异。

### AGT-LOOP-005 熔断期间 completion 不推进 loop

步骤：

1. 让 run 进入熔断。
2. 在 behavior_verify pane 手动写出 outbox 并触发 Stop hook。
3. 观察右侧 Loop 状态。

期望：

- `status=need_human` 期间不继续推进 `round`。
- 不会马上重复熔断或覆盖人工现场。
- 事件可以被记录，但 Agent Team run 不应自动前进。

### AGT-LOOP-006 恢复后注入人工 note

步骤：

1. 在熔断卡中输入人工干预 note。
2. 点击“人工已介入 · 恢复 loop”。
3. 观察 main pane、右侧状态和日志。

期望：

- `status=running`。
- `noProgressCount=0`，`escalated=false`，`errorFingerprints=[]`。
- main pane 收到人工干预 note。
- note 输入框清空。
- 下一轮不会在没有新稳定 fail 的情况下立即复燃。

### AGT-LOOP-007 恢复后历史 bestPassCount 影响

步骤：

1. 先制造一次 pass 数上升。
2. 再制造稳定 fail 并熔断。
3. 恢复后让 pass 数回到但不超过历史最高值。

期望：

- 记录 `bestPassCount` 是否导致恢复后进展判断变严。
- 若恢复后因为未重置 `bestPassCount` 而更容易再次无进展，标记为设计风险。
- 最终判断以右侧 UI 和 run JSON 证据为准。

## 真实 completion / outbox 用例

### AGT-OUTBOX-001 behavior_verify 写 outbox 推进 loop

步骤：

1. 进入 executing，并确认存在 behavior_verify pane。
2. 在 behavior_verify pane 中写出 `.runweave/outbox/<terminalSessionId>.json`，内容包含 `acceptanceResults`。
3. 在同一 pane 触发真实 Codex/agent Stop hook，或用真实 hook 命令路径触发 `/internal/terminal-completion`。
4. 用 `$playwright-cli` 观察右侧面板更新。

期望：

- completion 事件带 `terminalSessionId`，能解析 `panelId` 或 `tmuxPaneId`。
- Agent Team 读取 outbox 并推进 acceptance。
- 右侧 UI 的 pass/fail、证据、round 和日志与 outbox 内容一致。
- 证据中保留 outbox 片段和 UI 截图。

### AGT-OUTBOX-002 多 worker outbox 覆盖风险

步骤：

1. 在同一 run 中至少保留两个 worker pane。
2. 分别让两个 worker 几乎同时写 `.runweave/outbox/<terminalSessionId>.json` 并触发 completion。
3. 观察右侧 acceptance 和日志。

期望：

- 不应读到错误 pane 的验收结果。
- 不应因同一 session outbox 文件互相覆盖而丢失结果。
- 若当前实现出现覆盖或错归因，记录为高优先级缺陷，并附两个 pane 的 outbox 写入时间和 UI 结果。

### AGT-OUTBOX-003 脏 panel env 的归因

步骤：

1. 复制或污染一个 pane 的 `RUNWEAVE_TERMINAL_PANEL_ID`。
2. 触发 completion。
3. 观察事件、outbox 和右侧 UI。

期望：

- 后端不得把 completion 错归因给另一个仍存在的 worker pane。
- 如果无法校验 panel 归属，应在测试记录中标明当前实现风险。

### AGT-OUTBOX-004 损坏 outbox 的可观测性

步骤：

1. 在 behavior_verify pane 写入非法 JSON 到 outbox。
2. 触发 completion。
3. 观察右侧 UI 和日志。

期望：

- UI 不崩溃。
- run 不推进错误的 acceptance。
- 测试记录应说明用户是否能看到可诊断错误；若完全静默，标记为可观测性缺口。

## 并发与多端用例

### AGT-CONC-001 两个浏览器 tab 同时开启同一终端

步骤：

1. 打开同一终端的两个浏览器 tab。
2. 在两个 tab 里几乎同时点击开启流程。

期望：

- 最终只有一个 active run。
- 两个 tab UI 收敛到同一状态。
- 不出现两个 run 文件被轮询随机切换的现象。

### AGT-CONC-002 UI 手动 round 与真实 completion 同时到达

步骤：

1. 进入 executing。
2. 在 behavior_verify pane 准备一个真实 completion/outbox。
3. 几乎同时点击右侧“无进展的一轮”。

期望：

- `round` 不应异常双跳或覆盖已有 acceptance。
- 如果 HTTP 手动 round 与 completion 事件竞态造成双计，记录具体轮次变化。

### AGT-CONC-003 resume 与在途 completion 竞态

步骤：

1. 让 run 熔断。
2. 在恢复前准备一个会触发 fail 的 completion。
3. 点击恢复并立即触发 completion。

期望：

- 不应恢复后立刻复燃，除非确实有新的稳定 fail 证据。
- 人工 note 不应被 completion 覆盖。
- 右侧日志顺序可解释。

## 错误、鉴权与恢复用例

### AGT-ERR-001 鉴权过期

步骤：

1. 用浏览器打开 terminal workspace。
2. 让 token 失效或替换为错误 token。
3. 在 Agent Team tab 执行加载或操作。

期望：

- 前端触发认证过期处理。
- 不把 401 当普通 run 错误继续展示。
- 用户可以重新登录后恢复查看同一 run。

### AGT-ERR-002 非法操作反馈

步骤：

1. 在非 proposal 阶段通过真实 UI 或浏览器控制台触发确认拆分路径。
2. 在非 executing 阶段触发 round 路径。
3. 在缺 note 时尝试恢复。

期望：

- UI 展示明确错误或按钮保持禁用。
- run 状态不被破坏。
- 用户刷新后仍能看到一致状态。

### AGT-ERR-003 backend 重启恢复

步骤：

1. 让 run 进入 proposal 或 executing。
2. 重启 backend。
3. 用 `$playwright-cli` 刷新页面并重新进入同一终端。

期望：

- run 从项目目录 `.runweave/agent-team` 恢复。
- proposal、workers、acceptance、loop 和 logs 不丢失。
- 已丢失的 tmux pane 不应被当作可聚焦 worker 假展示。

### AGT-ERR-004 terminal session 删除

步骤：

1. 开启 run。
2. 删除对应 terminal session。
3. 刷新页面或切换回该项目。

期望：

- UI 不崩溃。
- 如果仍停留在 Agent Team tab，显示选择终端或 session missing 状态；如果 tab 被隐藏，应自动退回 Preview。
- 不允许继续操作已失效 run。

## 旧 Orchestrator 下线回归

### AGT-REG-001 Orchestrator tab 和路由不可见

步骤：

1. 打开 terminal sidecar。
2. 在未启用 Agent Team 的新终端检查 tab 列表。
3. 通过终端 tab 右键打开 Agent Team 后再次检查 tab 列表。
4. 在浏览器网络面板或页面行为中确认 Agent Team 操作请求路径。

期望：

- 未启用时 tab 为 Preview、Browser。
- 右键打开 Agent Team 或已有 active run 时 tab 为 Preview、Browser、Agent Team。
- 不再出现 Orchestrator tab。
- Agent Team 操作走 `/api/agent-team/*`，不走 `/api/orchestrator/*`。

### AGT-REG-002 Preview 和 Browser sidecar 不退化

步骤：

1. 在同一终端中依次切换 Preview、Browser、Agent Team。
2. 在 Preview 查看文件变化。
3. 在 Browser 打开本地页面。
4. 回到 Agent Team。

期望：

- 三个 tab 切换状态稳定。
- Preview 的项目文件状态不被 Agent Team 切换破坏。
- Browser tab、CDP proxy、刷新/前进后退不受 Agent Team 新 tab 影响。

### AGT-REG-003 Terminal panel split 基础能力不退化

步骤：

1. 先通过右键启用 Panel Split，但不启动 Agent Team。
2. 在普通终端执行一次手工 split/focus/send。
3. 再开启 Agent Team 并确认拆分。
4. 再执行手工 panel focus 或 send。

期望：

- 原 panel split、focus、send、snapshot 行为保持可用。
- Agent Team 创建的 worker pane 能被普通 panel 工具识别。
- 普通 panel 工具不会破坏 Agent Team run 的 worker 归属。
- panelSplitEnabled 写入服务端 session metadata；刷新后手工 panel 工具状态仍恢复。

### AGT-REG-004 Hook payload 双副本一致

步骤：

1. 在 Electron runtime hook 路径和 toolkit plugin hook 路径各触发一次 completion。
2. 观察事件 payload。

期望：

- 两个 hook 都带 `panelId`。
- 无 panel 环境时仍兼容 session-level completion。
- Agent Team 不依赖只有某一个 hook 副本才有的字段。

## Electron / Computer Use 用例

### AGT-DESK-001 Electron 桌面端打开 Agent Team

步骤：

1. 用 `$computer-use` 启动 Runweave Electron 桌面端。
2. 进入目标 backend 的 terminal 页面。
3. 右键目标终端 tab，点击 Agent Team。
4. 打开 Agent Team tab。

期望：

- 桌面端可以进入同一 Agent Team 流程。
- 登录态、backend 连接和终端切换正常。
- session 级 panelSplitEnabled 与 Web 端保持一致。
- UI 与 Web 端保持同一 run 状态。

### AGT-DESK-002 桌面端准备环境，浏览器验收页面

步骤：

1. 用 `$computer-use` 启动或切换桌面端 backend/runtime。
2. 用 `$playwright-cli` 打开对应 Web terminal。
3. 完成 AGT 主链路任一用例。

期望：

- 桌面端准备的 backend/runtime 能被浏览器页面复用。
- 最终验证证据仍来自浏览器 UI、DOM、截图和终端画面。

## 验收出口

一次完整回归至少覆盖：

- AGT-BOOT-001/002/003
- AGT-ENTRY-001/002/003
- AGT-START-001/002/003/004/005
- AGT-CLARIFY-001/002
- AGT-PROPOSAL-001/002/003/004
- AGT-AUTO-001/002
- AGT-PANE-001/002/003/004/005/006/007
- AGT-LOOP-001/002/003/004/005/006/007
- AGT-OUTBOX-001/002/003/004
- AGT-CONC-001/002/003
- AGT-ERR-001/002/003/004
- AGT-REG-001/002/003/004
- Electron 相关改动需要覆盖 AGT-DESK-001/002

可接受通过标准：

- 所有 P0/P1 主链路均有浏览器或 Computer Use 证据。
- 每个失败项都有可复现步骤、证据和优先级判断。
- 不以类型检查、CLI 返回值、HTTP 返回值、静态阅读或内部函数结果作为最终通过依据。
- 不新增任何单测或内部逻辑测试；若需要自动化，只能固化为驱动真实页面和真实终端的 Playwright E2E 场景。
- 高风险项必须明确结论：outbox 多 worker 覆盖、熔断轮数与文案、恢复后是否立即复燃、非 tmux runtime 是否假 executing、旧 orchestrator 是否完全下线。
