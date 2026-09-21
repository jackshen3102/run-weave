# 定时任务 Backend 执行与终端接入计划

日期：2026-09-21。状态：待实施。[Web 总入口与交互计划](2026-09-21-scheduled-tasks-web.md)的依赖部分，独立以真实 API、存储、进程与普通终端验收。

## 现状与关键判断

- `backend/src/evolution/runtime.ts` 已有独立维护循环、租约与停止排空；可参考生命周期，不复用 Evolution 的任务/分析状态机。
- `backend/src/evolution/providers/codex.ts`、`trae.ts` 使用 `exec --ephemeral`、忽略用户配置/规则和只读沙箱，结果是分析 JSON；不能直接承接需要写代码、调用 Skill 和长期恢复的通用任务。
- `backend/src/routes/terminal/index.ts` 现有创建路径负责 Session、runtime、默认 panel、事件与失败清理。若供新领域复用，提取这段编排到 Terminal application 服务，让旧 HTTP 路由和任务打开服务共同调用，禁止复制一套创建逻辑或让领域服务反向调用路由。
- `terminal/application/agent-preparation.ts` 支持已有 panel + resumeThreadId，返回 command_submitted；`agent-recovery.ts` 是既有 idle Codex/Pi panel 的恢复，不适用于凭一个外部 thread 创建新终端。
- `packages/shared/src/terminal/runtime/session.ts` 有 project/thread 身份，无通用来源字段；Terminal store 是 LowDB，新增调度数据不得混入它的任务状态机。
- Worktree 使用规范子 projectId；目录不存在时不能静默回退到父目录。详见[当前合同](../architecture/terminal-worktree-context.md)。

## 固定范围与实施默认值

固定需求：Backend 执行、页面关闭不影响调度、每次新建持久对话、未打开不创建终端、按需复用普通终端、提示词决定目录准备与交付、source 支持来源回跳。iOS 不在本期。

以下为本期实现默认值，不冒充用户此前逐项确认：

- 5 秒调度 tick，同一任务最多一个未结束运行；Backend 默认同时执行一个后台任务，其余独立任务持久排队；waiting 已释放进程后不占全局执行名额，但仍阻止同一任务重叠。不同终端的人工工作不由此锁串行化。
- 正常调度允许 60 秒迟到窗口；重启/休眠错过窗口不补跑、不回放历史执行，记录跳过原因并推进到下一次。仅一次任务过期后关闭安排并保留“错过执行”记录。
- 相同任务尚在 queued/running/waiting 时，到点记录 skipped/busy；手动运行返回 409 和现有 runId。暂停不取消已排队或执行中的运行；停止才取消对应运行。
- 单次后台执行默认最长 2 小时，输出落盘上限 16 MiB；限制可用服务端配置覆盖，不新增表单设置。超限终止自有进程组、保留部分输出和 thread，标记失败原因。
- 首个必须交付的 provider 是 Codex。对 TraeX/Pi 分别做持久执行、精确恢复、停止和失败信号探测；只有通过相同证据门禁才在能力列表启用。普通终端支持某 Agent 不等于已支持其无终端定时执行。

## B0：先验证持久执行到普通终端恢复

- [ ] 在临时项目和隔离数据根验证 provider 的持久执行模式：读取本地 CLI 帮助/实现确认参数，再运行无副作用标记任务。实际 Agent 运行需执行阶段授权与既有凭据，不在写计划阶段触发。
- [ ] 获取 provider 真实 threadId，确认落盘历史可读；保留与普通终端相同的 provider 配置、插件/Skill 和历史命名空间，不使用 ephemeral，不手工伪造 thread 文件。
- [ ] 销毁执行进程，使用现有创建终端与 prepare 路径精确恢复，追问要求复述先前随机标记；同时核对实际 thread 身份，而非只看文字相似。
- [ ] 首次运行、失败后有 thread、停止、等待授权分别观察真实协议。只有结构化信号能支持 waiting；不能从“请授权”几个字推断可接管。
- [ ] 输出可用能力及恢复所需字段；Pi 若需要 sessionFile，沿用精确文件/ID 校验，不能仅存 UUID。新 provider 未通过则明确 unavailable，不带病进入调度。

退出标准：至少 Codex 闭环成立；不成立时先修 provider adapter，不用提前创建隐藏 TerminalSession 规避“未打开不占终端数量”的要求。B0 是编码先决实验，不声称本轮已证实。

## 数据合同

新增 `packages/shared/src/scheduled-tasks/{types,api}.ts` 与包子路径导出。Backend-only owner、PID、lease、数据库模型留在 Backend。

| 对象            | 必要内容                                                                                                                                                            |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Task            | id、revision、name、projectId、provider、prompt、可选 model/effort、schedule、enabled、nextRunAt、createdAt/updatedAt/deletedAt                                     |
| Schedule        | daily/weekdays/weekly/once 判别联合；IANA timezone；重复用 localTime，weekly 用非空 weekdays，once 用明确 UTC runAt 并保留展示时区                                  |
| Run             | id、taskId、taskRevision、不可变配置快照、trigger、scheduledFor、状态、起止时间、summary、error、产物、输出游标、executionProjectId/cwd、threadRef、terminalBinding |
| ThreadRef       | provider、threadId、可选 sessionFile；thread ID 在 provider 真正建立前允许空                                                                                        |
| TerminalBinding | terminalSessionId、panelId、attachmentState（creating/starting/ready/failed）、恢复错误；绑定与 run 执行状态分开                                                    |
| Artifact        | label、kind（link/file/text）、安全 URL 或受控文件引用；自由文本中的链接不自动视为发布成功证据                                                                      |
| Terminal source | 可选判别联合，首个分支为 `{ type: 'scheduled-task', taskId, runId }`；不存任意回跳 URL，不代替 projectId/thread                                                     |

Run 状态：queued → running → completed/failed/cancelled/waiting；waiting 在明确接管操作中可继续到 running，再结束。另有调度 skipped（busy/missed）。停止操作可以有内部 stopping 状态，API 必须区分“请求已接收”和“进程已退出”；不提前显示已停止。

已完成 run 不随后续普通终端轮次变更。等待处理 run 仅由其绑定的 operationId + provider/thread + panel completion revision 推进，不能凭 source 标签吞并后来任意对话的完成事件。

## HTTP 合同

全部位于当前已认证 Backend 的 `/api/scheduled-tasks` 下。沿用 requireAuth 和已有项目权限/路径边界，不新增无认证执行接口。

| 方法与相对路径                    | 行为                                                                                                                                                                                                                              |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET `/capabilities`               | enabled、provider 可用能力/原因、运行限制；初始化失败返回 503，不伪装空任务                                                                                                                                                       |
| GET `/`                           | parentProjectId/精确 projectId、q、archived 过滤与 cursor 分页，limit 默认 50、最大 100                                                                                                                                           |
| POST `/preview`                   | 校验 schedule，返回服务器当前时间和下 3 次 UTC 时间；无副作用                                                                                                                                                                     |
| POST `/`                          | 创建 Task；必须 Idempotency-Key；返回 201 与 revision                                                                                                                                                                             |
| GET `/:taskId`                    | 当前配置及软删除状态；已删除允许只读查询                                                                                                                                                                                          |
| PATCH `/:taskId`                  | 修改配置或 enabled，必须 expectedRevision；更新失配 409；变更时间规则重算未来 nextRunAt，不立刻补触发                                                                                                                             |
| DELETE `/:taskId`                 | 带 expectedRevision 软删除并禁用安排；重复删除幂等；不删除运行、thread、终端或工作目录                                                                                                                                            |
| POST `/:taskId/runs`              | 立即运行；必须 Idempotency-Key；202 + run；同键重试返回同 run，键与请求体不符 409                                                                                                                                                 |
| GET `/:taskId/runs`               | 游标分页历史，保留配置快照                                                                                                                                                                                                        |
| GET `/runs/:runId`                | 状态、摘要、来源任务快照、thread 可恢复性和 binding                                                                                                                                                                               |
| GET `/runs/:runId/output?cursor=` | 有界增量文本/结构化事件，不返回任意文件路径；单页最大 64 KiB                                                                                                                                                                      |
| POST `/runs/:runId/stop`          | 幂等请求停止当前 owner；202，最终状态通过详情确认；已结束直接返回当前状态                                                                                                                                                         |
| POST `/runs/:runId/open-terminal` | 请求默认无 body；仅 terminal_repurposed 后用户确认可传 `{ replaceRepurposedBinding: true }`（再次服务端校验）；幂等取得/创建绑定；200 已有或 202 启动中，返回 projectId、terminalSessionId、panelId、terminalUrl、attachmentState |

静态路径先于 `/:taskId` 注册。错误结构统一 code/message/details：400 invalid_schedule/invalid_input，401 未认证，404 资源不存在，409 revision_conflict/run_busy/context_unavailable/thread_busy/thread_unavailable/terminal_repurposed，503 provider_unavailable/scheduler_unavailable。Web 不可自行传 command、任意 cwd、threadId 或 source 给打开接口；这些由已存 run 解析。

## B1：独立存储与调度

- [ ] 新建 `backend/src/scheduled-tasks/storage/{store,migrations,worker-protocol,sqlite-worker}.ts`，独立 SQLite `scheduled-tasks.sqlite`；路径从现有 Backend 数据根派生，在 `backend/src/utils/path.ts` 增加解析函数。复用现有 SQLite worker/生命周期模式，不让新存储依赖 Evolution 数据。
- [ ] Task revision 乐观锁；运行快照与唯一 occurrenceKey 在同一事务落库，自动触发键包含 taskId/revision/scheduledFor，人工键绑定请求 body hash。创建任务的幂等结果也持久化。
- [ ] 新建 `service.ts`、`schedule.ts`、`runtime.ts`。后端统一计算下次时间；时区和时间由服务端验证。DST 缺失的本地分钟跳过，重复分钟每日规则只运行第一次；去重键以选定 UTC occurrence 为准。
- [ ] tick 不重叠；数据库事务 claim、lease 和进程 owner identity 防重复执行。PID 仅作线索，不作为跨重启仍拥有执行权的唯一证据。
- [ ] 崩溃边界：claim 后、spawn 前后、结果写入前都可能不确定。失去 owner 的 run 先查持久 provider 事实，能证实完成才 completed；其余 failed/interrupted 并保留 thread，不自动重跑有外部副作用的提示词。不能宣称副作用 exactly-once。
- [ ] queued 可在重启后继续；running 的自有进程组需可确认退出/接管后才释放互斥，无法确认时占用保持并返回 owner_unresolved，不能靠 lease 过期直接启动第二个进程。
- [ ] 在 `bootstrap/runtime-services.ts` 装配并立即登记资源清理，Backend 停止时停止 tick → abort/等待自有执行 → 持久化结果 → 关闭存储。初始化失败隔离为调度不可用，保留普通终端可用。

## B2：执行 adapter 与运行结果

- [ ] 新建 `backend/src/scheduled-tasks/providers/{types,codex,capabilities}.ts`；TraeX/Pi 通过 B0 后各自新增 adapter。请求 prompt 通过 stdin/结构化参数传递，禁止拼 shell 文本。
- [ ] 在 `execution.ts` 管理进程组、输出上限、超时、AbortSignal、真实完成事件与 thread 保存；返回 exit=0 也需正常完成事件，启动命令已提交不算成功。
- [ ] 每次执行保存不可变配置；启动时重新解析项目真实路径，不依赖浏览器当前选择。若 Agent/工具改变到已登记 Worktree，仅接受实际运行事件/可信上下文解析更新 executionProjectId/cwd，不解析助手自然语言猜 cwd；不因产物位于另一目录迁移 thread。
- [ ] 沿用当前 provider 的用户配置和既有权限策略；不默认禁用规则、trust 或开启危险 bypass。无人值守遇到不能继续的权限交互，保存真实原因与恢复信息后转 waiting，先释放后台执行权再允许终端恢复。无可恢复 thread 的启动失败显示 failed。
- [ ] 读取普通用户配置所需环境，与终端恢复保持同一身份；过滤父终端的 Session/Panel 绑定和内部 hook token，避免把任务输出归到发起操作的终端。为调度 owner 明确注入独立 run 身份。
- [ ] 不将凭据写入 Task/Run/API/log；工作日志落在 Backend 私有数据根，页面只通过鉴权输出接口读取。停止不回滚已发生的文件或外部操作。

## B3：按需打开普通终端与通用来源

- [ ] 在 Terminal application 新建 `create-session.ts`（拟新增）承接 `routes/terminal/index.ts` 的现有创建编排；旧路由改为调用，保留 runtime preference、清理、默认 panel、事件及 Activity 行为。
- [ ] 扩展 `packages/shared/src/terminal/runtime/session.ts`、`backend/src/terminal/store/{store,lowdb-records,lowdb-store}.ts`、`manager/` 记录映射和 `application/payloads.ts`，完整持久化/序列化 source。普通创建可省略；任务来源由内部服务赋值，不允许任意客户端伪造不存在的 run 归属。
- [ ] 新建 `scheduled-tasks/terminal-attachment.ts`：按 backend/provider/thread 加锁，验证 run 与实际 context，先查存量绑定/可恢复 source 记录，再创建一个普通终端并使用现有默认 panel 恢复。
- [ ] 创建后、恢复前持久化 binding；恢复失败保留同一失败绑定供重试，不反复新增终端。新 store 与 Terminal LowDB 无跨库事务，通过 source + 持久 attachment 操作记录做启动核对；创建后回写前崩溃也要能找回唯一已创建终端。
- [ ] 调用 prepareTerminalAgent 的 panelId + resumeThreadId + skipInitialPrompt；不重复提交任务原提示词。等待 provider 实际 thread/provider 与预期一致才 ready，失败返回错误；既有 Recover agent 不承担外部 thread 首次导入。
- [ ] 已有正确 thread 的存活终端直接返回，严禁再 spawn Agent。同 run 并发打开返回同一 binding。终端已删除时允许创建替代终端；终端被用户切到另一个 thread 时返回 terminal_repurposed，不覆盖，提供用户显式“另开终端”动作后替换绑定。
- [ ] running 不允许同 thread 第二 owner，open 返回 thread_busy；Web 展示运行进度。waiting 必须先确认后台进程退出，才转交输入所有权；完成后自由追问不污染原 run。
- [ ] 项目/Worktree 已移除返回 context_unavailable，thread 文件缺失返回 thread_unavailable；原记录仍可查看，不自动改目录、不创建空对话冒充恢复。

## B4：传输、兼容与验收

- [ ] 新建 `backend/src/routes/scheduled-tasks.ts`，只做 auth/校验/映射，在 `backend/src/index.ts` 注册，领域服务不依赖路由。
- [ ] 旧 Session 无 source 按 undefined 处理；SQLite 增量迁移在事务内执行并保留旧数据。新增可选字段不要求 iOS 同步改动；只检查本期 TS 实际消费者。
- [ ] 功能关闭配置 `RUNWEAVE_SCHEDULED_TASKS_ENABLED=false` 停止新触发并保持查询，不能删除历史。旧版本回滚忽略新增存储，回滚前排空后台 owner；已创建普通终端和 provider 历史保留。
- [ ] 新建 `scripts/verify/scheduled-tasks/runtime.ts` 作为真实 SQLite/子进程集成验证入口，支持 `--case` 选择 time、dedupe、restart、attachment、shutdown 等独立 fixture；使用临时数据根和可控时钟/进程故障注入，复用生产服务，不新增线上测试 API、不编写单元测试。真实 provider 验收单独执行，不由该受控 fixture 冒充。
- [ ] 使用[运行时验收用例](../testing/scheduled-tasks/runtime.testplan.yaml)，并回归 [Backend 生命周期](../testing/platform/backend-runtime-lifecycle.testplan.yaml)、[Worktree 上下文](../testing/terminal/workspace/project-context.testplan.yaml)中受改动影响的链路。

```bash
pnpm --filter @runweave/shared typecheck
pnpm --filter @runweave/backend typecheck
pnpm --filter @runweave/backend lint
pnpm architecture:check
pnpm backend:verify-lifecycle
pnpm testplan:validate docs/testing/scheduled-tasks/runtime.testplan.yaml
pnpm docs:check
```

只使用隔离数据根、临时项目和专属进程/tmux；执行 Dev Session 命令时先应用对应 skill，禁止以停止真实安装态 Backend 做重启用例。不新增单元测试。并发、重启、输出等确定性故障可以用隔离进程 fixture 检查控制面；至少一条真实 provider 闭环不能由 fixture 替代。

## 主要风险与停线标准

1. provider 无法持久化/恢复：不能启用该 provider；Codex 门禁失败则完整功能不交付。
2. 进程 ownership 无法证实：保持占用、呈现错误，不能为“恢复成功率”并行启动同 thread。
3. 目录缺失或归属改变：不回退路径；不能覆盖用户已经重新使用的普通终端。
4. 重启后副作用不确定：不自动重新执行；恢复对话由用户明确打开，保留可审计失败原因。
5. 终端创建公共路径回归：必须通过普通创建/停止/输入及 source 缺省兼容，再接任务入口。
