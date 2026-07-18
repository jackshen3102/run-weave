# Agent Team 框架修复与重启恢复测试 Case

## 来源与范围

- 需求来源：`docs/plans/2026-07-17-agent-team-framework-repair-recovery.md`。
- 来源未给出可追溯 case ID 前缀，因此本文件按主题新建并统一使用 `ATFR` 前缀。
- 覆盖 framework repair 的 begin、恢复状态读取、continue、rerun，以及对应 API、CLI、Agent Team 面板和重启恢复行为。
- 不验证应用更新器、框架代码如何修复，也不把 `typecheck` / `lint` 当作行为通过证据。

## 前提事实

- 当前 Run 事实源是项目内 `.runweave/agent-team/<runId>.json`；Worker 结果从 pane-scoped outbox 回流，并由 `runId`、pane 身份和 dispatch 身份约束。
- 当前 Agent Team 已有 `need_human`、active dispatch、completion/outbox 消费和 `resume` 能力；本需求在这些现有机制上增加 framework repair 语义，不另造复杂顶层状态机。
- begin 的目标是撤销旧 dispatch 对 Run 的推进权，不是 interrupt、kill 或关闭 Worker pane。
- continue 必须保留原 runId 和可信历史，并用新 dispatchId 向原目标 Worker 发送一条完整新 prompt。
- rerun 必须保留旧 Run，同时通过现有 Run 创建能力生成新 runId；新 Run 只继承任务输入，不继承旧执行结论。
- 共享合同位于 `packages/shared/src/agent-team.ts`，状态机位于 `backend/src/agent-team/`，HTTP route 位于 `backend/src/routes/agent-team.ts`，CLI 位于 `packages/runweave-cli/src/commands/agent-team.ts`，面板位于 `frontend/src/components/terminal/`。
- 本仓库不新增单元测试文件。状态机与协议使用可执行行为验证脚本和 API/CLI 输出取证，真实页面使用 `$toolkit:playwright-cli` 取证。

## 设计方法与追溯矩阵

| 需求/风险                                       | 设计方法           | Case     |
| ----------------------------------------------- | ------------------ | -------- |
| begin 保存现场并使旧 dispatch 失效              | 状态迁移、错误猜测 | ATFR-001 |
| 重复 begin 不产生第二份现场                     | 幂等、状态迁移     | ATFR-002 |
| 重启后现场可信时继续原 Run                      | 场景法、判定表     | ATFR-003 |
| 新 prompt 投递失败仍可重试                      | 异常流、状态迁移   | ATFR-004 |
| 重启未发生或目标 pane 不可用时拒绝 continue     | 无效等价类、判定表 | ATFR-005 |
| rerun 创建干净的新 Run 并关联旧 Run             | 场景法、数据对比   | ATFR-006 |
| rerun 创建失败不破坏旧现场                      | 异常流、错误猜测   | ATFR-007 |
| 通用 resume 和迟到结果不能绕过 framework repair | 非法状态迁移       | ATFR-008 |
| UI 与 CLI 只暴露继续/重跑两个决策               | 多入口场景法       | ATFR-009 |
| 无 repair 标记的普通 Run 行为不回退             | 回归测试           | ATFR-010 |

## 验证环境与证据

每个 Case 使用独立 Run，禁止依赖上一条 Case 的遗留状态。至少保存：

- 操作前后的完整 Run JSON 和其中的 framework repair 记录；
- 旧 dispatch、新 dispatch、pane-scoped outbox 及其 mtime/内容摘要；
- Backend 重启前后的可区分身份和恢复状态 API/CLI 输出；
- 目标 Worker pane 收到的新 prompt，或明确的投递失败证据；
- 涉及 UI 时的 Playwright DOM 快照和截图。

真实页面验证必须按仓库 Dev Session 约定启动隔离实例，再用 `$toolkit:playwright-cli` 附着该实例；静态代码阅读或截图不能替代真实交互证据。

## 必跑命令

实现完成后按顺序执行，任一失败即停：

    pnpm typecheck
    pnpm lint
    pnpm agent-team:verify-framework-recovery
    git diff --check

其中 `pnpm agent-team:verify-framework-recovery` 是本需求的协议/状态机行为验证入口，必须覆盖下列非 UI Case；静态检查只是前置门禁。

## 核心 Case

### ATFR-001 begin 后旧 Worker 的迟到结果不再推进 Run

前置条件：

- 准备一个 `executing/running` Run，存在 active Worker dispatch。
- Run 已包含至少一个通过案例、evidence、repair 记录和可辨识的 round。

步骤：

- 调用 framework repair begin，记录返回值、Run JSON 和旧 dispatch 身份。
- 不 interrupt 原 Worker，让它完成并写出旧 dispatch 对应的 pane-scoped outbox。
- 分别触发正常 completion 接收和重启后的 outbox 扫描。

期望：

- Run 进入框架阻塞语义，保存 repairId、原因、重启前 Backend 身份、恢复 role、caseIds 和旧 dispatch。
- active dispatch 的推进权被撤销，原 Worker pane 仍存在且未被 begin 强制关闭。
- 旧 completion 和旧 outbox 均不能改变 acceptance、round、repair 历史、active worker 或 Run 状态。
- begin 前已有的通过结果、evidence、checkpoint 和 repair 记录逐项保持不变。

失败判定：

- begin 清空可信历史、关闭 Worker pane，或任一旧 completion/outbox 使 Run 继续推进。

验证方式：行为验证脚本 + Run JSON/outbox 前后对比。

### ATFR-002 已处于框架阻塞时重复 begin 保持同一现场

前置条件：

- 准备一个已成功 begin 的框架阻塞 Run，并记录 repairId、保存目标和旧 dispatch。

步骤：

- 对同一 Run、同一框架问题再次调用 begin。
- 对比两次响应和第二次调用前后的 Run JSON。

期望：

- 第二次 begin 返回同一份框架修复现场，不创建新 repairId，不覆盖首次 begin 时间。
- 保存的 role、caseIds、旧 dispatch、可信历史和阻塞状态保持不变。
- 不产生额外 Worker 派发、pane 或 outbox。

失败判定：

- 重复 begin 新建现场、重置历史、修改保存目标或产生任何 Worker 副作用。

验证方式：行为验证脚本 + Run JSON 精确对比。

### ATFR-003 Backend 已重启且现场可用时 continue 原 Run

前置条件：

- 准备一个已 begin 的框架阻塞 Run，并记录原 runId 和重启前 Backend 身份。
- 完成 Backend 重启；保存的 Worker role、caseIds 和目标 pane 均可识别且可接收任务。

步骤：

- 读取恢复状态，确认已检测到 Backend 身份变化且 `canContinue` 为可继续。
- 执行 continue，检查目标 pane 收到的 prompt、Run JSON、CLI 输出和 Agent Team 面板。

期望：

- continue 保持原 runId、已有通过结果、evidence、checkpoint 和 repair 历史。
- 系统创建不同于旧 dispatch 的新 dispatchId，只派发保存的 role 和 caseIds。
- Worker 收到一条完整新 prompt，明确原任务、目标 caseIds、旧 dispatch 已失效、新 dispatchId 和新 pane-scoped outbox 合同；不拼接旧 prompt。
- 投递成功后清除框架阻塞标记，repair 结果记录为 `continued`，Run 恢复 `running`。

失败判定：

- 复用旧 dispatch、拼接旧 prompt、创建新 Run、重跑无关案例、清空历史，或未实际投递就标记 continued。

验证方式：行为验证脚本 + CLI/API 输出 + `$toolkit:playwright-cli` 真实页面验证。

### ATFR-004 continue 投递失败时保持框架阻塞并可重试

前置条件：

- 准备一个恢复状态判定为可继续的框架阻塞 Run。
- 在状态检查之后、实际投递之前让目标 pane 暂时不可接收 prompt。

步骤：

- 执行 continue 并记录失败响应和 Run JSON。
- 恢复同一目标 pane，再次读取恢复状态并执行 continue。

期望：

- 第一次失败后 Run 仍处于框架阻塞，repair 结果不伪造为 continued，原历史和保存目标不变。
- 系统不自动进入通用 resume，不切换其他 Worker，也不创建替代 pane。
- pane 恢复后，第二次 continue 使用新 dispatch 成功回到 `running`。

失败判定：

- 投递失败后丢失恢复入口、Run 被标记 running、历史或目标被重置，或必须手改 Run JSON 才能重试。

验证方式：行为验证脚本 + 两次响应和 Run JSON 对比。

### ATFR-005 现场条件不足时 continue 明确拒绝且仍可 rerun

前置条件：

- 分别准备两个独立的框架阻塞 Run：A 的 Backend 身份尚未变化；B 已重启但目标 Worker pane 不存在或不可投递。

步骤：

- 分别读取 A、B 的恢复状态并尝试 continue。
- 检查 API/CLI 错误、Run JSON 和 Agent Team 面板。

期望：

- A 明确显示“Backend 尚未完成重启”，B 明确显示目标 Worker pane 不可用；两者均为不可继续。
- 两次 continue 均被无副作用拒绝，旧 Run、可信历史、保存目标和 repairId 不变化。
- CLI 和 UI 对两个 Run 都保留“重新运行”，系统不猜测其他 Worker、不自动创建 pane。

失败判定：

- 未重启或不可信现场仍被继续；错误原因不可区分；系统选择错误 Worker、修改旧历史或禁用 rerun。

验证方式：行为验证脚本 + `$toolkit:playwright-cli` 真实页面验证。

### ATFR-006 rerun 创建全新 Run 且不继承旧执行结论

前置条件：

- 准备一个已 begin 且 Backend 已重启的 Run。
- terminal session、task、验收来源、terminal 配置和运行选项仍可用于创建新 Run。

步骤：

- 执行 rerun。
- 对比旧 Run、新 Run、Worker dispatch、验收输入和 Agent Team 面板。

期望：

- 旧 Run 被保留并记录 `rerun` 结果和 successorRunId；新 Run 使用不同 runId 并能关联回旧 Run。
- 新 Run 继承 task、验收来源、terminal 配置和运行选项。
- 新 Run 不继承旧 pass、evidence、loop 计数、repair attempts、checkpoint、active/consumed dispatch 或 framework repair 结果。
- UI 切换到新 Run，同时仍可回看旧 Run；新 Worker 使用新 dispatch。

失败判定：

- 覆盖旧 Run、复用旧 runId/dispatchId、继承旧执行结论，或新旧 Run 无法双向追踪。

验证方式：行为验证脚本 + Run JSON 对比 + `$toolkit:playwright-cli` 真实页面验证。

### ATFR-007 rerun 创建失败时旧 Run 保持框架阻塞

前置条件：

- 准备一个已 begin 的框架阻塞 Run。
- 使原 terminal session 或创建新 Run 所需的基础输入在 rerun 时不可用。

步骤：

- 执行 rerun 并记录错误响应。
- 恢复基础输入，再次执行 rerun。

期望：

- 第一次 rerun 明确说明创建失败原因，旧 Run 继续保持框架阻塞，repair 结果不伪造为 rerun。
- 第一次失败不创建半成品 successorRunId，不改变旧历史，也不静默回到通用 resume。
- 基础输入恢复后可再次 rerun，并满足 ATFR-006 的新旧 Run 隔离要求。

失败判定：

- 失败后旧 Run 被结束、出现无法读取的半成品新 Run、恢复入口丢失，或只能手改存储才能重试。

验证方式：行为验证脚本 + Run 存储清单和两次响应对比。

### ATFR-008 通用 resume 与旧 dispatch 均不能绕过框架阻塞

前置条件：

- 准备一个已 begin 的框架阻塞 Run，并保留旧 dispatch 的 completion/outbox 输入。

步骤：

- 对该 Run 调用现有通用 resume。
- 重放旧 dispatch 的 completion，并让 outbox 扫描重新观察旧 pane-scoped outbox。

期望：

- 通用 resume 被明确拒绝或保持 framework repair gate，不清除框架阻塞标记。
- 重放 completion 与重新扫描 outbox 均保持幂等，不改变 acceptance、round、repair 记录或 active worker。
- 只有 framework repair continue 或 rerun 能退出该阻塞状态。

失败判定：

- 通用 resume、completion 重放或 outbox 扫描中的任一路径恢复了旧 dispatch 的推进权。

验证方式：行为验证脚本 + Run JSON/outbox 对比。

### ATFR-009 恢复状态在 API、CLI 和面板只提供继续或重新运行

前置条件：

- 准备一个可 continue 的框架阻塞 Run 和一个不可 continue 的框架阻塞 Run。
- 使用真实 Agent Team 页面和与同一 Backend 配对的 CLI profile。

步骤：

- 分别从恢复状态 API、CLI 和 Agent Team 面板读取两个 Run。
- 在面板触发一次可用的 continue；对不可继续 Run 确认 rerun 仍可触发。

期望：

- 三个入口一致展示阻塞原因、Backend 是否已重启、是否可继续及不可继续原因。
- 用户决策仅有“继续原 Run”和“重新运行”；不增加 migrate、supersede、archive 或通用 resume。
- 不可继续时 continue 禁用或被拒绝，但 rerun 可用；可继续时两个选择都可用。

失败判定：

- 三个入口状态不一致、出现第三种恢复决策、按钮语义与实际 API 行为不符，或不可继续时两个动作同时失效。

验证方式：CLI/API 输出对比 + `$toolkit:playwright-cli` 真实页面 DOM/交互证据。

### ATFR-010 无 framework repair 标记的普通 Run 保持现有行为

前置条件：

- 准备一个没有 framework repair 标记的普通 `running` 或 `need_human` Run。

步骤：

- 执行现有重启恢复、通用 resume、completion/outbox 消费流程。
- 对比本需求实现前约定的 Run 状态变化和输出。

期望：

- 普通 Run 不进入 framework repair gate，不被要求选择 continue/rerun。
- 现有 resume、completion/outbox 身份校验和重启恢复语义保持不变。
- 新增可选字段缺失时仍能读取历史 Run。

失败判定：

- 普通 Run 被误判为框架阻塞、现有恢复路径失效，或旧 Run 因缺少新字段无法读取。

验证方式：行为验证脚本 + 历史/新建普通 Run JSON 对比。

## 覆盖判断与不覆盖范围

- 正常路径：ATFR-001、ATFR-003、ATFR-006、ATFR-009 覆盖。
- 错误态与依赖不可用：ATFR-004、ATFR-005、ATFR-007 覆盖。
- 状态迁移、迟到参数、幂等与去重：ATFR-001、ATFR-002、ATFR-004、ATFR-008 覆盖。
- 数据与共享协议：ATFR-001、ATFR-003、ATFR-006、ATFR-010 通过 Run JSON、dispatch 和 outbox 取证。
- 多入口：ATFR-009 覆盖 API、CLI 和 UI；UI 必须用 `$toolkit:playwright-cli`。
- 回归与兼容：ATFR-008、ATFR-010 覆盖。
- 权限与跨项目隔离：不覆盖；沿用现有 Agent Team route 门禁，本需求不改变该边界。
- 并发 continue/rerun：不覆盖；计划明确排除多个并发恢复请求。
- prompt 输入到一半、字符级拼接、prompt exactly-once、响应丢失和发送中的极短崩溃窗口：不覆盖；计划明确排除。
- JSON 写入中断、文件损坏、跨进程事务、存储 CAS、terminal active-run ownership、跨机器/跨版本迁移：不覆盖；均不在本次最小数据范围内。
- 应用更新器、框架代码修复、构建和回滚本身：不覆盖；Agent Team 只负责修复前后的逻辑暂停与恢复决策。

## 验收通过标准

- loader 能从本文件解析 `ATFR-001` 至 `ATFR-010`，每条都包含步骤、期望和失败判定。
- ATFR-001 至 ATFR-010 全部通过并保留各自指定证据；任一失败即整体不通过。
- 框架阻塞后，旧 Worker 的任何迟到结果和通用 resume 都不能推进 Run。
- continue 保持原 runId 和可信历史，只用新 dispatch 派发完整新任务；失败时保留恢复入口。
- rerun 创建干净的新 Run 并保留旧 Run；创建失败时旧现场不受损。
- API、CLI、真实页面只呈现“继续原 Run”和“重新运行”两个决策，且状态一致。
- 普通 Run 和历史 Run 的现有恢复、读取行为不回退。
