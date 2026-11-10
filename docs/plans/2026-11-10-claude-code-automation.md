# Claude Code C：后台任务与内部 Agent

日期：2026-11-10。状态：待实施。前置：[A](./2026-11-10-claude-code-foundation.md)通过；
涉及手机待处理和普通终端接管的功能还依赖[B 问答与恢复](./2026-11-10-claude-code-interaction.md)。
进程所有权、恢复、权限与结果语义按 L3。总体边界见[父计划](./2026-11-10-claude-code-parity.md)。

## 用户结果与范围

用户可显式选择 Claude 执行定时任务、快捷指令后台运行、任务控制与独立 Review；监控、自进化、旁聊以外的分析服务可配置 provider。
每个入口单独声明支持、策略和验收结果，不因底层 `claude -p` 可以返回文本就一次性全局替换 Codex。
现有任务、默认 provider、日程、历史 run 和活跃进程保持原归属；切换 provider 只影响显式保存后的新执行。
不要求克隆 Codex 商业配额界面；没有经过验证的官方数据源时不展示推算余额。

## C1：后台 provider 与结构化结果

| 修改/新增路径                                                                                                | 职责                                        |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| `packages/shared/src/scheduled-tasks/{types,api,recovery,continuation}.ts`                                   | Claude provider、能力、执行策略与恢复元数据 |
| `backend/src/scheduled-tasks/providers/claude.ts`（新增）、`capabilities.ts`、`types.ts`、`result.ts`        | 非交互进程、结构化事件、最终结果与能力探测  |
| `backend/src/scheduled-tasks/{service,continuation,run-record,task-config}.ts`、`storage/`                   | 冻结 run、attempt、取消、等待与持久化       |
| `backend/src/routes/scheduled-tasks.ts`、`packages/runweave-cli/src/commands/scheduled-task*.ts`             | 输入校验和显式 provider 选择                |
| `frontend/src/features/scheduled-tasks/`、iOS `Contracts/ScheduledTasks.swift` 与 `Features/ScheduledTasks/` | 模型、权限、结果与恢复入口                  |

- [ ] 探测 CLI、认证、真实可用模型、结构化输出与精确继续能力；各能力独立记录。无持久 session 或缺恢复证据时不能开放后台执行。
- [ ] 实现原生 `-p` 结构化流与 schema 输出的 adapter；消费 system/init、assistant、工具、错误及 result，并保存真实 session。
      native result、schema 校验与业务 succeeded/blocked/failed 分别处理；进程退出 0 不代表业务 succeeded。
- [ ] 延续现有普通任务私有 cwd 与快捷指令项目上下文；run 冻结 provider、model、effort、cwd、实际权限策略与版本。
      不读取当前全局设置重解释历史 attempt，不给普通任务继承项目环境。
- [ ] 后台子进程清理不属于该 run 的终端 Hook 身份；事件使用自己的 run/attempt scope，不冒充前台 completion。
- [ ] 采用有界输出与期限、AbortSignal、process owner 和回收流程。取消/超时先终止自己拥有的进程组，再确认退出；
      不凭裸 PID 文件杀其他进程，不在进程仍活跃时报告可接管。
- [ ] 业务结果未知、Backend 崩溃或提交后失联不自动重放。恢复指向精确 session，接管前释放后台执行权，
      并发打开只生成一个前台 binding；失败时保留可核对的 run 与 error。
- [ ] 自动续跑按已保存 policy 与预算执行，用户的显式输入只消费一次；限流等待不能无上限重试。

## C2：执行权限和兼容策略

- [ ] 保留旧 `sandbox | auto-review | full-access` 的 Codex 语义，不将 Claude 的 `default/plan/auto/acceptEdits/bypass` 直接映射。
      新增可选的 provider 专属执行策略字段，使用判别 union，校验 provider 与策略匹配；旧 Codex 请求继续读取旧字段。
- [ ] Claude 新任务必须显式选取已验证策略。未指定策略、旧客户端不能描述策略或当前平台不能落实隔离时，拒绝创建 Claude 任务并说明原因。
      旧任务不自动转换；禁止以 bypass 作为探测失败或无人回答时的 fallback。
- [ ] 遇到需要人答的真实问题/权限时进入 waiting；只有已释放后台 owner 才允许前台接管或发起下一 attempt。
      复用 B 的原生问题通道；没有可用通道时明确 blocked，并给出原生精确恢复入口。
- [ ] continuation、历史 run、任务导入导出与 Swift DTO 同步扩展；数据迁移只新增字段，不篡改旧 provider 或历史结果。
      拒绝不兼容的旧服务写入，不删掉新字段后误按 Codex 执行。

## C3：任务控制与独立 Review

文件落点：`backend/src/terminal/tasks/`、`backend/src/terminal/code-review/{service,hooks}.ts`、
`backend/src/routes/terminal/tasks.ts`、`app-server/src/agents/supervision-reader.ts` 和相关 shared task/review 合同。

- [ ] 将启动、原生轮次观测与交付确认从 Codex 专属调用拆为静态 Claude/Codex adapters，
      沿用 task operationId、ready、native turn 和验收回执合同。无法观测原生 turn 完整性时不开放该 provider 的任务控制。
- [ ] Review 配置分别表达来源 Agent 与 reviewer provider；显式选择 Claude reviewer，不自动换默认 reviewer。
      reviewer 只获得冻结 snapshot、允许范围和规则，不能读取来源对话、历史、旁聊或 handoff。
- [ ] 报告仍通过现有 artifact、schema、reviewId 与 case 生命周期持久化；无 finding、有 finding、复审、关闭和重启恢复不因 provider 改变。
      reviewer completion 只代表报告提交候选，不能自动合并、发布或结束有未处理 finding 的事项。
- [ ] 可执行资源与 hooks 跟随 reviewer 生命周期保留，避免更新插件后旧 reviewer 无法继续。

## C4：监控、自进化和内部分析

文件落点：`backend/src/task-supervision/`、`backend/src/evolution/providers/`、
`backend/src/screen-recording-analysis/{provider,runtime}.ts`、shared 配置元数据与对应模型选择 UI。

- [ ] 长任务监控分别配置被观察的 executor 与用于判断的模型 provider。Claude 原任务的证据来自 A 的原生记录，
      不能误用 Codex reader，也不能把另一 provider 的判断结果写回错误 terminal。
- [ ] 自进化新增 Claude adapter，保留现有 schema、只读/受限工具与 MCP 边界；mixed 策略明确 provider 组合，
      不静默改变原有 Codex+Trae 行为。
- [ ] 屏幕记录分析新增可选 provider，保留已有图像输入范围、输出上限、超时 watchdog 和项目/数据权限。
      旁聊依赖 B 的独立只读执行器；不得因共用 provider 而复用主任务进程。
- [ ] 各消费者可以复用小型结构化进程 helper，但权限、业务 schema、状态和所有权由各自服务管理，不抽出万能 Agent 宿主。
- [ ] 日报与研究 MCP 保留现有 Claude 来源；验证实际时间范围、归属、去重与覆盖率，不重复造一套 transcript 缓存。

## C5：诊断、安装态与平台矩阵

- [ ] 诊断提供 CLI/插件版本、能力 reason、认证布尔值、request/turn/session/run 关联与错误类别；
      记录 provider 实际提供的 usage、费用和限流信息，字段缺失为 unknown，不假造套餐余额。
- [ ] 凭据不进入日志/任务记录/UI；原生响应里的环境、工具内容和 transcript 按现有脱敏边界处理。
- [ ] 分别核对 macOS 桌面、macOS/Linux npm Server、Windows npm Server 的安装和回滚。没有原生平台条件时标未验收；
      不为本任务构建 Windows Electron 安装包。
- [ ] 发布前逐项填能力矩阵与最低 CLI/插件版本，版本不匹配时安全拒绝；不以单机安装成功代替整个分发链路验收。

## 验收与回滚

执行 [C 验收计划](../testing/scheduled-tasks/claude-code-automation.testplan.yaml)，并按实际子系统执行既有
[后台运行](../testing/scheduled-tasks/runtime.testplan.yaml)、[续跑](../testing/scheduled-tasks/continuation.testplan.yaml)、
[快捷指令](../testing/background-commands/core.testplan.yaml)、[Review 生命周期](../testing/terminal/independent-code-review-lifecycle.testplan.yaml)、
[监控](../testing/terminal/task-supervision-runtime.testplan.yaml)和[自进化](../testing/evolution/agent-self-evolution-core.testplan.yaml)公共不变量。

执行针对性 typecheck/lint、`pnpm scheduled-tasks:verify-runtime`、改动对应的 evolution verify 与 `pnpm architecture:check`；
扩展现有集成 verify 脚本，不新增单元测试。内部服务使用 Claude 的实际结果分别取证，单一 provider smoke 不覆盖全部消费者。

回滚前停止新建并妥善取消/结束 Claude owner，保留 waiting/run/attempt 与原生 session，旧 Codex 服务和任务不迁移。
旧版本不能安全读取新 provider 的数据时采用其既有不兼容拒绝流程，不强制启动旧进程或丢弃记录。
只有新能力及相关旧 provider 回归有实际证据，才开放对应产品入口；缺少平台、隔离或上游能力仍应报告未完成项。
