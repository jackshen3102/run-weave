# 快捷指令一键后台运行实施计划（收敛版）

日期：2026-09-28。状态：实现中，端到端验收未完成。本版替代此前主计划；自更新子计划已撤回。

## 本期目标

在现有快捷指令卡片加一个“后台运行”按钮。点击后在当前项目/worktree 执行已保存的技能指令，
用户可以离开页面；点“查看运行”看过程和结果；结束后收到能辨认项目/worktree 的通知，
点击通知进入对应运行，需要追问时恢复原对话。

沿用[现有页面 SVG](../prototypes/background-plugin-commands/README.md)，不增加创建任务的操作步骤。
桌面/Web 提供入口，桌面和 iPhone 接收通知；iPhone 复用已有运行详情与终端恢复页面。
首批接入已保存的 `$toolkit:github-pr` 技能指令，按原文执行，后续技能按相同入口扩展。

本期不做桌面自更新、跨 Backend 重启继续执行、独立 worker、launchd job、维护租约、
新任务平台或新的全局队列。`$toolkit:update-runweave-desktop` 暂不开放后台运行，
界面说明“当前版本不支持后台更新桌面应用”。这些能力不是本期验收前置。

## 现有能力与最小接入方式

当前已存在 `ScheduledTaskService`、SQLite 任务/运行表、`ScheduledTaskRuntime` 单并发队列、
Codex 后台 provider、输出接口、`ScheduledTerminalAttachment` 和任务推送。
本期直接接入这些能力，不新建 `background-commands` 领域服务、command 表、
`background-runs/dispatcher` 或另一套恢复合同。

| 部分     | 复用入口                                                                           | 本期新增                                       |
| -------- | ---------------------------------------------------------------------------------- | ---------------------------------------------- |
| 启动     | `backend/src/scheduled-tasks/service.ts`、`storage/`                               | 启动快捷指令的方法与原子入队操作               |
| 执行     | `runtime.ts`、`providers/`                                                         | 使用原队列和进程管理，仅补冻结目录的一致性检查 |
| 查看     | `frontend/src/features/scheduled-tasks/{task-detail,run-progress,run-summary}.tsx` | 将运行记录展示用于快捷指令弹出层               |
| 恢复     | `terminal-attachment.ts`、Web `open-run.ts`、iOS `ScheduledRunView.swift`          | 继续使用同一 run/thread/source，无新聊天区     |
| 手机通知 | `backend/src/device-monitor/scheduled-task-alerts.ts`、现有 APNs 通道              | 项目/worktree 文案和运行目标                   |
| 桌面通知 | `electron/src/monitoring/attention-notifications.ts` 的既有宿主模式                | 不依赖终端身份的运行通知 IPC                   |

### 使用现有 task/run 存储

`scheduled_runs.task_id` 有非空外键，因此每个 `(quickInputId, 实际 projectId)` 对应一条内部任务，
复用原 task/run 关联。在 task 配置和 run 快照增加可选 `origin`：
`{kind:"quick-input", quickInputId, projectName, worktreeName}`；旧记录缺失时保持原语义。

内部任务使用已有一次性 schedule 保存创建时间，固定 `enabled:false`、`nextRunAt:null`，
运行使用已有 `trigger:"manual"`。它只承载手动执行配置，不进入自动调度，界面不展示日程字段。
普通定时任务列表排除这类记录；禁止通过定时任务编辑/启用/立即运行接口绕过快捷指令校验。
按 taskId/runId 读取历史、输出、停止和恢复仍使用原接口。

现有 SQLite worker 增加一个事务操作：查幂等记录 → 取得/创建内部任务 → 检查活跃 run →
更新未来配置版本 → 保存新 run 与幂等记录。不要在前端串两个 create/start 请求。
已有 run 快照不变；删除快捷指令不删除 task/run 历史。不新增存储表，来源元数据进入已有 JSON。
该内部入口自行校验项目、provider、模型、权限和指令；不借用要求未来调度时间的公开 create 接口。

## 用户交互和业务规则

1. **点击即启动。** 卡片空余位置显示“后台运行”。提交时防重复点击；成功显示
   “项目 / worktree · 运行中 · 查看运行”，不弹表单，不自动打开终端或跳页。
2. **当前 worktree 准确。** 前端传当前生效的 projectId，Backend 按规范 context 解析 cwd。
   快捷指令保存的 projectId 会归到父项目，只用于模板作用域判断，不能代替实际执行目录。
   无项目、目录失效、跨父项目模板请求必须拒绝，不能回退父目录或旧终端 cwd。
3. **一次操作只执行一次。** 同键同请求返回原 run，同键异请求 409；同一模板和实际项目已有
   活跃 run 时返回其 ID，卡片直接查看。响应未知时沿用原键确认，不能换键重跑。
   先查已有幂等结果，再校验模板版本，避免使用时间变化破坏成功请求的重试。
4. **查看复用原记录。** 弹出层内展示原 RunProgress/RunSummary；关闭再打开从 Backend 读最近 run。
   通知进入已有 `/scheduled-tasks/:taskId?run=:runId` 详情。快捷来源隐藏调度配置/编辑，保留
   任务名、完整项目/worktree、摘要、输出和恢复入口；不新增历史管理页面。
5. **恢复沿用原规则。** 后台 owner 未释放不能接管；只有 recoverable 且恢复 ready 后进入普通终端。
   继续使用现有 scheduled-task source 回跳。目录被删除仍可查历史，恢复明确报错。
6. **便宜模型一次设置。** 在现有 scheduledTasks 配置和设置入口追加 quickInputDefaults 的
   model/effort/executionPolicy，每次点击不询问。模型显式选择并验证，不继承前台或静默换贵模型。
   未配置时显示一次性设置入口；权限沿用已有档位和探测，不自动升为 full-access。
7. **执行边界沿用已有规则。** 首版 Codex、支持的已保存技能及非交互输入模式；无技能或不可用权限
   在启动前拒绝。Backend 读取模板原文，不接受任意 shell/cwd。页面关闭不影响运行；Backend
   重启沿用现有中断处理，不自动重放有副作用的指令。只有有效结构化 succeeded 才显示已完成。

## 通知

标题：`browser-viewer / wt-1 · 已完成`。
正文：`创建 github pr · PR #123 已合并`。以上为示例；失败/受阻显示“失败／需要处理”及简短原因。

名称从本次 run 冻结的 origin 取得，不读取接收通知时当前选中的项目。有 worktree 同时显示项目名
和 worktree 名；无 worktree 只显示项目名。长标题保留 worktree 辨识部分并满足网关限制。
不推送原始提示词、完整目录或长日志。主动取消保留已停止记录，不推送成功通知。

- **手机**：本次 run 已在原表中，直接使用 ScheduledTaskAlerts、现有任务提醒订阅和类别。
  在推送合同增加可选 `target:{resourceType:"scheduled-run",resourceId:runId}`，同步网关校验、
  去重指纹和 APNs payload。原生 App 按 hostId 选连接，鉴权后读取 run 得到 taskId，进入原
  ScheduledRunView。离线/记录缺失显示原因，不跳到其他同名项目。
- **桌面**：应用级监听已结束的快捷来源 run，前台应用内提示、后台系统通知；点击携带原连接/runId。
  弹出层关闭不停止监听；按连接/runId 保存已提示标识，避免刷新重复提醒。
  按 finishedAt 增量补读并完成全部分页，保留重叠窗口后去重；不能只记录创建时间游标而漏掉晚结束的任务。
- 沿用现有推送去重、重试、5 分钟有效期及 unknown 处理，不另建 outbox/投递框架。
  通知失败不改变业务结果或重跑任务；APNs accepted 不等于手机收到。权限/订阅只设置一次。
  Desktop 退出时不承诺本机通知；手机能否收到取决于 Backend 存活和已有有效订阅。

## API 和修改范围

| 文件范围                                                                                                            | 接入合同                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared/src/terminal/runtime/input.ts`、`scheduled-tasks/{types,api}.ts`                                   | 快捷启动请求、来源快照和运行筛选类型；复用 ScheduledRun/输出/恢复 DTO                                                                                                                                             |
| `backend/src/routes/terminal/input/quick.ts`、quick-input service                                                   | 新增鉴权 `POST /api/terminal/quick-inputs/:id/run`，body 为 `{projectId,expectedInputUpdatedAt}`，头带 Idempotency-Key；返回 202 + ScheduledRun                                                                   |
| `backend/src/scheduled-tasks/service.ts`、`storage/{store,worker-protocol,database,validation}.ts`、`run-record.ts` | 内部任务、来源名称快照、原子入队；复用原 runtime.wake，保持普通任务 CRUD 语义                                                                                                                                     |
| `backend/src/routes/scheduled-tasks.ts`                                                                             | 新增鉴权 `GET /api/scheduled-tasks/runs?source=quick-input&projectId=&finishedSince=&cursor=&limit=`，返回原分页包装；finishedSince 用于按结束时间补读终态，否则用于卡片最近记录；已有详情/输出/停止/恢复接口不变 |
| `frontend/src/services/terminal/quick-inputs.ts`、快捷指令两组件、既有 scheduled-tasks 服务/queries/task-detail     | 按钮、连接隔离查询、复用运行展示；列表跨游标补读，不漏掉后台期间结束的记录                                                                                                                                        |
| `packages/shared/src/configuration/fields.ts` 及配置 schema、现有设置入口                                           | quickInputDefaults 默认值与来源说明，使用现有配置机制                                                                                                                                                             |
| `scheduled-task-alerts.ts`、Electron main/preload/通知模块、`packages/shared/src/desktop/bridge.ts`                 | 原通知增加项目名和运行目标；窄 IPC 不要求 terminalSessionId                                                                                                                                                       |
| `packages/shared/src/push-notifications.ts`、push-gateway `notifications.ts/delivery.ts/apns.ts/types.ts`           | 可选不透明目标 ID，不接受任意 URL，兼容旧无 target 消息                                                                                                                                                           |
| iOS `DeviceNotification.swift`、`NotificationCoordinator.swift`、`RootView.swift`、原 ScheduledTasks 详情           | 保存待打开目标、鉴权读取、路由；复用原详情与恢复，不新增后台命令页面体系                                                                                                                                          |

错误沿用现有风格：401/403 未授权，404 模板不存在，409 版本/目录/活跃运行冲突，
400 不支持的指令，503 provider 不可用。活跃冲突携带原 runId。所有查询和操作均需 Backend 鉴权。
实现者可为控制文件长度增加局部 helper，不扩大为新领域服务。

## 实施顺序与验收门槛

**A：接通一条普通指令。** 完成原子入队和快捷按钮，在隔离项目真实运行一次。
下一步前必须取得同一 runId 的 queued → running → 终态、实际 cwd、持久输出证据，原终端没有收到输入。
仅有 job 存储、接口空壳或更新保护不能通过这个门槛。

**B：接通查看、恢复和通知。** 基于 A 的真实 ScheduledRun 接入详情、原 thread 恢复、
项目/worktree 文案及桌面/手机点击定位。各通道分别取证，手机环境缺失不能用桌面截图替代。

**C：端到端验收。** A、B 的生产接口与消费者接通后，执行
[本期验收清单](../testing/background-commands/core.testplan.yaml)。既有能力只做受影响回归，
引用[定时任务 runtime](../testing/scheduled-tasks/runtime.testplan.yaml)和
[推送用例](../testing/app/push-notifications.testplan.yaml)。本期没有自更新验收前置。

## 兼容、风险和验证

- 来源字段可选，旧记录保持原行为。普通任务列表与配置编辑不暴露内部任务。新 renderer 对旧 Backend
  404/缺失能力显示不可用，原五个快捷操作保持。新 Backend 配合旧 renderer 不显示新入口。
- 不改存储表结构，新增字段与校验同步升级。回滚前停止新提交并归档快捷来源数据，核对旧版本读取
  和列表表现，不删除数据库。旧客户端忽略通知 target 时仍能打开原 host。
- 网关先支持 target 再上线发送端；旧网关拒绝字段时不能反复发送或声称直达结果已通过。
- 已有 `scripts/background-command-worker/job-store.mjs` 和更新 guard 改动不作为本期依赖。
  本轮不回滚这些已有代码；本期 run 落在 scheduled_runs，沿用原更新器活跃任务保护，无需维护租约或豁免。
- 风险集中在错误 worktree、重复副作用、两个 thread owner、通知归属错误及定时任务回归。
  不新增单元测试；扩展既有集成验证入口。

实施后执行受影响包的 typecheck/lint、`pnpm architecture:check`、
`pnpm scheduled-tasks:verify-runtime` 和 `pnpm docs:check`，要求退出 0。
Web 使用 runweave-dev-session + playwright-cli；macOS 系统通知使用 Computer Use；
手机以 agent-device 和真实 APNs 到达/点击证据验收，仅使用隔离项目和获准设备。

验收用例格式校验：

```bash
pnpm testplan:validate docs/testing/background-commands/core.testplan.yaml
pnpm docs:check
```
