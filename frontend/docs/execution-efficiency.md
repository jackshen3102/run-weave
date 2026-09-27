# 执行效率接入

执行效率页面路由为 `/execution-efficiency/:findingId?`，与 Electron renderer 共用。入口位于终端
工作区头部。页面只展示正式候选；正常大任务、未达到阈值的测量和普通流程建议只进入覆盖或
筛除摘要。

## 当前边界

- 两个方向独立：`duration` 与 `tokens` 不共用状态、收益或综合分数。
- 当前 Backend 机器增量读取 Codex session 与 archived session；范围由已登记项目和 worktree
  realpath 决定，HTTP 客户端不能提交日志路径。
- 项目显式关联一个现有 Codex 定时任务。关联不创建、修改或自动运行任务；立即运行回到现有
  定时任务页面。
- Backend 使用实例 `browserProfileDir` 下独立的 `execution-efficiency/efficiency.sqlite`，不写定时任务或经验库。
  Dev Session 通过独立实例配置根隔离数据，`RUNWEAVE_EFFICIENCY_LOG_ROOT` 可替换本机受信日志根。
- 原型 localStorage、旧 token report 和正常执行不迁入正式记录。离线 `pnpm token:report` 保持
  独立可用。

## 计量与初筛

累计 Token 在同一有效计数段求差；重复点不重复累计，回退跨段不求差。缺失字段保留 `null`；
推理输出是输出子集。工具区间从调用前最近采样到匹配返回后首个采样，重叠窗口只计一次并标记
共享归因。非缓存输入仅在输入与缓存都有效且缓存不大于输入时计算。

结构化 `elapsed` 只在结果同时明确 `shellReady: true` 时读取。没有内部计时时，调用与匹配返回
时间戳差只表示调用区间；并行区间按时间并集计算。单样本不生成 p95，不跨冷构建和复用构建
推断节省。

当前 `policyVersion` 为 `2026-09-26.v1`：

- 耗时：明确目标被超出，或同类行为至少三次且区间并集至少 30 秒。
- Token：同类行为至少三次，且非缓存输入至少 10,000 或缓存输入至少 500,000。

阈值只决定是否值得给模型看，不等于浪费。正式提交还必须包含具体行为证据、量化边界、假设、
不确定性和验证方向，Backend 会按服务器观测重新校验。金额、ROI 和节省率保持未知。

2026-09-26 使用最近完成会话做了离线校准：按两批取前十个 case，不重新调用模型；程序初筛
命中四个重复调用相关 Token 区间，其余六个未达到首版阈值。四个命中仍只是待分析材料，不能
直接发布为 Finding。这次校准同时确认每批 10 个 session / 64 MiB 上限会在大日志下产生 backlog，
后续批次继续按检查点推进。

## 增量与恢复

首次窗口为最近七天的最近会话；之后用 session ID、文件代次、完整轮次字节偏移、累计基线和
稳定观测 ID 推进。半行和未结束轮次不提交检查点。文件截断或替换建立新代次；归档移动仍按
session ID 去重。观测与检查点同一 SQLite 事务提交。

每批最多 10 个已结束 session、64 MiB；给模型最多三个候选（待补充问题优先），总证据最多
24,000 字符、单片段最多 1,800 字符。相同 fingerprint 和策略的 dismiss 结论不会重复分析。
中断运行保留已采集观测但不发布半成品；新运行只有在旧 scheduled run 已真实结束后才能取得
owner。

分析线程按 scheduled run 的真实 thread ID 排除出普通候选。分析 Token 在 run 结束后的状态读取
或下一次 collect 中回收；不可读时显示“未记录/部分记录”，当前运行显示“计量中”。

## 人工状态与连接隔离

Finding 状态为 `pending / processing / resolved / deferred / dismissed`。人工事件追加保存；新证据
只能设置“有新证据”，不能覆盖或重置人工状态。完成必须提交处理结果、验证记录并显式确认。
所有人工写入带 `expectedRevision` 和幂等键，409 时页面保留草稿。

Query key 包含 Backend connection scope，切换连接会重新挂载页面并取消旧请求。详情证据使用
纯文本展示，不执行 Markdown HTML、不自动加载图片；来源只回跳当前连接的定时任务。

共享 DTO 的权威入口是 `@runweave/shared/execution-efficiency`。服务层只负责鉴权 HTTP，领域
状态在 Backend `src/execution-efficiency/`，路由只做输入和错误映射。

## 验证

静态检查和子系统检查见根 `AGENTS.md`。真实行为按
[`core.testplan.yaml`](../../docs/testing/execution-efficiency/core.testplan.yaml) 使用隔离数据根；浏览器
步骤必须用 Playwright CLI，格式校验不能替代 API、SQLite、真实 Codex 和连接切换证据。
