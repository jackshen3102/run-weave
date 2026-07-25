---
name: review-with-runtime-evidence
description: 仅当用户在当前请求中显式指定 $toolkit:review-with-runtime-evidence 时使用；对给定变更或评审 Case 先由 gpt-5.6-sol、traex/gpt-5.4、traex/openrouter-3o 三模型独立静态审查，再对多数命中的严重候选执行真实运行时干净版/目标版对照，裁决为自动阻塞、驳回、未裁决或需要辩论。不要因普通代码审查、Bug 修复、测试、复现或“多模型审查”等相似请求自动触发。
---

# 运行时证据评审

把静态审查当作候选生成器，把真实运行时对照当作裁决器。静态词汇、模型置信度和严重级别都不能直接阻塞。

## 调用边界

- 仅当用户在当前请求中精确点名 `$toolkit:review-with-runtime-evidence` 时使用。
- 显式调用只对当前请求有效，不跨请求或后续轮次延续。
- 普通代码审查、PR review、Bug 修复、测试、真实复现、多模型审查等措辞都不能隐式触发。
- 本技能只产出裁决，不自动修复实现、不提交代码、不改变 PR/CI 状态。需要修复或外部阻塞动作时，另行取得用户授权。

## 固定模型与独立性

固定使用：

1. `codex` + `gpt-5.6-sol`
2. `traex` + `gpt-5.4`
3. `traex` + `openrouter-3o`

三个模型必须接收完全相同的需求与 diff，在隔离、只读、无插件、无仓库访问的上下文中独立审查；不得看到其他模型输出。不要静默替换模型。

模型不可用或输出协议连续失败时：

- 不把失败当作“未发现问题”；
- 已有至少两个独立严重票的候选仍可进入运行时复现；
- 少于两个严重票且存在缺失模型时，标记静态阶段未完成，不能宣称“没有问题”。

执行静态阶段前读取 [references/contracts.md](references/contracts.md)，使用 `scripts/run-static-review.mjs`。脚本只输出候选，不执行旧式文字 evidence gate。

## 执行流程

### 1. 固定评审边界

记录：

- source root、base revision 和目标 diff；
- 稳定 requirement ID 与可观察需求；
- 本次已有改动和用户无关改动；
- 每个 Case 的 target 版本与 clean control。

真实变更评审中，target 是待评 patch，clean control 是不含该 patch 的基线。流程实验中，可以使用故障变异版和对应干净版。不得在用户工作区原地切换或覆盖代码；需要两个 source root 时使用精确的隔离 Worktree，并遵守最近的 `AGENTS.md`。

### 2. 三模型只产生静态候选

要求每个模型只报告具有具体执行路径的 P0/P1；P2/P3 不进入阻塞候选。

按同一 requirement 或同一可执行行为不变量聚类，不按措辞相似度机械计票：

- 两个或三个模型独立命中同一严重问题：进入真实运行时复现；
- 只有一个模型命中：记录为 singleton，不阻塞，不启动辩论；
- 没有多数候选：结束运行时阶段，但保留协议失败和 singleton。

脚本会自动聚合带 requirement ID 的 finding。对 `unmappedSevere`，必须人工按生产入口、触发条件和失败结果判断是否属于同一不变量；无法可靠聚类时不凑票。

### 3. 为每个多数候选选择最低成本的真实执行层

不要把所有 Case 生硬塞进 Dev Session。

| 候选类型                  | 真实证据层                                                                                                     |
| ------------------------- | -------------------------------------------------------------------------------------------------------------- |
| UI、Electron、页面交互    | 真实 Electron + `$toolkit:playwright-cli`；实际执行 Dev Session 命令时同时使用 `$toolkit:runweave-dev-session` |
| tmux、pane、terminal hook | 真实 tmux session/pane + 生产 processor/service                                                                |
| Backend 启动、服务装配    | 真实 `createRuntimeServices()` 或当前生产启动入口                                                              |
| 纯策略、决策函数          | 直接执行生产函数                                                                                               |
| API、Git、存储、事件流    | 生产 Router/service/adapter + 真实临时资源                                                                     |
| 平台或设备专属行为        | 对应真实平台或设备；缺失时标记未裁决                                                                           |

fixture 可以建立受控输入和资源生命周期，但最终现象必须来自生产函数、生产服务或真实子系统。mock、stub、伪造响应、代码阅读和静态检查不能单独形成裁决证据。

### 4. 执行 target 与 clean control 对照

两版必须保持相同：

- 触发入口、用户步骤和输入；
- 数据、环境、权限和关键时序；
- 观察点和判定阈值。

唯一允许变化的是被评 patch。分别记录：

- 前置条件是否真实建立；
- target 的可观察结果；
- clean control 的可观察结果；
- 命令、日志、DOM、接口、Git、存储或事件证据；
- 资源身份和清理结果。

静态检查、typecheck 和 lint 只证明样本可执行，不替代行为结果。偶发路径要按风险与成本重复，直到能区分行为与噪声。

### 5. 使用固定真值表裁决

把每个候选的结构化证据写成 [references/contracts.md](references/contracts.md) 定义的 runtime input，并执行 `scripts/classify-runtime-verdict.mjs`。

| 条件                                   | 裁决              |
| -------------------------------------- | ----------------- |
| 严重静态票少于 2                       | `not_candidate`   |
| 前置条件无法建立                       | `inconclusive`    |
| target 失败、clean 通过                | `automatic_block` |
| 有效触发已执行，target 与 clean 都通过 | `dismissed`       |
| clean 失败、任一版本未执行或对照被污染 | `inconclusive`    |
| 模型仍对运行时证据存在严重分歧         | `debate_required` |

`automatic_block` 只是本技能的机器裁决，不代表已修改外部 PR、CI 或任务状态。

### 6. 只在运行时证据严重分歧时辩论

以下情况不启动辩论：

- 静态模型意见不一致；
- 单模型 finding；
- 模型输出格式错误；
- 缺少平台、权限、数据或服务；
- target/clean 对照被污染。

只有在有效触发、target 和 clean 都已真实执行后，模型仍严重分歧于“观察结果是否构成需求失败”时，才把同一份不可变运行时证据交给模型辩论。不得重新用文字推测覆盖原始证据。辩论仍无法消除分歧时，最终标记 `inconclusive`。

### 7. 清理并交付

停止本次拥有的 session、pane、进程和临时资源，移除本次创建的隔离 Worktree；不得影响共享服务、用户已有 tab、pane 或无关改动。

最终报告至少包含：

- 三模型逐一结果、协议失败和多数候选；
- 每个候选的真实执行层与触发条件；
- target/clean 并列证据；
- `automatic_block`、`dismissed`、`inconclusive`、`debate_required` 数量；
- 实际辩论次数；
- 未执行项和环境前置条件；
- 资源清理结果。

不要把 `inconclusive` 统计为通过、驳回或没问题。
