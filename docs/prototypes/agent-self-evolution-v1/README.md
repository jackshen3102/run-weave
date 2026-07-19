# Agent 自进化控制台原型

面向 Runweave `/evolution` 的可运行 HTML 产品交互原型。

## 启动

```bash
python3 -m http.server 6188 --directory docs/prototypes/agent-self-evolution-v1
```

打开：

```text
http://127.0.0.1:6188/
```

## 文件

- `index.html`：产品壳层、布局、视觉样式和挂载点。
- `app.js`：页面导航、详情切换、发起反思和 Schedule 表单交互。
- `mock-state.json`：Run、Claim、Insight、Memory、Schedule 和 Provider 模拟数据。
- `prototype-preview.png`：浏览器验收后的默认首屏截图。

## 原型简报

- 目标：让用户看见 Agent 反思产生的新增认知、未解决分歧和真实激活状态，并能灵活手动或定时发起分析。
- 用户动作：发起反思、查看运行阶段、检查双 Analyst 观点、追溯 Evidence、浏览 Insight revision、管理 Memory canary、配置 Schedule。
- 主要用户：在一个主项目下使用多个动态 workspace 的 Runweave 用户。
- 影响的产品界面或模块：新增独立 `/evolution` 页面；Activity/Work History 仅提供证据跳转和反向链接。
- 关键流程：创建 Run → 查看双 Agent 分析 → 查看 Claim/Novelty → 进入 Insight → 检查 Memory Shadow/Canary → 管理 Schedule。
- 重要状态：空闲、运行中、无实质新知识、存在分歧、Provider 降级、Memory shadow/canary/needs revalidation。
- 非目标：不连接真实 Backend，不在原型中实现 Agent/SQLite/MCP，不把架构说明或 mock 切换按钮放进产品画面。

## URL 状态

以下参数仅用于原型验收，不进入最终产品 UI：

- `/`：默认完成态。
- `/?state=running`：双 Analyst 正在独立分析。
- `/?state=no-novelty`：本次无实质新知识。
- `/?state=degraded`：Trae 不可用，Provider 降级。
- `/?state=empty`：尚未运行。

## 验证点

- 首屏首先展示增量 Insight、分歧和激活状态，不重复 Activity 事实列表。
- 手动运行与 Schedule 是同一个产品控制面中的两种触发入口。
- Run 详情能区分 Analyst A/B 首轮、交叉质疑、Claim 与 Novelty。
- Insight 详情保留 revision、相关来源、反例记录和适用范围，不显示未经校准的置信度百分比。
- 只有 Memory 出现 Shadow/Canary/Promoted 激活路径，其他 Candidate 只展示提案。
- 默认策略关闭真实注入；Canary 操作显示作用 scope 和安全边界。
- Canary 只展示 Control/Canary 原始观察和样本判断，不直接宣称因果改善。
- 原型中的可见按钮都是最终产品预期保留的操作。

## 功能分类

### 产品核心功能

| 元素 / 行为                      | 最终产品是否需要 | 产品价值                               | 备注                                |
| -------------------------------- | ---------------- | -------------------------------------- | ----------------------------------- |
| Evolution 独立导航和项目级 scope | 是               | 动态 workspace 共享一套知识            | 保留具体 evidence workspace         |
| 发起反思表单                     | 是               | 手动选择 profile、provider、窗口和预算 | 创建统一 Evolution Run              |
| Run 阶段与双 Analyst 状态        | 是               | 看清系统在做什么、是否真正独立分析     | 不展示模型思维链                    |
| Claim 分歧和 Evidence 入口       | 是               | 避免强制共识，可审计结论               | Evidence 跳转 Activity/Work History |
| Insight revision 详情            | 是               | 展示长期知识如何被证据修订             | 支持反例和 drift                    |
| Candidate / Memory 生命周期      | 是               | 区分提案、Shadow、Canary 和晋级        | V1 仅 Memory 可激活                 |
| Schedule 管理                    | 是               | 允许手动或灵活定时，不固定每天         | 支持 timezone 和增量窗口            |
| Provider 降级状态                | 是               | 不把单 Provider 冒充交叉验证           | 显式显示 fallback                   |

### 原型辅助功能

| 元素 / 行为               | 辅助验证什么                       | 为什么不进入产品        | 备注                  |
| ------------------------- | ---------------------------------- | ----------------------- | --------------------- |
| URL `state` 参数          | 截取 running/empty/degraded 等状态 | 正式状态来自 Backend    | 页面内无可见切换器    |
| 本地创建 running 状态     | 验证运行阶段反馈                   | 正式进度来自 Run 状态机 | 仅原型内存状态        |
| 本地 toast 和临时表单写入 | 验证操作反馈                       | 正式数据由 API 持久化   | 刷新后恢复 mock-state |

## 调整记录

| 轮次 | 调整内容                                                                       | 原因                                          | 结果                             |
| ---- | ------------------------------------------------------------------------------ | --------------------------------------------- | -------------------------------- |
| 1    | 首版：控制台、Run、Insight、Memory、Schedule 五个视图                          | 把已冻结架构转成可操作产品界面                | 浏览器验证通过，待用户反馈       |
| 2    | 修复弹窗遮罩事件边界；收敛 Schedule 页说明文案                                 | 真实点击发现表单会被遮罩的 `closest()` 误关闭 | Run、Canary、Schedule 提交均通过 |
| 3    | 去掉置信度百分比；把 Canary 改为原始分组观察；把证据票数改为相关来源与反例记录 | 避免伪精确、伪因果和多数票暗示                | 浏览器复验通过，预览图已更新     |

## 冻结记录

- 最终采用的交互：待用户确认。
- 放弃的方向：未把架构流程图直接作为产品首屏；未加入“日报”入口。
- 产品核心功能清单是否已确认：待确认。
- 原型辅助功能清单是否已确认：待确认。
- 最终截图：`prototype-preview.png`（当前首版预览，冻结时可替换）。
- 冻结时间：未冻结。

## 边界

- 这个原型不连接真实后端 API。
- 这个原型不导入生产源码。
- 这个原型不能证明产品协议、存储或运行时支持已经存在。
- 原型代码不能直接复制到 React 产品实现。
- URL 状态和 mock 计时不进入实施计划。

## 实施计划衔接

- 原型表达的产品行为：独立 Evolution 控制面，围绕增量认知、分歧、证据和激活治理组织。
- 需要进入产品实现的核心功能：上表全部产品核心功能。
- 不进入产品实现的原型辅助功能：URL mock 状态、计时器、本地临时写入。
- 对应计划：`docs/plans/2026-07-19-agent-self-evolution-v1.md`。
- 需要检查的现有代码：`frontend/src/App.tsx`、Home/Activity 页面、Agent Team startup prompt、Evolution API 实现进度。
- 可能涉及的协议或数据结构：EvolutionRun、Claim、InsightRevision、CandidateAsset、RuntimeTrace、EvolutionSchedule、ProviderAvailability。
- 可能涉及的前端落点：`frontend/src/pages/evolution-page.tsx`、`frontend/src/pages/evolution/`、`frontend/src/services/evolution.ts`。
- 可能涉及的后端或运行时落点：仅引用既有 L3 计划，本原型不证明其已存在。
- 验收方式：YAML 测试计划、真实 Dev Session、`$toolkit:playwright-cli` 页面交互和截图。
