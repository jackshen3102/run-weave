# Agent Race — 基于现有终端工作区 UI 的原型

在 Runweave 现有终端工作区里，新增一个和 `Agent Team` 并列的右侧工具 tab「Race」：
下发一个目标，主 Agent 为每个 worker 建独立 worktree，各自并行做**同一目标**，你在中间终端区盯着、介入。裁决暂不做。

这是**可运行的 UI 原型**，不是产品实现，也不证明后端/协议/运行时能力已存在。

## 本轮修正（可实现性钉死）

原型的每个交互都对照真实代码核过一遍，不可忠实实现的已从界面移除或降级：

- **每 worker 各自选 agent + 真实模型**（本轮）：composer 从「全局 agent + worker 数量」改为**逐行 worker 配置**——每行选 agent（`codex`/`traex`）并联动该 agent 的真实模型下拉。证据：`traex models` 可枚举真实模型列表；codex 用 `-m <MODEL>`；模型经 `buildAgentLaunchCommand`（`agent-preparation.ts:442`）拼进启动命令。**纠正了上一版“模型只能自由填空”的错误结论**——两个 agent 的模型都拿得到。
- **移除「worker 待回答」独立状态**：现有终端状态机只有 `starting/idle/running`（`terminal-state-service.ts:278-292`），codex 停下提问和干完活都只报 `agent_idle`，`AgentHookStateEvent` 也只有 5 个事件、无 waiting（`packages/shared/src/terminal/runtime/events.ts:222-227`）。系统物理上无法区分「在等你」和「完成」。所以原型不再有琥珀「待回答」高亮/顶部提示/WAITING 徽标；idle worker 统一显示「空闲·待查看」，提问文字只作为**终端里的普通输出**存在（需人进终端看，这是真实的）。
- **diff 切换改为基于真实 git 信号**：「终端/Diff」toggle 的出现条件是「有改动」（`changeSummary.filesChanged > 0`，对应 `preview-git.ts` 的 `git status`），与 agent 状态无关。
- **终端输入框对所有 worker 常显**：往终端发文本（`sendInputToSession`）任何时候都能做，不假装只有「等回答」时才可输入。

前几版还犯过更大的错（凭想象画独立页面 / 暖米色配色），已在更早版本纠正为深色 slate 三区、真实类名、Race 与 Agent Team 同构。

## 现有 UI 结构（复刻依据）

读自 `frontend/src/components/terminal/`：

```
terminal-workspace-shell.tsx  上(header h-8) + 下三区，bg-slate-950 dark
├─ terminal-worktree-rail.tsx   左 rail 236px：worktree 列表，Pin 区分主仓
├─ 中间列
│  ├─ terminal-session-tab-strip.tsx   h-[26px] session tab（选中 sky 下划线）+ 新建
│  └─ terminal-surface…                xterm 终端，底色 #0b1220
└─ terminal-preview-panel-shell.tsx  右 aside，工具 tab pill：
      availableTools = ["preview","browser","agent-team"]   ← Race 并列加为第 4 个
```

**关键沿用的现有模型**：worker 的实时终端**不在**右侧面板里。现有 Agent Team 的 worker 是 tmux pane / worktree 终端，显示在中间区；右侧面板只做**观测卡片流**（状态徽标 + workers 列表 + loop 进度 + 日志）。Race 完全照此：

- 每个 worker = worktree rail 里的一行（各自 worktree、各自 session）。
- 中间终端区显示当前选中 worktree 的终端。
- 右侧 Race 面板 = 观测 + 下发 + 路由注意力，与 Agent Team 面板同构。

## 启动

```bash
python3 -m http.server 6199 --directory docs/prototypes/agent-race
# 打开 http://127.0.0.1:6199/index.html
```

## 采用的交互方案（全部落在现有交互模型上）

- **右侧 Race tab**：`Preview | Browser | Agent Team | Race`，点击切 `sidecarTool`（对齐现有 `activeTool` 机制）。
- **下发目标（逐行配置 worker）**：Race 面板填目标/计划，下面**每行一个 worker，各自选 agent（codex/traex）+ 该 agent 的真实模型**，可增删行。下发后为每个 worker 建 `race-<goal>-<x>` worktree（遵循 `.worktree/<name>` 约定，会被 `WorktreeProjectRegistry` 识别），rail 立即多出 N 行。多样性（不同协议/模型）正是 Race 的价值。
- **worker = rail 一行**：点 rail 或点 Race 面板里的 worker 卡，中间终端区切到该 worktree 的终端（现有点 worktree 切终端的交互）。
- **worker 空闲**：agent 停下时 rail 行状态点转 sky 蓝（idle）——系统无法区分是完成还是在等输入；进该 worker 终端看 transcript 才知道，随时可在底部输入框发文本让它继续。
- **补充 / 纠偏**：running worker 终端底部同一输入框发送。
- **worker 完成**：终端上方 toggle 切「终端 / Diff」看它在自己 worktree 的改动。
- **无裁决 UI**：按需求「保留哪个先不做」，无选赢家/评分控件。

## 被放弃 / 推迟

- **凭空的独立页面 / 主 Agent 大窗 + worker 网格**（前几版）：脱离现有 UI，已废弃。
- **裁决 / 选赢家 / 打分**：本轮不做，未来可能由主 Agent 协助。
- **指令广播 / 聚合收件箱**：逐个 worker 终端回答即可，不做。

## 功能分类账

### 产品核心功能（需落地）

- 右侧工具 tab 新增 `Race`（并列 Agent Team）
- Race 面板：逐行 worker 配置（每行 agent + 真实模型）+ 下发 + 状态徽标 + workers 观测列表 + loop 日志
- 每个 worker 一个 race worktree，出现在 worktree rail
- 点 worker（rail 或面板卡）→ 中间终端区聚焦该 worktree
- worker 空闲时中性提示「空闲·待查看」+ 中间终端底部通用输入（回答 / 补充 / 纠偏）
- 有改动的 worker 中间区终端 ↔ diff 切换（基于真实 git 信号）

### 原型辅助功能（不进产品）

- `?helper=1` 右下角重载条（`data-prototype-helper`）
- `mock-state.json` 样例 worktree / 终端行 / diff
- Tailwind CDN 仅供原型渲染（产品用仓库既有 Tailwind 构建）
- 回答/下发只操作本地 mock（真实走 `sendInputToSession` / worktree 创建）

## 可实现性对照表（原型每个交互 → 能否实现）

判定基于对当前 worktree 真实代码的核对。三档：**现成**（直接复用）/ **需新写**（可实现但无现成代码）/ **不可忠实实现**（受现有架构物理限制）。

| 原型交互                                 | 现有能力 / 证据                                                                                                                                                                                                       | 判定                    | 原型处理                                                                                                                   |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 右侧新增 `Race` 工具 tab                 | `TerminalSidecarTool` 是封闭联合 `preview\|browser\|agent-team`（`preview-store-types.ts:8`）；`availableTools`（`terminal-preview-panel-shell.tsx:143`）                                                             | **需新写（小）**        | 保留：加联合成员 + 数组项 + 面板组件                                                                                       |
| 每 worker = 一个 worktree 行（rail）     | `WorktreeProjectRegistry` 扫 `.worktree/`，>1 才显示 rail（`worktree-project-registry.ts`）                                                                                                                           | **现成**                | 保留                                                                                                                       |
| 每 worker 一个 codex 终端 session        | `TerminalSessionManager.createSession({projectId,cwd})`（`manager.ts:177`）                                                                                                                                           | **现成**                | 保留                                                                                                                       |
| **每 worker 各自选 agent（协议）**       | `TerminalAgentPreparationAgent = "codex"｜"traex"`（`agent-preparation.ts:3`）；每 worker 是独立 `prepareTerminalAgent` 调用                                                                                          | **现成**                | 保留：每行一个 agent 下拉，只有这两个                                                                                      |
| **每 worker 各自选模型**                 | `traex models` 真实枚举 20+ 模型（Doubao/DeepSeek/kimi/glm/qwen…）；codex 用 `-m <MODEL>` / `-c model=`（`codex --help`）；模型经 `request.args` 拼进启动命令（`agent-preparation.ts:442` `buildAgentLaunchCommand`） | **现成（含真实列表）**  | 保留：traex 行下拉可用 `traex models` 填充；codex 无 list 命令 → 已知模型 + 自定义。**纠正上一版“只能自由填空”的错误结论** |
| 在 worktree 终端启动 codex + 注入 prompt | `prepareTerminalAgent`（`agent-preparation.ts:44`）；`agent-launch.ts:54`                                                                                                                                             | **现成**                | 保留                                                                                                                       |
| 点 worker（rail/卡）→ 中间区切该终端     | 现有点 worktree 切终端交互                                                                                                                                                                                            | **现成**                | 保留                                                                                                                       |
| 终端底部输入 → 发到该 worker 终端        | `sendInputToSession`（`input-dispatcher.ts:183`，定向 pane + 多 mode）                                                                                                                                                | **现成**                | 保留（通用输入，不分“回答/补充”）                                                                                          |
| 有改动才显示「终端/Diff」切换 + diff     | `preview-git.ts`（`git status` / `file-diff`，project scoped）                                                                                                                                                        | **现成**                | 保留（基于 `filesChanged>0`，非 agent 状态）                                                                               |
| 下发目标 → 为每个 worker 自动建 worktree | 只读 `git worktree list`；**文档明令不在 Runweave 内执行 `worktree add`**（`docs/plans/2026-07-18…:51`）                                                                                                              | **需新写 + 越现有边界** | 保留但标注：真实实现要么新增受控 `git worktree add`、要么由 CLI/外部预建后被 registry 发现                                 |
| 主 Agent 跨 N 个 worktree 并行下发/汇总  | Agent Team 是单 `terminalSessionId`、多 pane、**串行**（`service-serial-dispatch.ts:146`）；`mainPanelId` 只是同 session 主 pane                                                                                      | **需新写编排层**        | 保留但标注：新建 race 编排（N 独立 session、fan-out/fan-in），**不复用** Agent Team 的 round/gate/outbox                   |
| worker「卡住等你回答」独立状态/高亮      | 状态机仅 3 态；`Stop` hook → `agent_idle`（`terminal-state-service.ts:284`）；hook 事件无 waiting（`events.ts:222`）                                                                                                  | **不可忠实实现**        | **已从原型移除**：idle worker 统一“空闲·待查看”，提问只作终端文本，需人进终端看                                            |
| 系统自动感知 codex 在提问并点亮该 lane   | 无终端输出语义解析；`terminal_bell` 仅计数；`TerminalNotificationEventPayload` 后端从不发射                                                                                                                           | **不可忠实实现**        | **已从原型移除**：不做自动检测                                                                                             |
| 裁决 / 选赢家                            | 无                                                                                                                                                                                                                    | 本轮不做                | 原型无此 UI                                                                                                                |

**真实落地路线**：新建 `backend/src/race/`（race 编排 + 可选 worktree 供给）+ 前端 Race 面板组件 + `TerminalSidecarTool` 加 `"race"`；复用 `WorktreeProjectRegistry` / `TerminalSessionManager` / `prepareTerminalAgent` / `sendInputToSession` / `preview-git`；**不进 Agent Team 的串行 dispatch/acceptance**。若要「idle worker 是否在等输入」的信号，需另立协议（如受控 prompt 让 worker 把“需要输入”写进 outbox 文件，Race 轮询——但那样 worker 就不是 naked codex）。

## 验证

- `$toolkit:playwright-cli` 打开 `http://127.0.0.1:6199/index.html`，无 console error（仅 Tailwind CDN 生产提示 warning）。
- 验证点：rail 4 行（main pinned + 3 worker）；工具 tab `Preview/Browser/Agent Team/Race`，Race 激活；**workers 各自 agent+模型**（worker A `codex·gpt-5.6-sol`、B `traex·DeepSeek-V4-Pro`、C `traex·glm-5.1`）；composer 逐行 worker 配置，改某行 agent → 该行模型下拉联动切换成该 agent 的真实模型列表，可增删行；**无琥珀「待回答」点、无「待回答」文案**（waiting 幻觉已清除）；有改动的 worker 出现「终端/Diff」toggle，切 Diff 显示改动。
- 截图：`prototype-preview.png`（运行态，workers 各自 agent/模型）、`prototype-preview-composer.png`（逐行 worker 配置 composer）。
