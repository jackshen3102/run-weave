# Agent Race — 实施计划（v1）

- 日期：2026-07-25
- 分支基线：`fix/beta-pool-repeatability`（Runweave / browser-viewer）
- 原型：`docs/prototypes/agent-race/`（index.html / app.js / mock-state.json / README + 截图）
- 粒度：L2 结构化（后端新领域 + 前端接线 + 一处受控越界）

---

## 1. 目标

在 Runweave 现有终端工作区里，新增一个与「Agent Team」并列的右侧工具 tab「Race」。用户填一个目标 + 逐行配置若干 worker（各自选协议 codex/traex + 该协议的真实模型），下发后：

- 后端为每个 worker 建一个独立 git worktree（`race-<goal>-<x>`，自带 `race/<goal>-<x>` 分支，从 baseRef 切）。
- 每个 worker 在自己 worktree 的终端里启动 codex/traex，用**同一个目标原文**作为初始 prompt 并行执行。
- 用户在中间终端区盯任一 worker、直接打字介入；有改动的 worker 可切「终端 / Diff」看其改动。
- 右侧 Race 面板观测所有 worker（各自 agent/model/状态）+ loop 日志。

核心价值：同一目标喂给不同协议/不同模型的 worker，让多样解并列出现，供人对比。

## 2. 非目标（v1 明确不做）

- **裁决 / 选赢家 / 打分**：系统不判断哪个 worker 更好。以后可能由主 Agent 协助，v1 无此 UI 与逻辑。
- **主 Agent 作为真实 agent 会话**：v1 的「主 Agent」是逻辑协调器，不跑真实 codex/traex。所谓主 Agent = 主仓终端 + Race 面板本身。
- **worker「卡住等回答」自动检测**：现有终端状态机只有 `starting/idle/running`，codex 停下提问与干完活都只报 `agent_idle`，物理上不可区分。不做琥珀高亮 / WAITING 徽标 / 顶部待回答提示。
- **worker 行为约束 / 端口 / 环境隔离**：Race 完全不管 worker 干什么（要 `pnpm dev`、起服务、用 dev session 随它）。不分配端口、不禁止、不碰运行时资源；冲突由 worker 自理。
- **多场 race 并存**：v1 同时只允许一场。
- **自动删除 worktree**：结束 race 不删 worktree/分支。
- **指令广播 / 聚合收件箱**：逐个 worker 终端单独介入即可。
- **worker 完成后回传结构化结果（outbox 契约）**：v1 不需要，worker 发目标原文、不包 preamble。

## 3. 用户可见行为

1. 打开右侧面板 → 工具 tab 出现第 4 项 `Race`。
2. Race 面板无进行中 race 时显示 composer：
   - **目标**（单行）、**任务计划/prompt**（多行）、**baseRef**（默认主仓当前 HEAD 分支名，可改）。
   - **Workers 列表**：每行 = 一个 worker，含「agent 下拉（codex/traex）」+「模型下拉（联动该 agent 的真实模型）」+ 删除按钮；顶部「+ 加 worker」。
   - 「下发给主 Agent」按钮。
3. 下发后：
   - 左侧 worktree rail 立即多出 N 行（每 worker 一个 `race-*` worktree）。
   - 中间终端区默认聚焦第一个 worker 的终端，显示其真实启动命令（如 `codex -m gpt-5.6-sol "<目标>"` / `traex -c model="glm-5.1" "<目标>"`）。
   - Race 面板切换为观测态：目标 + workers 列表（各显 `agent · model` + 状态点）+ loop 日志 + 「新的 Race 目标」。
4. 点 rail 行或 Race 面板 worker 卡 → 中间终端区切到该 worker 的 worktree 终端。
5. 终端底部常显输入框：往当前 worker 终端发文本（回答 / 补充 / 纠偏），发送后该 worker 状态转 running。
6. 有改动（`git status` 有变更）的 worker，其终端上方出现「终端 / Diff」切换，Diff 显示该 worktree 相对 baseRef 的改动。
7. 已有一场 race 时点「下发」→ 提示先结束当前 race，不静默覆盖。
8. 「新的 Race 目标 / 结束 race」→ 清 race 记录 + 停 worker session；**worktree/分支保留**。

## 4. 关键约束与边界决策

### 4.1 受控 worktree 供给（需修订现有文档边界）

- 现状：`docs/plans/2026-07-18-worktree-terminal-context.md:51` 明确「不在 Runweave 内执行 `git worktree add/remove/prune/repair`」；`WorktreeProjectRegistry` 只读 `git worktree list`。
- 本能力**需要**在 Runweave 内创建/删除 worktree，因此这是一处**被批准的受控越界**：
  - 仅允许在 `<parentRepo>/.worktree/` 下、且名字以 `race-` 前缀开头的 worktree 上执行 `add` / `remove`。
  - 创建：`git worktree add <parent>/.worktree/race-<slug>-<x> -b race/<slug>-<x> <baseRef>`。
  - 删除：只允许删自己命名空间内的 worktree（`race-` 前缀），且必须是 Race 记录里登记过的；绝不 `prune`、绝不碰用户其它 worktree。
- **实现前必须先更新** `docs/plans/2026-07-18-worktree-terminal-context.md`，把「不执行 worktree add」的约束修订为「除 Race 受控 `race-` 命名空间外，不执行」，让越界被记录、被批准。

### 4.2 baseRef

- 默认 = 主仓（primary worktree）当前分支/HEAD；composer 可改成任意本地/远程 ref。
- 非法 ref（`git worktree add` 失败）→ 该 worker 创建失败，标记失败原因，不影响其它 worker。

### 4.3 worker 数量与并发

- 软上限 5：composer 加 worker 超过 5 时给一条提示（「N 个 worker = N 份 worktree 磁盘 + N 个并发 agent 进程」），但不硬拦。
- worker 并发起（并行 `prepareTerminalAgent`），不排队。

### 4.4 单场约束

- 同时只允许一场 race。已有记录时下发 → 前端拦截并提示先结束。

### 4.5 结束与清理

- 结束 race = 删 race 记录 + 停各 worker terminal session；worktree/分支不动。
- 删除某个 race worktree 是**独立、显式**的用户操作，调用受控删除（限 `race-` 命名空间）。v1 可不做删除 UI（沿用现有侧边栏/手动 git），但后端删除能力要具备且受命名空间约束。

## 5. 数据结构与合约

### 5.1 共享类型（新增 `packages/shared/src/race/`）

```ts
// packages/shared/src/race/race.ts
export type RaceAgent = "codex" | "traex"; // 对齐 TerminalAgentPreparationAgent

export interface RaceWorkerConfig {
  agent: RaceAgent;
  model: string; // 传给 codex -m / traex -c model=；可为空走 agent 默认
}

export interface RaceWorkerRecord {
  workerId: string; // race 内稳定 id，如 "worker_a"
  label: string; // "worker A"
  agent: RaceAgent;
  model: string;
  worktreeId: string; // = buildTerminalChildProjectId(parentId, "race-<slug>-<x>")
  worktreePath: string; // 绝对路径
  branch: string; // race/<slug>-<x>
  terminalSessionId: string | null; // 启动成功后回填
  launchStatus: "starting" | "launched" | "failed";
  launchError?: string;
}

export interface RaceRecord {
  raceId: string;
  goal: string;
  plan: string; // 初始 prompt 原文（= 发给 worker 的内容）
  baseRef: string;
  parentProjectId: string; // 主仓 project id
  createdAt: string;
  workers: RaceWorkerRecord[];
}
```

- **不存**：终端输出（session 自管）、diff（`preview-git` 实时查）、worker 运行状态（从 `TerminalStateService` 实时取，只有 starting/idle/running）。

### 5.2 后端 HTTP 合约（新增 `backend/src/routes/race-routes.ts`）

| 方法   | 路径                               | body / 说明                                                                        | 返回                 |
| ------ | ---------------------------------- | ---------------------------------------------------------------------------------- | -------------------- |
| GET    | `/race`                            | 取当前 race 记录（单场；无则 null）                                                | `RaceRecord \| null` |
| POST   | `/race`                            | 下发：`{ goal, plan, baseRef, workers: RaceWorkerConfig[] }`；已有 race 时返回 409 | `RaceRecord`         |
| DELETE | `/race/:raceId`                    | 结束：清记录 + 停各 worker session；不删 worktree                                  | `{ ok: true }`       |
| DELETE | `/race/:raceId/worktree/:workerId` | 显式删单个 race worktree（受控，限 race 命名空间）                                 | `{ ok: true }`       |

- 下发流程（POST `/race`）：
  1. 若已有 race 记录 → 409 `race_exists`。
  2. 解析 baseRef、slug(goal)。
  3. 对每个 worker 配置：受控 `git worktree add`（4.1）→ `TerminalSessionManager.createSession({ projectId: childId, cwd: worktreePath })` → `prepareTerminalAgent({ agent, args: modelArgs(agent, model), prompt: goal, cwd })`。并发执行，单个失败标 `launchStatus:"failed"` 不阻塞其它。
  4. 落 `RaceRecord`，返回。
- `modelArgs`：`codex` → `["-m", model]`；`traex` → `["-c", 'model="' + model + '"']`；model 为空 → `[]`。以 `request.args` 传给 `prepareTerminalAgent`（`buildAgentLaunchCommand` 会拼进启动命令）。

### 5.3 Agent 模型目录（供 composer 下拉）

- 新增 GET `/race/agents` → `{ codex: { models: string[], custom: true }, traex: { models: string[], custom: true } }`。
- traex：后端执行 `traex models` 解析输出为列表（可缓存）。
- codex：无 list 命令 → 返回后端维护的已知常用模型（如 `gpt-5.6-sol` 等）+ `custom:true`。
- 前端下拉：列出 models + 「自定义…」项（选中弹输入）。

## 6. 文件清单（新建 / 修改及职责）

### 后端

- **新建** `backend/src/race/race-record-store.ts`：单场 `RaceRecord` 的读/写/清（落盘，仿 Agent Team run 记录的持久化方式）。
- **新建** `backend/src/race/race-worktree-supply.ts`：受控 worktree `add`/`remove`，严格限定 `.worktree/race-*` 命名空间；封装 baseRef 解析、slug、命名冲突处理。
- **新建** `backend/src/race/race-service.ts`：下发编排（建 worktree → createSession → prepareTerminalAgent，并发 + 单点失败隔离）、结束（清记录 + 停 session）、模型目录（`traex models` + codex 已知列表）。
- **新建** `backend/src/routes/race-routes.ts`：5.2 的路由，挂到现有 route 注册处。
- **复用（不改）**：`TerminalSessionManager.createSession`、`prepareTerminalAgent`、`WorktreeProjectRegistry`（建好后自动发现）、`preview-git`（diff）、`sendInputToSession`（介入）。

### 共享

- **新建** `packages/shared/src/race/race.ts`：5.1 类型。
- **新建** `packages/shared/src/race/http.ts`：请求/响应 DTO（对齐 5.2）。

### 前端

- **修改** `frontend/src/features/terminal/preview-store-types.ts`：`TerminalSidecarTool` 联合加 `"race"`；`TerminalPreviewStore` 加 `openRace: () => void`（对齐现有 `openAgentTeam`）。
- **修改** `frontend/src/features/terminal/preview-store.ts`：`setActiveTool` / `openRace` 支持 `"race"`。
- **修改** `frontend/src/components/terminal/terminal-preview-panel-shell.tsx`：`availableTools` 条件加 `"race"`；tab label；面板 body 区新增一个 `activeTool === "race"` 的常驻挂载块（对齐现有 `agentTeamBody` 的可见性切换模式），渲染 `<TerminalRacePanel>`。
- **新建** `frontend/src/components/terminal/terminal-race-panel.tsx` + 拆分子文件（对齐 `terminal-agent-team-panel*.tsx` 的组织）：
  - composer（无 race 时）：目标 / plan / baseRef / 逐行 worker（agent 下拉 + 联动模型下拉 + 增删）/ 下发。
  - 观测态（有 race 时）：目标 + workers 观测列表（各 `agent · model` + 实时状态点）+ loop 日志 + 「新的 Race 目标」。
  - 点 worker → 调现有「切到该 worktree 终端」的入口（复用 rail/工作区已有的 setActiveProject/session 逻辑）。
- **新建** `frontend/src/services/race.ts`：封装 5.2 / 5.3 的 HTTP 调用。
- **复用**：worktree rail（`race-*` worktree 建好后自动出现）、中间终端 surface、终端底部输入（`sendTerminalInput`）、preview diff（有改动才出 toggle）。

### 文档

- **修改** `docs/plans/2026-07-18-worktree-terminal-context.md`：按 4.1 修订 worktree 写操作约束。

## 7. 组件复用对照（能实现性，已核对真实代码）

| 交互                          | 复用                                                                                                              | 判定                                         |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| 右侧 `Race` tab               | `TerminalSidecarTool`（`preview-store-types.ts:8`）、面板 body 挂载（`terminal-preview-panel-shell.tsx:401-434`） | 需新写（小）                                 |
| 每 worker 一 worktree/session | `createSession({projectId,cwd})`（`manager.ts:177`）、`WorktreeProjectRegistry` 自动发现                          | 现成                                         |
| worker 各选 agent             | `TerminalAgentPreparationAgent="codex"｜"traex"`（`agent-preparation.ts:3`）                                      | 现成                                         |
| worker 各选模型               | `traex models` 真实枚举；codex `-m`；`buildAgentLaunchCommand`（`agent-preparation.ts:442`）拼 args               | 现成                                         |
| 启动 worker + 发目标          | `prepareTerminalAgent`（`agent-preparation.ts:44`）                                                               | 现成                                         |
| 终端介入输入                  | `sendInputToSession`（`input-dispatcher.ts:183`）                                                                 | 现成                                         |
| diff                          | `preview-git`（project scoped）                                                                                   | 现成                                         |
| worktree 创建/删除            | 无（只读 list）+ 文档禁止                                                                                         | 需新写 + 受控越界（4.1）                     |
| 主 Agent 跨 worktree 编排     | Agent Team 是单 session 串行（`service-serial-dispatch.ts:146`），不适用                                          | 需新写（race-service，v1 仅 fan-out 无裁决） |

## 8. 高风险点

- **受控 worktree 写操作（最高）**：误删/误建可能破坏用户工作区。缓解：严格 `race-` 前缀 + 必须在 Race 记录登记 + 只删自己建的 + 绝不 `prune`；删除前二次校验路径归属。实现前先改文档边界。
- **baseRef / 并发建 worktree 失败**：单 worker 失败要隔离，不能让整场 race 下发失败或产生半残状态；失败 worker 标 `launchStatus:"failed"` 且其 worktree 若已建需登记以便后续清理。
- **`traex models` 依赖外部 CLI**：命令不可用/超时 → 模型目录降级为「仅自定义输入」，不阻塞下发。
- **单场记录一致性**：app 重启后从落盘记录恢复；若记录里的 worktree/session 已不存在（用户手动删过），恢复时要能容错剔除。

## 9. 实施顺序建议

1. 先改文档边界（`2026-07-18-...md`）——越界前置批准。
2. 共享类型（`packages/shared/src/race/`）。
3. 后端：`race-worktree-supply` → `race-record-store` → `race-service` → `race-routes`；先能 `POST /race` 建出 worktree + 起 worker。
4. 前端：`race.ts` 服务 → `preview-store` 加 `race` tool → `terminal-race-panel`（先观测态，再 composer）。
5. 打通「下发 → rail 出现 worker → 点击切终端 → 介入 → diff」。

## 10. 待办（执行时确认）

- 后端 route 注册入口的确切位置（`backend/src/routes/` 现有聚合处）。
- `RaceRecord` 落盘目录（对齐 Agent Team run 记录的存储根）。
- codex「已知常用模型」清单的初始值（可从 `~/.codex/config.toml` 的 model + 常见几项起步）。
