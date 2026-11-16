# 质量工作流实施验收

2026-11-16：P1–P5 源码已落地，隔离验收已执行；**没有达到计划的全部上线完成标准**。
Stable 的质量 capabilities 实读为404；未更新 Stable、未安装到真机、未发布全局插件、未创建每日任务。
计划仍保留为正在执行的过程材料。当前合同见 [质量工作流 CLI](../cli/quality-workflow.md)。

## 已交付

- 独立 SQLite worker、schema版本、字段白名单、同事务事件/缺口/连续确认、快照分页、保留边界与固定证据保护。
- 桌面持久队列与 Web Locks；iOS 宿主持久队列及共享 Foundation 观察接口；按持久 Backend 身份冻结归属。
- 本机 Backend 日志增量读取，以及显式配置的本机桌面事故目录；原始文件保留。
- `rw quality` 与每日归因技能；先保存待处理页、CAS/租约、稳定问题 ID、归因状态、复验和独立用户关闭确认。
- 候选分组按复发和输入影响排序，每轮最多20组，并为到期复验保留最多5个名额；其余页与水位保留。

## 实际证据

本机完整材料在 artifacts/quality-workflow/2026-11-16（本机路径：`artifacts/quality-workflow/2026-11-16/`）。
材料不含凭据或业务输入正文；原始 Backend 日志、App 数据和设备任务目录不作为公开报告。

- HTTP验证（本机路径：`artifacts/quality-workflow/2026-11-16/http-probe.json`）：20项真实接口检查。
- 存储验证（本机路径：`artifacts/quality-workflow/2026-11-16/storage-probe.json`）：13项真实 worker、SQLite 重启、分页、日志轮转检查。
- 保留与满容量（本机路径：`artifacts/quality-workflow/2026-11-16/retention-probe.json`）：7项，固定未结问题的8条证据，确认503不推进ack。
- 关闭确认（本机路径：`artifacts/quality-workflow/2026-11-16/confirmation-probe.json`）：3项；自动 analysis 禁止closed，独立确认仅接受已有修复与复验记录的问题。
- 浏览器队列（本机路径：`artifacts/quality-workflow/2026-11-16/browser-queue-probe.txt`）：实际队列模块在隔离桌面 localStorage 执行，容量边界fixture入队后丢弃范围、恢复、并发序号与非法ack均通过；不是一万次真实用户操作。
- 阶段分类（本机路径：`artifacts/quality-workflow/2026-11-16/classification-probe.json`）：建立前失败、建立后失效、建立后取消、缺started，取消未反写失败；缺started不报建立耗时。
- 真实事件（本机路径：`artifacts/quality-workflow/2026-11-16/events-after-restart.json`）：桌面发送 receiveId=33–37，iOS模拟器发送=10–14，均为同一操作的五阶段；仅证明输入接受与客户端状态/界面阶段。
- 重启后HTTP重传（本机路径：`artifacts/quality-workflow/2026-11-16/http-replay-after-restart.json`）：同Backend，acceptedCount=0、duplicateCount=2、ackThrough=2。
- 无变化轮次（本机路径：`artifacts/quality-workflow/2026-11-16/daily-no-changes.json`）：直接运行归因准备脚本，groups=0、due=0、noChanges=true；不是调度器触发证据。
- 最终台账（本机路径：`artifacts/quality-workflow/2026-11-16/final-ledger.json`）：已有6条假设线索保持原ID；后续41条待处理材料在读取水位后持久保存，分析水位仍停在18，租约已释放。

本轮创建的两个Dev Session均已停止，两个自有模拟器租约均已finish；没有停止其他worktree的环境。

真实桌面采用当前worktree的 Beta Session `dvs-cbea0d`、`pool-05`；另一次初始化 Session `dvs-a5707f` 已停止。
重启沿同一Backend、证据库和桌面数据目录；原sourceId/streamId未变，未确认桌面事件自动补发，pending归零。
实际发现并修复了 worker 未进入打包资源白名单、批次路由拦截OPTIONS预检和清理时SQLite迭代器占用三个实现问题。
最终源码另补了所有日志读取任务排空、schema版本拒绝和用户确认关闭；这些路径通过源 worker 验证及最终Beta构建。

iOS 使用池中 `0986DF97-0644-4138-847E-5BC690CFEF7E` 模拟器；Runweave与随记宿主均构建、安装和启动成功。
Runweave执行真实输入发送并查询Backend确认收录；随记只执行启动、构建信息展示与本机分享呈现，
没有登录正式账户或发送消息。随记原有操作诊断导出的完整回归没有执行，不能据构建成功替代。
截图：iOS发送后（本机路径：`artifacts/quality-workflow/2026-11-16/ios-after-send.png`）。桌面截图采集超时，没有交付桌面图片；真实操作与上传以事件和HTTP证据核对。

## 18条验收合同的覆盖

“部分”表示已取得分层证据，但未按原用例完整建立全部前置条件或执行全部步骤。

| 用例    | 本轮状态 | 实际范围与缺口                                                                          |
| ------- | -------- | --------------------------------------------------------------------------------------- |
| QWF-001 | 通过     | 真实桌面发送、不导出，重启恢复上报并核对同ID、构建与项目归属                            |
| QWF-002 | 部分     | 模拟器五阶段真实入库；真机未执行                                                        |
| QWF-003 | 通过     | 真实HTTP重复幂等与同序号内容冲突                                                        |
| QWF-004 | 部分     | 实际401/409/403；未同时建立两个Backend做完整隔离对照                                    |
| QWF-005 | 部分     | CORS上传失败保留队列，业务发送完成；恢复同时包含桌面/Backend重启，不是纯网络开关用例    |
| QWF-006 | 通过     | 相同桌面数据根重启，原source/stream/seq补发并收到ack                                    |
| QWF-007 | 部分     | 浏览器真实队列容量与缺口、Backend显式缺口确认分别验证；未完整串联容量溢出后的客户端上传 |
| QWF-008 | 通过     | 实际Backend重启后原事件仍在，同批次HTTP重传不重复                                       |
| QWF-009 | 部分     | 源worker实际清理、cursor_expired和最早位置恢复通过；API与每日脚本的过期恢复未完整串联   |
| QWF-010 | 通过     | 真实API拒绝非法字段，日志白名单剔除正文/编码片段，真实发送标记不进入证据                |
| QWF-011 | 部分     | 四类阶段fixture已跑；未把跨端逆序时钟fixture走完独立场景                                |
| QWF-012 | 通过     | worker重启恢复待处理页、CAS幂等、写者互斥，以及脚本跨轮保留待处理材料与分析水位         |
| QWF-013 | 未执行   | 未确认测试日程/执行策略，不创建任务；没有真实每日occurrence证据                         |
| QWF-014 | 部分     | 实际自动取数后按源码/运行材料写入假设归因；没有匹配clean构建的located对照组             |
| QWF-015 | 通过     | Clarity未验证/不可用时本地分析与台账提交完成，不记录云端零异常或自动关闭                |
| QWF-016 | 通过     | 真实文件追加、重命名轮转与截短，按inode/偏移读取并披露缺口                              |
| QWF-017 | 通过     | 未结问题固定证据占满有界库后503，原证据、ack及storage_full保持可核对                    |
| QWF-018 | 通过     | 无新增/到期项的直接脚本轮次不展开旧组，原问题ID与水位保留；仍有Agent启动成本            |

## 静态与构建

共享包、Backend、Frontend、CLI的typecheck/lint、CLI build、architecture、configuration、docs、
18条YAML格式与技能校验均通过；`swift build --package-path packages/ios-diagnostics`及两个iOS宿主构建通过。
Backend现有生命周期验证通过。定时任务现有运行验证清除继承的Activity/Evolution/Scheduled worker入口后通过；
首轮继承旧安装路径而失败的结果保留，不能混作调度能力回归。
没有新增单元测试，也没有把格式/类型检查当作上表的运行通过依据。

## 可靠性修复复验（2026-11-16）

针对后续复核发现的两个P1问题，已修复并使用相同真实SQLite worker / service场景复验。
材料位于 reliability-fix（本机路径：`artifacts/quality-workflow/2026-11-16/reliability-fix/`），未新增单元测试。

- 修复前基线（本机路径：`artifacts/quality-workflow/2026-11-16/reliability-fix/baseline.json`）保存源码摘要与原始结果：
  确认丢失后上报重叠丢弃区间返回409；10,000字节预算的台账提交后占用10,702字节，事件读取503。
- 同场景复验（本机路径：`artifacts/quality-workflow/2026-11-16/reliability-fix/after.json`）：下一批正常接受，ack推进到2，
  原事件保留且未虚报缺口；超预算台账提交503并整体回滚，占用仍为4,119字节，revision仍为2，
  4条待处理材料和空分析水位保留，4条原事件可读。
- 10项组合边界（本机路径：`artifacts/quality-workflow/2026-11-16/reliability-fix/edges.json`）通过：混合已接收/缺失区间
  只记录真实缺口，溢出批次重传幂等，内容冲突和同批次矛盾仍拒绝；提交回执也计入精确预算，
  旧版本已超预算的固定证据和写满后的固定证据仍可读取。
- 重跑13项存储/恢复检查、7项清理与容量检查和3项关闭确认检查。容量回归的填充fixture按实际预算
  调整：去掉原先固定预留2,048字节后，同样数量的事件未必触发清理；核心两个缺陷的前后对照使用同一fixture。

本轮只修改Backend存储与合同说明，未重跑桌面、模拟器或真机UI；上表原有的部分通过和未执行项继续保留。

## Review 第1轮修复复验（2026-11-16）

本节对应 review `5863a2e7-6193-4b61-a089-68d4e4adec48` 的两个已复现缺陷。
原始结果及源码摘要保存在本机 `artifacts/quality-workflow/2026-11-16/review-round-1/`；
材料未随冻结输入提供时，本节文字不替代运行证据。合成分析提交只检验数据流，不作为自动归因成功的证明。

- 关闭 fixture 后，通过真实保留入口清理旧事件。修复前保留旧引用重开返回409 `evidence_expired`，
  删除旧引用返回409 `issue_history_missing`；修复后沿原ID、首次时间、旧引用及复验记录成功重开。
  删除历史引用仍拒绝，追加不存在的新引用仍返回409 `evidence_expired`。
- 第一轮 started + confirmed 完成 prepare/finish，第二轮追加同操作 failed。
  修复前实际每日入口输出 `failed_before_established`、两项耗时均null；修复后输出
  `established_then_lost`、建立耗时200ms、连接持续时间4800ms，历史引用为1/2/3，第二轮提交后pending为空。
- 新增上下文查询的15项真实worker/HTTP边界检查通过：分页去重、来源/启动/动作隔离、检查点快照、
  旧检查点拒绝、分页及操作数上限、无认证拒绝、错误Backend拒绝、请求体上限与先鉴权后解析，
  以及清理后剩余材料可读且披露边界。
- 构建后的真实CLI经隔离存储profile、HTTP认证fixture和真实worker完成两轮prepare/finish及分页/错误输出，8项检查通过。
  该fixture不包含生产登录、token刷新或完整服务启动，不能替代Review要求的真实隔离profile全链路验收。
- 重跑13项存储/恢复、7项保留/容量、3项关闭确认检查通过。类型、Lint、CLI构建及架构检查通过。

本轮未运行真实桌面、客户端离线/多窗口/切换目标、真机、随记诊断回归、实际Agent调查、完整服务生命周期
或真实复验观察窗口。上表较早轮次的结果不代表这些路径已在本轮同版复验；Review列出的证据缺口继续保留。

## 启用前

完整任务草稿（本机路径：`artifacts/quality-workflow/2026-11-16/scheduled-task-draft.json`） 与
只读validate响应（本机路径：`artifacts/quality-workflow/2026-11-16/scheduled-task-validation.json`） 已保存。
目标是Stable、profile=local；建议每天09:00 Asia/Shanghai、Codex默认模型、补最近一次且有效期24小时。
当前草稿enabled=false，executionPolicy=full-access：**无沙箱、无交互审批**，允许访问任务工作目录外的仓库、
只读Git、认证CLI与可选Browser；这只是待确认提案，不是已授权扩大权限。
摘要为 `188cdd7aab4a3edc44f30e9d561d733254cf89e89f2d4f5ce864bc6c05244d00`，预览下一日程为
2026-11-17 09:00 Asia/Shanghai（01:00 UTC），草稿暂停所以nextRunAt=null，且并未创建任务。

按 [scheduled-task规则](../../plugins/toolkit/skills/scheduled-task/SKILL.md) 等待用户确认完整最终配置；
任何启用或时刻/策略改动须重新校验。还需另行授权更新Stable和手机，完成真机与真实每日触发验收，
才能把P6和整个计划标为完成。没有数据或只有健康事件都不自动关闭问题。
