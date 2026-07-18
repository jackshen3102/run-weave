# agent-self-evolution-v1（个人本地 Agent 自进化架构方案）

基于 Runweave 当前 Activity、Work History、Agent Team 与 App Server 事件数据设计的可运行 HTML 架构原型。它回答的是“整套自进化能力如何运转”，不是产品页面稿，也不代表目标模块已经实现。

## 启动

```bash
python3 -m http.server 6188 --directory docs/architecture-flows/agent-self-evolution-v1
```

打开：

```text
http://127.0.0.1:6188/
```

## 一句话结论

自进化不是“定期分析历史并输出报告”，而是下面这个闭环：

```text
历史事实
  → Episode（可学习单元）
  → 归因 / 聚类 / 反例
  → 候选资产
  → Shadow Replay / Champion-Challenger
  → 晋级 / 拒绝 / 退休
  → 注入下一次执行
  → 产生新事实并继续评估
```

缺少“评估门禁”和“重新注入”中的任何一环，都只能算行为分析系统，不能算自进化系统。

## 原型怎么读

1. **进化闭环**：切换 Prompt 缺陷、产品缺陷、Skill 沉淀、经验复用四种场景，观察同一底座如何产出不同资产。
2. **三种方案**：对比 Local Memory OS、Evolution Foundry、Open Evolution Lab 的范围、Estimate、复杂度与自治等级。
3. **Prompt 智能**：沿原始 Prompt、意图理解、首次行为、纠偏和最终结果做因果拆解，避免用 Prompt 掩盖产品 Bug。
4. **L0–L4 权限**：查看每一级可以做什么、不能做什么，以及 L4 的本地自治边界。
5. **运行与评估**：查看每日、每 2–3 天、每周、每月与事件触发的节奏，以及候选门槛、数据合约和多维指标。

## 当前事实与目标能力的边界

页面用两种标签明确区分：

- **CURRENT / 蓝色**：当前代码和本地数据已经具备的事实底座，包括 Terminal / Thread、Agent Team Run、Activity facts、App Server events、关联 ID 与内容引用。
- **TARGET / 紫色**：本方案建议新增的能力，包括 Episode Builder、Reflector、Candidate Factory、Shadow Replay Gate、Evolution Registry 与 Runtime Injection。

页面中的 `≈77k Activity facts`、`490 Terminal sessions`、`69 Agent Team runs`、`≈84k App Server events` 是 2026-07-18 对当前本地数据的只读快照，只用于证明数据量级，不作为长期产品指标。事实记录存在条件偏差，因此不能直接用某类 `completed / failed` 数量计算真实成功率。

## 推荐方案

推荐 **方案 B：Evolution Foundry**，但按风险顺序开放能力：

```text
A · 先形成可追溯记忆
  → B · 再加入实验、晋级、回滚，形成闭环
  → C · 最后把代码 / 新工具生成放入隔离实验室
```

| 方案                   | 核心能力                               |  Estimate | 复杂度 | 自治等级 |
| ---------------------- | -------------------------------------- | --------: | ------ | -------- |
| A · Local Memory OS    | Episode、洞察、Prompt 复盘、选择性记忆 |    4–6 周 | 中     | L0–L3    |
| B · Evolution Foundry  | A + 候选资产 + Replay + 晋级 / 回滚    |   8–12 周 | 高     | L0–L4    |
| C · Open Evolution Lab | B + 开放式代码 / 工具 / 策略实验       | 12–20+ 周 | 很高   | L0–L4+   |

这些 Estimate 是相对工程估算，假设复用现有数据和 Activity 页面基础，不包含团队云同步、跨用户学习、模型训练基础设施或自动发布链路。

## Prompt Intelligence 的责任边界

Prompt 是重要输入，但必须先判断责任层：

| 原因              | 识别信号                                               | 正确产物                                   |
| ----------------- | ------------------------------------------------------ | ------------------------------------------ |
| Prompt 缺陷       | 缺目标、边界、验收或优先级；补齐后跨任务稳定改善       | Prompt lint、模板、最少澄清                |
| 产品 / 合约缺陷   | 必须使用特殊短语才能得到本应默认正确的行为             | Product Insight、复现证据、产品 / 协议候选 |
| 模型 / 运行时波动 | 相同输入结果不稳定，与模型、上下文、工具错误或超时相关 | 路由、重试、上下文或 evaluator 调整        |
| 自然表达不完整    | 用户不知道系统的隐藏约束或必要参数                     | 输入辅助、智能默认值、能力边界提示         |

核心规则：**Prompt 可以是效率加速器，不能成为正确性补丁。**

经验晋级前还要用简短、自然、专业、含噪的语义等价表达做 Replay，避免沉淀只对某个“魔法短语”有效的脆弱规则。

## L4 的准确含义

L4 允许系统在个人本地环境中自动：

- 检索并注入已晋级的 Memory、Prompt、Skill 与 Routing 资产；
- 根据新证据更新置信度、降级、退休或回滚资产；
- 记录每次实际注入的原因和使用后结果；
- 生成 Product / Code 候选，送入隔离评估。

L4 仍然禁止自动外发、自动合并、提权和破坏性操作。Product / Code 只可以成为候选，不能因为进入 L4 就自动落入正式产品。

## 为什么必须每日生成 Episode

当前数据有两层保留窗口：

- Activity facts 默认保留 30 天；
- 加密原始内容与 App Server events 默认保留 7 天。

因此数据处理节奏应是“每日增量生成 Episode，周度运行 Replay 和输出总结”，而不是每周才第一次读取原始内容。否则周任务可能刚好遇到内容过期，丢失 Prompt、工具结果和因果链。

建议节奏：

- 每日：按 watermark 增量构建 Episode；
- 每 2–3 天：聚类、归因、Prompt 模式与反例分析；
- 每周：Replay、晋级 / 拒绝、冲突合并与总结；
- 每月：跨模型 / 产品 / 代码版本检查和资产退休；
- 事件触发：同类高成本失败连续出现 3 次时提前复盘。

## 目标数据合约

- `EvolutionRun`：分析窗口、watermark、版本和数据完整度。
- `Episode`：目标、环境、Prompt 链、轨迹、结果、证据和关联 ID。
- `Insight`：观察、归因、建议、反例、适用范围、置信度、有效期。
- `CandidateAsset`：Memory / Prompt / Skill / Routing / Product / Code 候选及生命周期。
- `Evaluation`：Champion / Challenger、指标向量、回归项、样本和决策。
- `ContributionEdge`：派生资产到来源 Episode 的图关系，用于删除和置信度重算。
- `RuntimeTrace`：下一次执行检索、注入和使用结果的证据。
- `DataQuality`：保留期截断、生产者序列缺口、拒绝记录和样本偏差。

## 评估原则

不把“AI 是否聪明”压缩为一个总分。每次候选评估保留指标向量：

- 任务结果；
- 意图理解；
- 行动质量；
- 自我纠错；
- 协作质量；
- 泛化能力；
- Prompt Intelligence；
- 安全与可靠性。

只有目标维度改善且关键正确性 / 安全维度不退化时才允许晋级。样本少于 30 个 Episode 时，不根据百分比自动晋级。

## 当前代码事实来源

### Activity 与 Work History

- `frontend/src/pages/activity-page.tsx`
- `frontend/src/pages/activity/activity-navigation.ts`
- `backend/src/work-history/work-history-service.ts`
- `packages/shared/src/work-history.ts`
- `packages/shared/src/activity/contracts.ts`

### Agent Team

- `backend/src/agent-team/activity-events.ts`
- `.runweave/agent-team/<runId>.json` 及 Run / Round / Worker 关联结构

### App Server

- `app-server/src/event-store.ts`
- App Server event / thread 内容与 Activity fact 的关联 ID

## 外部研究依据

- [Reflexion](https://arxiv.org/abs/2303.11366)：用语言反馈形成 episodic memory。
- [ExpeL](https://arxiv.org/abs/2308.10144)：从跨任务成功与失败轨迹抽取经验。
- [Voyager](https://arxiv.org/abs/2305.16291)：可增长的技能库、自动课程与验证。
- [ACE](https://arxiv.org/abs/2510.04618)：增量演化 playbook，避免上下文无界膨胀。
- [Metis](https://arxiv.org/abs/2606.24151)：把重复经验同时沉淀为文本记忆和工具 / 代码能力。
- [Darwin Gödel Machine](https://arxiv.org/abs/2505.22954)：自修改候选必须经过经验评估、沙盒与人工边界。

## 文件

- `index.html`：架构页面结构和视觉样式。
- `app.js`：视图、场景、责任层与自治等级交互。
- `mock-state.json`：方案事实、目标结构与演示状态。
- `prototype-preview.png`：Playwright 验证生成的默认首屏截图。

## 验收点

- 默认首屏清楚区分当前数据底座和目标进化能力。
- 四种进化场景均可切换，主链和决策随场景更新。
- 三种方案同时展示 Estimate、复杂度、自治等级和推荐项。
- Prompt 页面可以切换四种责任层，并明确“不用 Prompt 掩盖产品 Bug”。
- L0–L4 均可切换，L4 的允许项和禁止项明确。
- 运行页包含 7 天内容窗口、调度节奏、候选阈值、数据合约与多维指标。
- 页面控制台无错误；默认状态与关键交互使用 Playwright 验证。

## 边界

- 原型不读取或写入用户的 Runweave home，不连接正式 backend / App Server。
- 所有交互都用于解释技术架构，不是拟实现的产品 UI。
- 本目录不包含实施代码、数据迁移或生产调度配置。
- 当前范围为个人本地 V1；团队共享、云端同步、跨用户学习另行定义。
