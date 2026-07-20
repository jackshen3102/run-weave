# Desktop Companion Terminal 状态投影一致性方案评审

## 结论

方案的主方向成立：存在 running Panel 时，Attention 应与 Terminal 页面一样使用 `aggregatePanelTerminalState(...)`，这能直接消除当前 3 个假 `working` Slot。该路径无数据迁移、无协议变化、无鉴权变化，Panel 读取也是内存 Map 查询，不存在明显性能副作用。

但当前计划有 2 个 P1 缺口，建议修订后再实现。

## 发现

### P1：无 Panel 回退没有真正复用 Terminal 页的有效状态语义

计划把无 running Panel 的回退定义为 `session.terminalState`，同时声称与 `resolveTerminalStateFromPanels(...)` 完全一致（计划第 34-48、80-84 行）。真实 Terminal 路径回退的是 `terminalStateService.getCurrent(session.id, session)`，它会优先读取独立的内存 `TerminalStateStore`，只有没有内存值时才退到持久 Session。两者可能分叉。

影响：有 Panel 的当前缺陷会修复，但没有 running Panel 的 Session 仍可能在 Companion 与 Terminal 页面之间显示不同状态，违反方案目标 1 和验收标准 3。

定位：

- `docs/plans/2026-07-20-desktop-companion-terminal-state-projection.md:34`
- `docs/plans/2026-07-20-desktop-companion-terminal-state-projection.md:80`
- `backend/src/routes/terminal-session-route-helpers.ts:139`
- `backend/src/terminal/terminal-state-service.ts:151`

修复方向：把有效状态解析下沉到非 route 的 application helper，并让 Attention 与 Terminal route 共同调用；`AttentionService` 构造时注入现有 `TerminalStateService`。不要从 Attention 反向导入 route helper。

### P1：Completion 文案不应改读“当前 Panel 状态”

计划要求 Terminal Completion 的 agent 文案也改用 `effectiveTerminalState`（计划第 52-57 行）。Completion 是历史事件，当前 Panel 可能已变为 `shell_idle`、切换到另一个 agent，或开始下一轮；用当前状态描述历史完成者会产生错误文案。

Completion event 已有 `payload.source`，它才是本次完成事件的 provider 身份。当前缺陷只涉及 Terminal `working` 判定，不需要扩大到 Completion 文案。

影响：修复执行中假阳性的同时，可能把既有准确的 Completion provider 文案改错，属于不必要的用户可见回归。

定位：

- `docs/plans/2026-07-20-desktop-companion-terminal-state-projection.md:52`
- `backend/src/attention/attention-service.ts:186`
- `packages/shared/src/terminal/completion.ts:34`

修复方向：最小方案是 Completion 分支保持不变；若要顺带校正 provider，应优先使用 `event.payload.source`，只在事件缺失时回退 Session metadata，并作为独立需求验收。

## 残余风险

### P2：Panel 真相本身仍依赖 Hook 与 reconcile 正确更新

改为 Panel 聚合后，Session-only 状态写入不会再让 Companion 单独显示 running。如果某条异常链只更新 Session、漏更新 Panel，Companion 会与 Terminal 页面一起产生 running 假阴性。不过这是既有 Terminal 权威模型的共同风险，不是本方案新增的独立状态规则。

控制方式：保留 `DSC-013` 的双向分叉，并在真实 Hook 生命周期中验证 `idle -> running -> idle`，不能只直接修改存储 fixture。

定位：

- `docs/testing/platform/desktop-slot-companion.testplan.yaml:203`
- `backend/src/terminal/agent-hook-processor.ts:257`

## 无明显副作用项

- 性能：`listPanels(session.id)` 只按该 Workspace 的 panelIds 查询内存 Map，4 秒轮询下开销很小。
- 数据：snapshot 保持只读，不迁移、不回写 Session/Panel。
- 协议：`AttentionSnapshot`、`AttentionSlot` 和 HTTP 路径不变。
- 安全：不新增输入、权限、token、scrollback 或日志内容暴露。
- 排序：保持 Agent Team、failed、Completion、working 的现有分支顺序，不改变优先级。

## 更简单方案对比

### 方案 A：只在 Attention 内计算 Panel 聚合

优点：只改一个实现文件，能解决当前有 Panel 的假 `working`。

缺点：无 Panel 回退仍与 TerminalStateService 分叉，状态规则继续复制；只能称为当前缺陷的局部修复。

### 方案 B：下沉共享有效状态 resolver（推荐）

在 `backend/src/terminal/application/` 提供唯一 resolver：有 running Panel 时聚合 Panel，否则调用 `TerminalStateService.getCurrent(...)`。Terminal route 与 Attention 共同使用，App Home 可在后续或本次一起接入同一 helper。

优点：严格满足“同一状态源”，不会留下无 Panel 分叉，长期维护成本更低。

代价：比方案 A 多一个 application helper、一个构造依赖和少量 import 调整，但仍无协议或存储迁移。

## 建议后的实施边界

1. 采用方案 B，统一有效状态 resolver。
2. 只让 Terminal `working` 判定、标题 fallback、detail 与 evidence 使用有效当前状态。
3. Completion 分支保持现状；provider 校正另行使用 completion event source。
4. 执行 `DSC-013` 双向分叉和真实 Hook 状态迁移验收。
