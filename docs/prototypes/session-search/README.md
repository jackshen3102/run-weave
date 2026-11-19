# 会话搜索历史原型

此目录冻结 2026-11-18 的方案讨论。HTML 交互均为模拟，当前功能、资源预算、页面入口和 CLI / MCP 合同以[会话搜索](../../cli/session-search.md)为准。

- [打开历史原型](index.html)：架构节点、更新场景、搜索样例与来源定位均由页面 JavaScript 演示，不执行扫描、FTS5 查询或 Backend API。
- 历史源码基线：`853d9402a1dae814a513895993315e7a502ea5ca`。
- 方案演变：v2 收敛为仅索引 Agent 原生记录，Codex、Pi、Claude 是格式适配器；Activity、日报和经验库不作正文来源。后续更新触发策略收敛到 ags 0.5.0，HTML 中的文件监听、定时扫描与启动预扫描已撤回。
- 原型不能证明当前产品的检索行为、性能或端到端验收。当前实现已提供共享索引，不应再把原型阶段的“拟新增”“未决细节”当作产品现状。

## 历史验证边界

原型阶段记录了 v1 的 20 项浏览器交互、v2 的 7 项复核及文档检查；390 × 844 窄视口检查属于桌面响应式验证，未执行 iPhone 真机阅读。这些结果仅对应历史原型，不是本轮文档整理重跑的验证。

历史截图位于未入库的 `.runweave/session-search-plan/`，当前仓库不可读取；不作为可交付证据或后台检索实现证明。原型保留供设计背景查阅，当前源码入口见[服务](../../../backend/src/session-search/service.ts)、[原生记录读取与解析](../../../packages/agent-history-node/src/index.ts)和[MCP 会话检索](../../../packages/runweave-mcp/src/sessions.ts)。
