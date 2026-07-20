# Desktop Companion Terminal 状态投影一致性修改方案

## 背景与已确认现场

Desktop Companion 当前把 3 个已经结束工作的 Terminal 显示为“执行中”。现场同时存在两套状态：

| Terminal Session | `session.terminalState`  | 唯一 running Panel 的 `terminalState` |
| ---------------- | ------------------------ | ------------------------------------- |
| `0a5be7a0`       | `agent_starting / codex` | `agent_idle / codex`                  |
| `8c2153b3`       | `agent_starting / traex` | `agent_idle / traex`                  |
| `aea9a139`       | `agent_starting / codex` | `agent_idle / codex`                  |

终端 Session 列表与 `/api/terminal/session/:id/state` 已采用“存在 running Panel 时聚合 Panel，否则读取 TerminalStateService 当前状态”的读语义，因此显示为 `agent_idle`。Attention snapshot 仍直接读取持久化的 `session.terminalState`，于是把陈旧的 `agent_starting` 投影为 `working`。

这不是 Companion 的 4 秒轮询延迟：轮询每次都会重新读取同一个错误状态源。安装版重启后持久化 Session 状态仍可保持陈旧，因此重启也不能根治。

## 目标

1. Attention Terminal Slot、Terminal Session 列表、状态接口与 App Home 使用同一个有效状态 resolver：有 running Panel 时以 Panel 聚合结果为准，没有 running Panel 时读取 `TerminalStateService` 的当前状态。
2. 全部 Panel 为 `agent_idle` 时，即使 `session.terminalState` 陈旧为 `agent_starting` 或 `agent_running`，也不生成 `working` Slot。
3. 任一 Panel 为 `agent_running` 或可信 `agent_starting` 时，即使 Session 状态陈旧为 idle，也必须生成 `working` Slot。
4. 保持 Completion、Terminal failed、Agent Team Slot 的现有优先级和退役语义不变。

## 非目标

- 不批量改写或迁移 `terminal-session-store.json` 中的历史 Session 状态。
- 不修改 Hook 接收、Stop 门禁、agent preparation 或 Panel 状态收敛规则。
- 不改变 `AttentionSnapshot` / `AttentionSlot` 的共享类型、HTTP 路径、鉴权或响应字段。
- 不修改 Companion 前端文案、布局、4 秒轮询或 Electron 窗口生命周期。
- 不新增单元测试文件；继续使用 YAML 测试计划、类型检查、Lint 和真实桌面行为验收。

## 设计判断

### 状态权威

`session.terminalState` 是兼容性与持久化回退值，不是存在 Panel Workspace 时的最终展示真相。有效状态按以下规则计算：

```text
runningPanels = session 下 status=running 的 Panel

runningPanels 非空
  -> aggregatePanelTerminalState(runningPanels)

runningPanels 为空
  -> terminalStateService.getCurrent(session.id, session)
```

`TerminalStateService.getCurrent(...)` 会优先读取进程内 `TerminalStateStore`，再回退持久 Session；直接读取 `session.terminalState` 不能等价替代。修复应把这套规则下沉为非 route 的共享 application helper，让所有展示读路径复用，而不是在 snapshot 时产生写副作用去“修复”Session 存储。

### 修改落点

新增 `backend/src/terminal/application/terminal-state-projection.ts`，提供唯一读投影：

```ts
resolveEffectiveTerminalState(
  terminalSessionManager,
  terminalStateService,
  session,
): TerminalState | undefined
```

规则固定为：

1. 过滤 `status === "running"` 的 Panels；非空时复用 `aggregatePanelTerminalState`。
2. 无 running Panel 且存在 `TerminalStateService` 时调用 `getCurrent(session.id, session)`。
3. 仅为保持既有可选依赖调用方兼容，当 service 未注入时才回退 `session.terminalState`。

然后让 Terminal Session 列表、状态接口、App Home 与 Attention 全部调用该 resolver。`AttentionService` 构造器新增 `TerminalStateService` 依赖，由现有 `runtime-services.ts` 注入。

Attention 只在 Terminal `working` 分支使用 `effectiveTerminalState`：判定、标题 fallback、detail 和 `source.evidence` 必须来自同一个有效当前状态。Completion 是历史事件，本次保持原分支不变；若后续校正完成者身份，应单独使用 `event.payload.source`，不能使用当前 Panel 状态。

## 用户可见行为

- 当前截图中的 3 个假 `working` Slot 会在下一次 Attention snapshot 后消失；若没有其他 Slot，Companion 显示安静宠物。
- 真正存在 `agent_running` Panel 的 Session 仍显示“执行中”。
- 多 Panel Session 中，只要任一 running Panel 为 `agent_running`，聚合结果仍为 running；全部 Panel idle 时不显示执行中。
- 未确认 Completion 仍优先显示 `completed`，不会因为有效状态为 running 而覆盖 Completion。
- Agent Team run 仍优先于同 Session 的普通 Terminal 状态。

## 文件范围

| 文件                                                            | 修改职责                                                         |
| --------------------------------------------------------------- | ---------------------------------------------------------------- |
| `backend/src/terminal/application/terminal-state-projection.ts` | 新增唯一有效 Terminal 状态读投影                                 |
| `backend/src/routes/terminal-session-route-helpers.ts`          | 移除 route 层本地状态 resolver                                   |
| `backend/src/routes/terminal.ts`                                | Session 列表与更新响应改用共享 resolver                          |
| `backend/src/routes/terminal-state.ts`                          | 状态接口改用共享 resolver                                        |
| `backend/src/routes/app-home-overview.ts`                       | App Home 改用共享 resolver，删除本地重复实现                     |
| `backend/src/attention/attention-service.ts`                    | 使用共享有效状态生成 Terminal working Slot，保持 Completion 不变 |
| `backend/src/bootstrap/runtime-services.ts`                     | 向 AttentionService 注入现有 TerminalStateService                |
| `docs/testing/platform/desktop-slot-companion.testplan.yaml`    | 新增 Session/Panel 状态分叉回归用例 `DSC-013`                    |

不需要修改 `frontend/src/components/desktop-companion/desktop-companion.tsx`、共享 Attention DTO 或 Electron 代码。

## 实施步骤

### 1. 建立共享有效状态 resolver

- 在 `backend/src/terminal/application/terminal-state-projection.ts` 实现上述三段式规则。
- 复用现有 `aggregatePanelTerminalState` 与 `TerminalStateService.getCurrent`，不复制状态优先级或 store 读取逻辑。
- helper 保持只读，不更新 Session、Panel 或 TerminalStateStore。

完成判断：所有展示读路径只通过同一个 resolver 决定当前 Terminal 状态。

### 2. 替换既有重复读路径

- `terminal.ts`、`terminal-state.ts` 和 `app-home-overview.ts` 改用共享 resolver。
- 删除 `terminal-session-route-helpers.ts` 与 App Home 中被替代的本地 resolver/重复聚合代码。
- 保持 service 可选调用方的既有兼容行为；生产 runtime 始终注入真实 `TerminalStateService`。

完成判断：不存在 route 层与 Attention 层各自维护的状态投影规则。

### 3. Attention 只修正 working 当前状态

- `AttentionService` 注入 `TerminalStateService`，每个 Session 取得 `effectiveTerminalState`。
- 保持现有顺序：Agent Team Slot → Terminal failed → 未确认 Completion → Terminal working。
- 只让 working 判定、标题 fallback、detail 与 `source.evidence` 使用有效当前状态。
- Completion 分支保持不变，不用当前 Panel 状态重写历史完成者文案。
- 不改变 `attentionId` 格式和排序规则。

完成判断：错误 working 状态被纠正，Completion 和其他 Slot 行为没有扩大改动。

### 4. 执行回归验收

- 使用 `DSC-013` 构造三种同一状态投影不变量：
  - Session 为 starting/running、全部 Panel idle；
  - Session 为 idle、至少一个 Panel running。
  - 没有 running Panel，进程内 TerminalStateStore 与持久 Session 状态分叉。
- 同时读取 `/api/terminal/session/:id/state` 与 `/api/attention/slots`，确认两者状态语义一致。
- 使用 `$computer-use` 打开目标 macOS 桌面实例，再用 `$toolkit:playwright-cli` 附着该实例 desktop CDP，确认 Companion 只展示真实 working Slot。

完成判断：API 与真实 Companion UI 均不再出现假阳性，也不产生 running 假阴性。

## API、兼容与安全边界

- API 路径仍为 `GET /api/attention/slots`。
- `AttentionSnapshot` 与 `AttentionSlot` 字段保持不变；客户端无需迁移。
- 鉴权中间件和 Connection 隔离不变。
- 只读取内存中的 Panel 记录，不读取 scrollback、命令文本或新增敏感信息。
- `AttentionService` 只增加进程内 service 依赖，不新增网络调用、定时器或存储。
- 没有数据迁移；回滚共享 resolver、各读路径 import 与 AttentionService 构造注入即可恢复原行为。

## 风险与控制

1. **多 Panel 聚合优先级回归**：必须复用 `aggregatePanelTerminalState`，不在 Attention 内复制 running/starting/idle 优先级。
2. **Completion 被 working 覆盖**：保持 Completion 分支位于 working 之前并 `continue`。
3. **历史 Completion provider 被当前状态污染**：本次不修改 Completion agent 文案；未来需要时只使用 completion event source。
4. **无 Panel 回退继续分叉**：共享 resolver 必须调用 `TerminalStateService.getCurrent`，不能简化为直接读取 Session。
5. **模块循环依赖**：projection helper 只依赖 manager 类型、TerminalStateService 与纯聚合函数；routes 和 Attention 单向依赖 application helper。
6. **证据字段继续报旧值**：working 的 title、detail 与 `source.evidence` 必须使用同一个 `effectiveTerminalState`。
7. **性能**：`listPanels(session.id)` 只查询该 Workspace 的 panelIds 与内存 Map；禁止在 resolver 中增加 I/O 或全量存储扫描。

## 验证命令与通过标准

```bash
pnpm testplan:validate docs/testing/platform/desktop-slot-companion.testplan.yaml
pnpm typecheck
pnpm lint
git diff --check
```

通过标准：

1. 上述静态门禁全部退出码为 0。
2. `DSC-013` 的 Panel 双向分叉和无 Panel 内存状态回退均通过。
3. `/api/terminal/session/:id/state` 与 `/api/attention/slots` 对同一 Session 的 working/idle 判断一致。
4. 真实 Electron Companion 中只展示 Panel 聚合后确实 starting/running 的 Terminal Slot。
5. Completion、failed、Agent Team Slot 的现有行为无变化。

## 回滚

该修改不迁移数据、不改变协议。若出现回归，整体回退共享 projection helper、各读路径 import 和 AttentionService 构造注入即可恢复原行为；不需要恢复或改写任何 Session/Panel 数据。测试计划保留用于说明已知风险和后续修复验收。
