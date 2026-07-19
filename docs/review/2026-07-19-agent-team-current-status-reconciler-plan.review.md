# Agent Team current-status reconciler 方案评审

## 结论

当前方案不能按“直接复用现有 `AgentThreadStatusReconciler`”实施，评审结论为 **有条件不通过**。

原因不是历史 `Stop` 乱序问题；改为读取当前 thread status 已经消除了该主要风险。剩余的阻断问题是：现有 reconciler 会把 `notLoaded` 且此前为 `running` 的线程推断成 `idle`。若 bounce 据此放行，就可能向仍在执行但暂时无法加载状态的 Codex turn 注入输入。

把 `notLoaded` 收紧为 `unknown`、仅允许显式 `idle` 放行后，方案不存在已知的不可接受状态破坏；剩余副作用是可控的等待与可用性下降。

## Findings

### P1 — `notLoaded` 被推断为 `idle`，可能向活跃 turn 投递 bounce

- `app-server/src/agent-thread-status-reconciler.ts` 当前将 `readThreadStatus()` 返回的 `notLoaded` 在旧状态为 `running` 时转换为 `idle`。
- `app-server/src/codex-app-server-client.ts` 在 `thread/read` 未加载后会尝试 `thread/resume`，但恢复失败或仍不可用时依旧可能返回 `notLoaded`。
- 因此 `notLoaded` 只证明“当前无法确认”，不证明“线程已空闲”。若这个推断成为 bounce 的授权条件，会重现本次问题最危险的副作用，只是触发源从历史 `Stop` 换成了状态读取失败。

修正要求：bounce 路径只接受 Codex 明确返回的 `idle`。`active` 视为未就绪；`notLoaded`、系统错误、超时和空结果都视为 `unknown` 并 fail closed。读取完成后还必须确认 `lastEventId` 未变化，才允许提交 `agent_idle`。

### P2 — 依赖全局周期扫描会产生 30–60 秒恢复延迟，并可能被候选上限饿死

- reconciler 默认启动延迟为 10 秒、轮询间隔为 30 秒；发现近期状态变化时还会再延迟一个轮询周期。
- 全局扫描最多处理最近三小时内的 100 个候选线程，并串行读取。繁忙实例超过上限时，目标 code pane 可能不在本轮候选中。

修正要求：bounce 前按精确的 panel/thread 做一次目标化 current-status reconcile，不把全局周期扫描当作 bounce 的同步前置条件。该读取需要去重、设置短超时，并保留全局 reconciler 作为后台自愈。

### P2 — 只能更新显式 panel，不能回退到父 session owner

- `backend/src/app-server/handlers/agent-lifecycle.ts` 当前 owner 表达式可能在 panel 当前 identity 缺失时回退到 session。
- 多 pane session 下，这会把一个 code pane 的生命周期结果写到父 session 或与其他 pane 的 identity 混合。

修正要求：last-thread mapping 只用于定位目标 panel；生命周期落盘必须使用事件中精确匹配的 panel/tmux/provider/thread identity。只更新目标 panel，再重新聚合 session，不能把 panel 观察结果写成 session 当前线程身份。

### P2 — reconciler 是补偿机制，不是 metadata 提前清空的根因修复

当前现场同时存在 `activeCommand=codex`、`terminalState=agent_starting`、`lastThreadStatus=idle` 和 current thread metadata 缺失。目标化 reconcile 能解除阻塞，但如果不继续定位 current identity 被提前清空的路径，状态仍可能反复在 starting/running/idle 间漂移，长期依赖补偿修复。

修正要求：本次可先以最小修复恢复 bounce；同时把 metadata 清空条件作为独立根因项跟进，不在同一 patch 中顺手重构。

## 建议的最终安全合同

1. 不消费历史裸 `Stop` 作为当前空闲证明。
2. bounce 前按目标 panel 的 last thread identity 读取一次当前 Codex 状态。
3. 仅显式 `idle` 可以放行；`active`、`notLoaded`、错误和超时全部阻断。
4. 状态读取前后 `lastEventId` 必须一致，并精确校验 panel、tmux pane、provider、threadId。
5. 只给目标 panel 应用 `agent_idle`，随后聚合 session 状态。
6. 全局周期 reconciler 继续负责后台自愈，但不承担 bounce 的确定性门禁。

## 收紧后的剩余副作用

- bounce 会增加一次当前状态读取延迟，通常是一次 App Server RPC；超时或 App Server 不可用时会暂时继续阻断，需要用户重试或后台自愈。
- 这是 fail-closed 的可用性代价，不会把不确定状态误判为空闲。相较向活跃 turn 注入输入，这个副作用可接受。

## 评审范围

本次仅评审方案与现有代码合同，未修改实现代码，未执行运行时验收。
