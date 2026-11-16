# 质量工作流验收与启用

当前源码包含自动采集、Backend 证据库、CLI 和每日归因入口；源码存在不证明目标 Backend、
客户端、全局插件或每日任务已更新。操作与存储合同见 [质量工作流 CLI](../cli/quality-workflow.md)。

## 验收入口

按 [18 条验收用例](../testing/quality/automatic-attribution.testplan.yaml) 分别取证。
每例核对源码、实际产物、目标 backendId、客户端构建及独占资源；类型检查、构建、YAML 格式、
历史导入或单张截图均不能替代新操作自动汇入和跨轮复验。

- 桌面：使用隔离 Dev Session 和真实页面，不点导出，查询同 operationId 的新事件；
  重启和离线补发必须保留原 source、stream、seq，不能重发业务输入。
- iOS：使用已授权真机核对宿主构建及目标连接；模拟器证据单列。
  共享诊断包变更还需回归随记原有本地诊断，不为随记启用自动上传。
- Backend：用真实 API、worker 与 SQLite 核对认证、实例隔离、幂等、快照分页、清理和容量。
  存储失败不推进 ack；未结证据和待处理页不能为腾空间而删除。
- 每日归因：真实触发一次调度，再执行下一轮，核对去重、稳定 issueId、待处理页、
  读取/分析水位和复验变化。直接运行准备脚本不证明调度器触发。
- 调度既有语义见 [补跑](../testing/scheduled-tasks/catch-up.testplan.yaml) 与
  [项目独立任务](../testing/scheduled-tasks/project-independent.testplan.yaml)。

## 启用与回退

1. 实读目标 `rw quality capabilities` 的 enabled、schemaVersion 和 backendId；
   核对客户端能力与后台实际可读的技能、脚本路径，不用源码存在代替安装态。
2. 每日一次归因复用现有定时任务。按 [scheduled-task 规则](../../plugins/toolkit/skills/scheduled-task/SKILL.md)
   核对目标 Backend/profile、执行时刻、IANA 时区、补跑策略、执行策略、目录及完整提示词，
   只读 validate 后取得用户对最终配置的确认，再创建并 get 回读。
3. 核对真实 occurrence、运行结果、下一次执行与覆盖缺口；仅建任务不算全链路完成。
   Stable 更新、手机安装和全局插件发布须各自取得授权并按对应流程执行。
4. 回退先暂停每日任务，再停止新增采集，保留证据库、队列和水位；
   不兼容旧版不得写新库，恢复兼容版本后续接。具体合同见 CLI 文档。

## 历史验收摘要（2026-11-16）

以下是仓库原有验收记录的摘要，本次文档整理未重新执行产品验收或检查生产部署。
完整阶段记录保存在[当时版本](https://github.com/jackshen3102/run-weave/blob/c0fa53ceef208d8cecb370e1993b37e35b6478e3/docs/quality/quality-workflow-validation.md)；
本机原始材料路径为 `artifacts/quality-workflow/2026-11-16/`，未随源码发布，文字摘要不替代原始证据。

| 用例                             | 当时结果与证据边界                                                                    |
| -------------------------------- | ------------------------------------------------------------------------------------- |
| QWF-001、003、006、008、010、012 | 记录为通过：桌面新操作、重传/冲突、客户端重启、Backend 持久化、字段白名单、台账恢复   |
| QWF-015、016、017、018           | 记录为通过：Clarity 缺失不阻断、日志轮转、固定证据满容量、无变化轮次；后者仅直接脚本  |
| QWF-002                          | 部分：模拟器发送入库，真机未执行                                                      |
| QWF-004                          | 部分：认证/归属拒绝已检验，未完整建立双 Backend 对照                                  |
| QWF-005、007                     | 部分：上传失败、队列容量和缺口分别验证，纯断网与溢出恢复全链路未完成                  |
| QWF-009、011                     | 部分：worker 清理/恢复和阶段 fixture 已检验，API/每日过期恢复及跨端逆序时钟未完整串联 |
| QWF-013                          | 未执行：未创建每日任务，无真实每日 occurrence                                         |
| QWF-014                          | 部分：完成假设归因，缺匹配 clean 构建的 located 对照组                                |

当时 Stable capabilities 返回 404；未更新 Stable、未安装真机、未发布全局插件。
随记只完成构建、安装、启动与分享呈现，原有操作诊断导出完整回归未执行。
两个自有 Dev Session 与模拟器租约已结束，不影响其他工作区。

后续同日修复复验覆盖确认丢失后的重叠丢弃区间、台账事务容量预算、清理后沿旧 issueId 重开，
以及跨轮补齐同操作历史阶段。真实 worker/HTTP 与构建 CLI 的隔离 fixture 通过；
该 CLI fixture 不包含生产登录、token 刷新或完整服务启动。
最后一轮未重跑桌面离线/多窗口/切换目标、真机、随记诊断、实际 Agent 调查或真实观察窗口。
较早通过记录不能充当这些路径的同版复验，部分与未执行项继续保留。

当时仅保存过 enabled=false 的任务草稿与只读 validate 响应；建议的每天 09:00 Asia/Shanghai、
Stable/profile=local 和 full-access 均为历史提案，不是本次授权或已启用配置。
具体上线与验收进度须从目标实例重新核对，不再依赖已删除的过程计划。
