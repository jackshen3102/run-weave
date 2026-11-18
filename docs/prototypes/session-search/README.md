# 会话搜索可视化方案

状态：历史方案原型，2026-11-18 获准按 v2 实现。HTML 中的交互仍为模拟；当前产品合同见[会话搜索](../../cli/session-search.md)。

后续约束：用户要求索引更新触发策略完全对齐 ags 0.5.0，禁止额外功能。HTML 中旧的文件监听、定时扫描与启动预扫描设计已撤回；当前行为见[会话搜索合同](../../cli/session-search.md)。

用户原始目标：在当前 Runweave 项目落地类似 ags 的多 Agent 历史检索与增量索引，先用可视化方案讨论技术路线。

- 打开：[index.html](index.html)。可从终端文件链接的 HTML Preview 阅读，或在原型库选择当前项目的 `session-search`。
- 源码基线：HEAD `853d9402a1dae814a513895993315e7a502ea5ca`。已有 `backend/src/quality-workflow/validation.ts` 改动保留，未涉及本方案。
- 已选建议：TypeScript / Node.js、现有 better-sqlite3、FTS5、Backend 管理的 Worker；原生会话记录是唯一正文来源；独立派生索引；共享 HTTP/CLI/MCP 合同；索引和项目经验保留各自生命周期。
- 当前差异：MCP 文件检索是有界尾部扫描；日报已有带定位、哈希和检查点的增量解析缓存，但不是通用会话全文索引。已有追加路径会读取旧前缀进行校验，不声称只读新增字节。
- 拟新增与复用边界：抽取通用读取基础能力，另建会话检索投影，不将 DailyMaterial、UI 阅读投影或 assistant 自述当作完整执行证据。
- v2 来源收敛：只索引 Agent 原生会话记录；Codex/Pi/Claude 是三种格式适配，不是并列事实源。Activity、App Server 事件、Work History、日报、经验库不作为正文输入；文件监听和扫描只发现原文件变化。搜索层不依赖 Activity 通知，也不从派生记录拼接缺失回执。
- 未决细节：来源保留范围、扫描和资源预算、具体页面入口；跨机器聚合、向量召回与自动交接不在第一阶段。
- 模拟边界：架构节点、更新场景及 4 条搜索样例均为本页 JavaScript 演示。没有实际文件扫描、FTS5 查询、索引服务、API 调用或模型运行；没有性能达标证明。
- 交互：点击架构节点；切换新增/追加/重写/不可用场景；用示例词搜索、切换来源与搜索层级、展开来源定位；章节锚点与返回顶部。
- 刷新：反馈后更新同一文件，保留稳定 ID；用户主动刷新或重新打开。原型库仅阅读；终端 HTML Preview 的元素评审需在真实入口单独使用。

## 实际验证

v1 已执行下列 20 项交互检查。v2 收敛正文来源后，另通过 Runweave 真实预览复核 7 项：唯一正文来源节点、节点详情、派生资料与更新信号边界、格式适配说明、追加流程、搜索交互、390px 无整页横向溢出。静态检查通过：44,533 字节、51 个唯一 ID、11 个有效本地链接/锚点、无外部资源；文档检查通过。

- 静态检查：通过。v1 HTML 44,015 字节、50 个唯一普通 ID；章节锚点与本地源码链接有效，无外部脚本、样式、图片或其他资源。
- 文档检查：`pnpm docs:check` 通过。
- Runweave 浏览器交互：通过当前终端解析的 Profile 1，在现有原型库的真实预览票据入口执行 20 项检查：架构节点、追加/重写/离线场景、对话与工具输出分层、中文检索演示、来源筛选、表单提交、来源定位展开、零结果、章节及返回顶部。
- 桌面窄视口：390 × 844 的同一页面检索交互通过、无整页横向溢出，宽表格可以局部横向滚动。它只证明桌面响应式行为，不是手机验收。
- 截图来源：Runweave Browser 原型预览。历史截图路径为 `.runweave/session-search-plan/` 下的 `architecture-desktop.png`、`search-desktop.png` 和 `narrow-browser-hero.png`；图片未入库，当前仓库不可读取。架构截图已更新为 v2，搜索演示与窄视口首页截图为 v1。截图不证明后台检索实现。
- iPhone 真机阅读：未执行。页面含响应式布局，但这不能代替真机阅读验收；本次未要求手机交付。

## 代码依据

- [原生记录增量读取](../../../packages/daily-record/src/native-index.ts)
- [日报来源投影](../../../packages/daily-record/src/native.ts)
- [SQLite Worker](../../../backend/src/activity/database/sqlite-worker.ts)
- [MCP 来源与检索](../../../packages/runweave-mcp/src/sources.ts)
- [经验合同](../../cli/experience-cli.md)
- [会话阅读目标](../../../backend/src/terminal/application/conversation.ts)
