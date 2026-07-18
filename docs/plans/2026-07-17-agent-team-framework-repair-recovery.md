# Agent Team 框架修复与重启恢复计划

## 目标

当 Agent Team 运行过程中发现 Runweave 框架本身存在问题时，主 Agent 可以安全地暂停当前 Run 的推进，完成框架修复和应用重启，然后只做一个明确选择：

1. **继续原 Run**：当前现场仍可信、目标 Worker 仍可使用时，保留原 runId 和已有执行历史，重新派发需要继续处理的工作。
2. **重新运行**：当前现场已经不适合继续时，结束旧 Run，并基于原任务和验收输入创建一个全新的 Run。

计划成功的核心标准：

- 框架修复期间，旧 Worker 的迟到结果不会继续推进 Run。
- 应用重启后，用户只需要判断“继续”还是“重新运行”。
- continue 不清空可信历史，rerun 不继承旧执行结论。
- 整个过程不要求恢复到旧 prompt 的字符位置，也不要求物理终止正在运行的 Worker。

## 核心原则

### 1. 逻辑暂停，不强制中断 Worker

发现框架问题后，把当前 Run 标记为“框架阻塞”。

框架阻塞是一种业务含义，实现时可以复用现有 need_human 状态并增加专用标记，不要求扩展一套复杂的顶层状态机。

进入框架阻塞后：

- 保存当前需要恢复的 Worker role、caseIds 和旧 dispatch 身份。
- 撤销旧 dispatch 对 Run 的推进权。
- 不主动 interrupt、kill 或关闭 Worker pane。
- Worker 可以继续运行或写出结果，但旧结果不再改变 Run。

### 2. 修复和重启独立完成

框架阻塞后，主 Agent 使用现有开发流程修复代码、构建并重启应用。

Agent Team 不负责：

- 自动修改或回滚框架代码；
- 恢复输入到一半的 prompt；
- 拼接旧 prompt 的剩余内容；
- 在应用重启前自动决定 continue 或 rerun。

### 3. 重启后只判断现场能否继续

continue 只需要确认：

- 原 Run 仍处于框架阻塞状态；
- Backend 已完成重启；
- 保存的 Worker role 和 caseIds 仍能明确识别；
- 目标 Worker pane 仍存在并能够接收新的任务。

以上条件不满足时，不猜测、不修补现场，直接建议 rerun。

## 核心流程

    running
      ↓ 主 Agent 发现框架问题
    framework_blocked
      ↓ 修复框架并重启应用
      ├─ 现场可继续   → continue → 原 Run 恢复运行
      └─ 现场不可继续 → rerun    → 旧 Run 结束，新 Run 启动

## 三个操作

### begin：记录并暂停现场

begin 的目标是让旧执行失去状态机权限，而不是停止所有进程。

它需要完成：

- 记录阻塞原因和重启前 Backend 身份；
- 保存恢复目标：Worker role、caseIds 和旧 dispatch；
- 将 Run 标记为框架阻塞；
- 清除旧 active dispatch 的执行权；
- 保留 acceptance、evidence、repair 记录、checkpoint 和已完成案例。

相同 Run 已经处于框架阻塞时，不重复创建新现场。

### continue：用新 prompt 继续原 Run

continue 不恢复旧 dispatch，也不拼接旧 prompt。

它基于保存的任务和现场信息，向目标 Worker 发送一条完整的新 prompt。新 prompt 至少说明：

- 这是框架修复并重启后的继续执行；
- 原任务和本次需要处理的 caseIds；
- 旧 dispatch 已失效；
- 本次使用新的 dispatchId 和对应 outbox 合同。

continue 成功后：

- 保持原 runId；
- 保留已有可信历史和通过结果；
- 只重新派发保存的恢复目标；
- 清除框架阻塞标记，Run 恢复运行。

若 prompt 投递失败，Run 继续保持框架阻塞，用户可以再次 continue 或改选 rerun。这里不追求 prompt exactly-once，也不为极端发送时序设计额外事务。

### rerun：结束旧 Run 并重新开始

rerun 用于现场不可信、Worker pane 不可用或改动过大时。

它需要：

- 保留并结束旧 Run，记录“因框架修复而重新运行”；
- 使用原 task、验收来源、terminal 配置和运行选项创建新 Run；
- 新 Run 使用新的 runId 和新的 Worker dispatch；
- 不继承旧 Run 的 pass、evidence、loop 计数、repair attempts 或 consumed dispatch receipts；
- 保留旧 Run 与新 Run 的关联，便于用户回看。

创建新 Run 前先确认 terminal session 和基本输入仍可用。创建失败时旧 Run 继续保持框架阻塞，并给出清晰错误，让用户可以再次 rerun，不静默回到通用 resume。

## 用户可见行为

框架阻塞时，CLI 和 Agent Team 面板展示：

- 阻塞原因；
- 是否已经检测到 Backend 重启；
- 当前现场是否可以 continue，以及不能继续的原因；
- “继续原 Run”和“重新运行”两个动作。

不增加 migrate、supersede、archive 等额外用户决策。

## 最小数据范围

框架恢复只需要持久化：

- repairId 和阻塞原因；
- begin 时间和重启前 Backend 身份；
- 保存的 Worker role、caseIds 和旧 dispatch；
- 当前结果：blocked、continued 或 rerun；
- continue 的新 dispatchId，或 rerun 的 successorRunId。

更细的内部 helper、字段拆分和存储方式由实现阶段根据现有代码风格决定。

## 修改范围

- packages/shared/src/agent-team.ts：补充最小 framework repair 合同和 Run 关联字段。
- backend/src/agent-team/：实现 begin、continue、rerun，并确保旧 dispatch/outbox 不再推进阻塞后的 Run。
- backend/src/routes/agent-team.ts：提供读取恢复状态和执行三个操作的接口。
- packages/runweave-cli/src/commands/agent-team.ts：提供对应 CLI 操作。
- frontend/src/components/terminal/：展示框架阻塞状态和两个恢复动作。
- docs/testing/agent-team/agent-team-framework-repair-recovery-test-cases.md：记录核心验收场景。

不为本需求升级通用 JSON 存储、terminal ownership、跨版本迁移或分布式投递协议。

## 实施顺序

1. 增加最小 framework repair 数据合同和读取兼容。
2. 实现 begin，并阻止旧 dispatch、迟到 outbox 和通用 resume 绕过框架阻塞。
3. 实现 continue，复用现有 Worker 派发能力发送完整的新 prompt。
4. 实现 rerun，复用现有 Run 创建流程生成全新 Run。
5. 接通 CLI、UI 和必要日志。
6. 按核心测试 Case 完成真实重启验收。

## 核心验收标准

详细步骤见：

- docs/testing/agent-team/agent-team-framework-repair-recovery-test-cases.md

计划完成必须同时满足：

- begin 后 Run 保留现场，但旧 Worker 结果不能再推进它。
- 重启后现场可用时，continue 保持原 runId并派发一条完整的新任务。
- prompt 投递失败时，Run 保持框架阻塞且可以再次操作。
- 现场不可用时，continue 明确拒绝并允许 rerun。
- rerun 创建全新 Run，只继承任务输入，不继承旧执行结论。
- UI 和 CLI 最终只向用户提供“继续原 Run”和“重新运行”两个选择。

## 非目标和不覆盖范围

- 不恢复或拼接输入到一半的 prompt。
- 不保证 prompt exactly-once。
- 不处理写入中断、响应丢失、极短崩溃窗口等罕见时序。
- 不覆盖多个并发 continue/rerun 请求。
- 不引入 terminal active-run binding、control outbox、receipt、revision/CAS 或源码指纹体系。
- 不新增单元测试文件；验证使用现有 typecheck/lint、行为验证脚本和真实 UI 操作。
- 不修改普通 Run 在没有 framework repair 标记时的现有重启恢复行为。

## 风险与回滚

本需求唯一必须守住的风险是：旧 dispatch 在框架阻塞后仍然推进 Run。实现和验收都应优先证明这条边界。

新字段保持可选。功能关闭或代码回滚后，历史 Run 仍按现有 need_human/failed 语义读取；不删除旧 Run、outbox、checkpoint 或 Worker pane。
