---
name: architecture-flow-prototyping
description: 面向技术说明、非产品 UI：用可运行 HTML 讲清系统如何运转，并通过架构流程发现潜在问题。用户要求梳理架构关系、端到端流程、事件或状态流、运行闭环或故障因果时使用；页面、组件和交互体验原型改用 prototype-first-development。
---

# HTML 架构流程原型

用可运行 HTML 把复杂系统讲清楚，并借助流程本身发现潜在问题。核心产物不是某种图形样式，而是读者看完后能理解系统如何运转、边界在哪里、哪些地方值得验证。

产品页面、组件和用户交互原型使用 `$toolkit:prototype-first-development`。本技能面向技术说明，页面可以展示架构文字、接口、代码源、证据和诊断信息。

## 只围绕核心目标

先用一句话确定这次最需要讲清的内容，例如：

- 一个事件从 producer 到业务状态如何流动？
- 一个 loop 如何启动、闭环、失败和恢复？
- Project、Terminal、xterm 和 runtime 分别归谁管理？
- 断线、重启、并发或多实例时系统如何保持状态？

所有视觉和交互都服务于这个问题。与核心目标无关的模块，即使真实存在，也不必画出来。

## 表现形式保持开放

根据材料自由选择单页长图、分区流程、泳道、时序、状态机、表格、交互式多视图或新的表达方式。可以只写一个 `index.html`，也可以拆分脚本和结构化数据。

下面两个案例代表不同方向，不是模板：

- `docs/architecture-flows/agent-team-loop-flow/`：用静态单页聚焦生命周期、核心 loop 和闭环出口。
- `docs/architecture-flows/app-server-event-architecture-flow/`：用交互场景、因果和证据解释事件架构并发现问题。

学习它们如何围绕目标组织信息，不复制页面结构、问题编号、视觉风格或文件数量。

本技能刻意不提供固定 HTML 脚手架，避免为了填模板而堆叠节点或限制表现形式。起步时参考上述案例如何组织信息即可，不要把它们当成页面模板。

## 核心原则

- 画当前架构前先读真实代码、接口、文档、日志或用户提供的材料。
- 让关键关系和结论能够回到来源，不凭视觉效果补事实。
- 先让主线容易理解，再决定是否需要下钻、交互或更多视图。
- 主动寻找潜在问题，但区分事实、推测、边界和复现证据。
- 不把“可能慢”“可能竞态”“可能重复”直接写成已确认故障。
- 代码或结论变化后同步原型，避免留下过时架构图。
- 架构原型只说明和探索系统，不能证明尚未实现的能力已经存在。
- 在 Runweave 仓库中，必须实际使用 `$playwright-cli` 验收页面；静态页面也不能只做代码阅读。

## 建议工作方式

以下是建议，不是固定流程。根据任务删减、合并或调整。

### 从事实出发

追踪真正发生的链路：调用方、接口、中间层、存储、consumer 和最终副作用。关注主键、ownership、事实源、projection、cache、cursor、重启恢复以及同步/异步边界。

简单流程可以直接写进 HTML；关系复杂或需要交互时，再把节点、场景、事件和接口放进 `mock-state.json`。

### 设计阅读路径

选择最能解释当前问题的表达：

- 流程和 ownership 适合泳道或分区。
- 调用先后、异步和竞态适合时序。
- 生命周期和 loop 适合状态机或循环结构。
- 接口、事件和字段关系适合表格。
- 触发条件影响多个下游时可以使用因果视图。

这些只是启发。圆形、自由布局或其它形式如果更适合当前关系，也可以使用。不要为了“完整”堆叠节点、连线和等权卡片。

### 通过流程发现潜在问题

沿主链主动追问：

- ownership 是否清楚，是否有多个模块同时认为自己是事实源？
- 同一语义是否有双入口、双写、重复投影或重复消费？
- 事件 id、cursor、epoch、gap、ack 和保留期能否支撑恢复？
- 并发、重启、断线、多实例和积压时，顺序与状态是否仍成立？
- 一个操作会放大为多少连接、请求、文件写入或全量扫描？
- 状态变化是否在正确边界发生，是否可能漂移或被旧事件覆盖？
- 失败是否可观察，consumer 能否知道自己漏了数据？

把发现先作为假设。能做受控复现时，用数字、日志、网络消息或浏览器行为验证；无法复现、属于明确边界或没有达到性能门槛时如实记录，不制造待修问题。

### 构建 HTML

优先做最小但完整的表达。常见做法包括主链、关键分支、loop 出口、场景切换、节点详情、问题因果或接口列表，但都不是必选项。

页面中的说明、筛选和诊断交互属于技术文档，不代表 Runweave 产品 UI。只为调试或截图存在的控件应默认隐藏，并标记 `data-prototype-helper="true"`。

### 验证和冻结

README 记录足以让后续维护者理解、启动和更新原型的信息，包括事实基线、代码源、核心结论和边界。诊断型原型再记录复现证据和处理状态。

在 Runweave 仓库中一律使用 `$playwright-cli` 验收。静态单页至少要打开页面、检查目标视口与 console error，并保存默认阅读状态截图；存在交互时，再按原型实际能力验证关键阅读路径和状态变化。

## 产物建议

架构流程产物默认放在 `docs/architecture-flows/`，不要放进面向产品 UI 的 `docs/prototypes/`。

最小产物可以是：

```text
docs/architecture-flows/<architecture-slug>/
  README.md
  index.html
```

需要时再增加：

```text
  app.js
  mock-state.json
  prototype-preview.png
```

文件结构服务于表达和维护，不作为验收目标。

## 进入计划或实现

只有用户明确要求后才进入下一阶段。区分当前事实、潜在问题、已验证问题和用户选择的目标架构。不要把技术文档导航、场景开关或未复现风险直接变成产品任务。

需要更多构图启发时读取 [architecture-flow-guide.md](references/architecture-flow-guide.md)。收尾时可用 [architecture-flow-checklist.md](references/architecture-flow-checklist.md) 自检，但不要把它当作固定门禁。进入计划时按需使用 [architecture-flow-handoff-template.md](references/architecture-flow-handoff-template.md)。

## 启动方式

```bash
python3 -m http.server 6188 --directory docs/architecture-flows/<architecture-slug>
```

打开 `http://127.0.0.1:6188/`。
