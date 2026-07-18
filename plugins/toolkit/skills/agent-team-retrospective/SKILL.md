---
name: agent-team-retrospective
description: 深度复盘 Runweave Agent Team run，基于 run JSON、worker outbox、真实证据、pane 状态和代码链路区分产品缺陷、框架缺陷、验收合同问题与环境阻塞，并生成标准化可运行 HTML 架构流程报告、README 和浏览器验收截图。用户要求“复盘 Agent Team”“分析为什么卡住”“总结 Human Gate/worker/dispatch/loop 问题”“给后续优化建议”或指定 Agent Team run 做 postmortem 时使用；普通状态查询、单次介入或只修一个 bug 时不要使用。
---

# Agent Team 深度复盘

围绕一个核心问题组织复盘：为什么这个 run 以当前方式推进、卡住或恢复，以及哪些改进能减少下一次的人工成本。

## 产物合同

在 `docs/architecture-flows/agent-team-run-<run-short-id>-retrospective/` 生成：

- `index.html`：可运行的深色单页架构复盘。
- `README.md`：事实基线、查看方式和证据来源。
- `prototype-preview.png`：Playwright 验收截图。

以 [assets/retrospective-template.html](assets/retrospective-template.html) 作为轻量视觉骨架。复用颜色、字体、卡片和基础布局即可；根据 run 的真实问题自由删减、重排和扩展，不要求每次使用相同区块。

## 工作流

### 1. 固定事实快照

先读取真实来源，不从聊天记录推断当前状态：

1. `.runweave/agent-team/<runId>.json`
2. run 绑定的 pane-scoped worker outbox
3. `.runweave/evidence/` 中被 acceptance、repair cycle 或 outbox 引用的证据
4. 必要时读取 tmux pane transcript、`rw agent-team` 状态和相关 backend 代码
5. 测试案例来源、SHA 与当前文件是否仍存在

根据当前任务选择合适的只读工具提取事实，例如 `jq`、`rg`、`rw agent-team`、tmux capture 或项目已有诊断入口。不要假设所有复盘都具有相同的数据结构。

复盘是只读诊断。除非用户另行要求，不介入 run、不修改验收合同、不修实现代码。

### 2. 建立端到端主线

至少覆盖以下阶段中实际发生的部分：

`验收来源 → split → worker 投递 → agent 输入 → outbox → completion → code review → behavior verify → repair → Human Gate/完成`

对每个关键断点回答：

- 控制面的事实源是什么？
- UI 展示的是意图、已投递、已启动，还是已产出？
- worker 是否真的收到消息？
- completion/outbox 是否绑定正确 dispatchId？
- 失败属于产品、框架、合同、环境还是人工决策？
- 自动恢复为什么没有闭环？

### 3. 分类根因

只使用以下标签，避免把不同性质的问题混在一起：

- `真实产品缺陷`：真实产品入口可复现，行为不满足验收合同。
- `已确认框架缺陷`：投递、状态机、thread、outbox、completion 或恢复机制本身失败。
- `验收合同问题`：case 范围、依赖、优先级、可执行性或证据要求不合理。
- `环境能力问题`：required surface、profile、认证、runtime 或外部依赖不可用。
- `观察风险`：只有推测或静态迹象，尚未复现；不得写成已确认缺陷。
- `已修复 / 部分修复`：必须给当前代码或验证证据，并说明剩余边界。

### 4. 计算可解释指标

优先给精确数字：

- acceptance `pass / fail / pending / skipped`
- run 总时长与当前 round
- intervention 数、暂停/Human Gate 次数
- worker dispatch 和 consumed dispatch 数
- repair cycle、重复失败和被阻塞的下游 case 数
- 产品缺陷数量与框架/环境阻塞数量

数字必须解释含义。例如“15 次 intervention”本身不是结论；要说明是否意味着几乎每轮都需人工恢复。

### 5. 生成 HTML

复制模板的基础骨架并按当前 run 选择最合适的表达。通常可以从以下内容中选择，不必全部出现：

- Run 标识、核心判断和关键指标
- 理想闭环与实际断点
- 时间线或时序图
- 根因分类卡片
- 量化结论表
- P0/P1/P2 后续优化建议
- 一句话结论

模型可以自由增加：

- SVG 流程图、状态机、泳道或因果图
- 表格、柱状图、比例图或趋势图
- 可展开证据、场景切换或筛选交互
- 适合当前 run 的其它技术表达

不要为了保持模板形状而填充空洞区块。页面结构服务于本次复盘的核心判断。

每条建议尽量写清：

- 当前问题
- 推荐机制，而不是笼统目标
- 防误伤边界
- 可验证结果或预计减少的人工动作
- 当前状态：未做、部分完成或已完成

不要为了视觉效果编造时长、次数、因果或“已解决”。

### 6. 浏览器验收

静态页面仍必须使用 `$toolkit:playwright-cli`：

```bash
python3 -m http.server 6188 --directory docs/architecture-flows/<slug>
playwright-cli -s=agent-team-retro open http://127.0.0.1:6188/
playwright-cli -s=agent-team-retro resize 1440 900
playwright-cli -s=agent-team-retro eval 'JSON.stringify({title:document.title,h1:document.querySelector("h1")?.textContent,metrics:document.querySelectorAll(".metric").length,recommendations:document.querySelectorAll(".rec").length,scrollWidth:document.documentElement.scrollWidth,clientWidth:document.documentElement.clientWidth})'
playwright-cli -s=agent-team-retro console error
playwright-cli -s=agent-team-retro screenshot --filename=docs/architecture-flows/<slug>/prototype-preview.png
playwright-cli -s=agent-team-retro close
```

验收要求：

- 标题、核心判断和建议可读。
- 默认阅读状态无横向溢出；确需横向时序或大表格时，为局部区域提供明确滚动容器。
- console 0 error。
- 截图属于本次生成页面。
- 停止临时 HTTP server，不留下浏览器 session。

## 质量边界

- 复盘必须区分“当时发生的历史故障”和“当前仍未修的问题”。
- 后续代码变化时同步更新报告中的状态，避免已修问题继续标红。
- UI 文案“已抛回”“执行中”不能直接当成 pane 已收到任务的证据。
- 静态检查不能代替真实行为 evidence；真实行为失败也不能被代码阅读改写为通过。
- 不把 Code worker 的墙钟时间直接解释为实现效率；先扣除投递失败、环境等待和协议补交。
