# 主 Agent 控制终端任务

`rw terminal task` 用于 Dots 等主 Agent 创建专用终端、持续交办、读取原生结果并记录验收。
通过 `rw terminal task create` 创建的任务在 tmux 中运行 Codex。任务绑定一个终端和固定面板，返工沿用该终端。
主 Agent 决定目标和下一步，Backend 保存执行事实，不运行第二个调度器。
不需要持久 `taskId`/revision 账本的单次交互编排（`rw terminal send --wait`、`wait-output`、`snapshot --unwrap`、`state --explain`）见 [Agent CLI 控制面](./terminal-cli.md)。
独立 Reviewer 的启动与审查流程见[下文](#原生-cli-与终端页面独立代码-review)。

## 创建、启动、交办

所有命令必须使用同一组 `--instance`、`--profile` 或明确的 Backend 参数，以下省略
这组公共参数。源码验证先 `pnpm cli:build`，将 `rw` 换成
`node packages/runweave-cli/dist/index.js`；目标 Backend 也必须包含本功能。

```bash
rw terminal task create issue-123 --project-id PROJECT_ID --cwd /absolute/project/path \
  --goal '修复问题并提供验证证据' --json
rw terminal task start issue-123 --revision REVISION --json
rw terminal task send issue-123 --revision REVISION --dispatch-id round-1 \
  --text '具体目标、边界、验收要求和上下文路径' --json
rw terminal task observe issue-123 --json
```

`REVISION` 取最近返回的 revision（观察响应中为 `task.revision`），用于拒绝旧观察后的
写操作。不要自动重试 revision 冲突。CLI 返回不含凭据的 `connection`，调用方将连接
引用与 taskId 一起保存。taskId 是调用方选择的 Backend 内唯一键，不要求 Dots 内部 ID。

- `create` 同 key、同项目/目录/目标返回已有记录，参数不同返回冲突。创建意图先落盘，
  终端 ID 在启动运行时前保存。失败或崩溃遗留记录不会自动再建一个终端。
- `start` 只启动一次，默认等待最多 120 秒，`--wait-ms 0..120000` 可调整。
  `waitTimedOut=true` 不代表启动失败。固定面板的原生 bootstrap 完成、Agent idle、启动
  代次与 thread 一致后才进入 ready，业务正文不会提前发送。
- `--agent-start-command` 可指定 Codex 参数，例如合成验收使用
  `codex -c check_for_update_on_startup=false --sandbox read-only`。
- `send` 默认 `--delivery when_idle`。运行中追加显式使用 `--delivery queue`，使用 TUI
  排队输入，不承诺原生 `turn/steer`。不会清空 composer；正文前添加稳定的派发标记。
- 同 dispatch key、正文、delivery 不会再次写入，内容不同返回冲突。`--stdin` 可传多行
  正文；上限 64000 字符。更大上下文使用文件路径和有限摘要。

## 观察与验收

```bash
rw terminal task wait issue-123 --cursor SNAPSHOT_CURSOR --wait-ms 30000 --json
rw terminal task observe issue-123 --after-turn TURN_ID --json
rw terminal task review issue-123 --revision REVISION --dispatch-id round-1 \
  --review-id review-1 --outcome changes_requested --summary '真实入口仍未通过' \
  --evidence-json '["artifact-path"]' --json
rw terminal task send issue-123 --revision REVISION --dispatch-id round-2 \
  --text '根据验收结果继续修复，保留原目标' --json
```

观察返回固定身份、终端状态、原生 turns、读取时间、partial、可用性及派发和验收记录。
只匹配目标 thread 内实际发送的 user message，不靠终端回显或 assistant 回显标记猜测。
读取复用 App Server reader，不 resume 第二个执行器，不触发 task-handoff 模型分析。

| 派发状态           | 含义                                               |
| ------------------ | -------------------------------------------------- |
| `delivery_unknown` | 意图已保存，是否写入无法确认；不自动重发           |
| `written`          | 原终端输入路径返回，尚未找到原生用户消息           |
| `received`         | 找到唯一匹配的原生用户消息及 turn；另看 turnStatus |

未核对的派发会阻止堆叠输入。发送后断线可用同 key 查询原记录；Backend 不承诺 PTY
与落盘原子执行或 exactly-once。始终无法核对时由主 Agent 请求人工处理原终端。

cursor 是快照摘要，供有界等待比较，不是永久事件日志游标。`--after-turn` 包含该轮本身，
避免漏掉运行中轮次的新回答；游标不存在时返回冲突，需要全量观察。来源不可用时返回
unavailable，不推断完成或失败。顶层 idle 不等于业务任务验收成功。

独立历史读取器可能暂时把运行中 TUI turn 显示为 interrupted。terminalState 仍为
agent_running 时，不能据此认定中断或结束，需继续观察。

review 的 outcome 为 `accepted|changes_requested|blocked`，必须取得对应原生终态且 Agent idle；
accepted 还要求 completed 和非空 evidence。证据真实性、产物是否达标由主 Agent 独立
检查，Backend 不把路径当作已运行验证。同 reviewId、同内容可重试，异内容冲突。
验收针对指定派发，旧轮次 accepted 不代表后来追加的工作完成。

## 接手、恢复与中断

Web/iOS/普通 CLI 的输入立即切换为 human，只暂停自动派发，不停止正在执行的 Codex。
短暂自动输入期间的普通输入排队保留；文本附件交付也触发接手。Runweave 之外直接操作
tmux 不在检测范围。

```bash
rw terminal task control issue-123 --revision REVISION --to human --json
# 用户完成或清空未发送草稿后，明确交回。
rw terminal task control issue-123 --revision REVISION --to supervisor --draft-cleared --json
rw terminal task interrupt issue-123 --revision REVISION --scope terminal --json
```

draft-cleared 是调用方确认，不是自动 composer 探测，不会自动删除人工草稿。Backend
重启后恢复为 human，保留派发、原生绑定和验收记录，要求重新观察后显式交回。
终端、面板、thread 或启动代次变化时拒绝自动写入，不隐式重建丢失的 tmux 或迁移电脑。

interrupt 作用于任务终端当下的 TUI，发送 Escape；不支持精确取消某个 turn，不保证清理
后台子进程。继续观察原生 interrupted 等结果，不把输入接受当取消完成。验收和中断都
不删除终端。清理使用明确 terminalSessionId 的 `rw terminal delete`；账本保留，避免旧
taskId 被重用后重放。

Dots 可通过现有 MCP run_command 调用这些命令并有界等待。commandId 只是 shell 调用
句柄，持久任务身份是连接引用和 taskId。当前接口不自动建立 Dots 事件订阅。需要事件
唤醒时可适配官方 MCP Events，不能把普通工具调用宣称为 webhook 回调已接通。

## 实现入口

- [共享合同](../../packages/shared/src/terminal/task.ts)
- [Backend 服务](../../backend/src/terminal/tasks/service.ts)
- [CLI 命令](../../packages/runweave-cli/src/commands/terminal-task.ts)

## 原生 CLI 与终端页面独立代码 Review

原生 CLI 的 `review-agent` Skill 将 `@review` 或明确的独立代码审查请求代发到同一 Backend
Review 服务。当前 Agent 发起后可结束本轮，Backend 将结果回传原会话；独立 Reviewer 执行 `review-only` 职责。
这是提交后的 Skill 调用，不增加原生 CLI 的 @ 自动补全，也不要求打开 Runweave 图形界面。

```sh
rw terminal review start [terminalSessionId] --request-id <uuid> [--panel-id <id>] --json
rw terminal review list [terminalSessionId] [--before <reviewId>] --json
rw terminal review show <reviewId> --json
```

start/list 默认使用 `RUNWEAVE_TERMINAL_SESSION_ID`；从外部发起时须指定来源终端和 Backend 连接。
原会话内按调用者的 tmux pane 或注入面板 ID 绑定。外部指定的终端有多个运行面板时需提供 `--panel-id`。
来源须有可识别的 Agent 会话。审查范围为来源项目当前改动。相同 requestId 的请求可安全重试，
同一来源会话的重复发起复用活跃轮次；无法绑定到现有轮次时返回冲突。

start 返回 `CodeReviewRun` 和 `resultDelivery: "source_conversation"`，表示已登记后台交卷。
list 返回历史，show 返回状态、快照摘要和完整报告。通过、发现 Bug、验收阻塞、启动或运行失败和中断都产生回传。
交互 Skill 发起后可结束当前轮或继续其他工作。脚本可用
`rw terminal review wait <reviewId> [--wait-ms 30000] --json` 查询审查阶段。等待范围为
0～60000 毫秒，0 表示单次查询。返回 `waitTimedOut: true` 时审查仍可继续，后续用原
reviewId 查询；审查阶段结束也无需等待自动回传。

CLI `terminal review` 是发起独立审查，和 `terminal task review` 给任务提交验收结论是不同操作。

桌面 / Web 与原生 iOS 的终端「更多 → 代码 Review」直接请求 Backend 创建独立的可见
Reviewer 终端，不需要来源 Agent 调用 CLI。它复用本页的任务执行能力，但**不调用
`task review` 登记验收**；单轮执行结束表示独立报告已保存，事项是否结束另由审查结果或用户决定，不自动表示需求符合或可发布，需求与验证结果须逐项核对。
Windows 在专用 PTY 中启动原生 Codex，其他平台通过 tmux 面板启动。Backend 等待
原生会话完成初始化并进入空闲，确认仍可控制原终端和同一原生会话后，才发送冻结审查输入。
Windows 启动要求能解析到 Codex 的 `.exe`，启动前先完成下文的 Hooks 检查。

[共享合同](../../packages/shared/src/terminal/code-review.ts)与
[Backend owner](../../backend/src/terminal/code-review/service.ts)定义当前协议。
`POST /api/terminal/session/:id/code-reviews` 按 requestId 去重，同来源正在执行的一轮不会重复派发；
GET 同一路径返回最近 20 条记录和 before 游标；
`GET /api/terminal/code-reviews/:reviewId` 返回状态、快照摘要和独立报告。
每轮有独立 reviewId、快照和报告，同一事项共用 caseId。零 Bug 且覆盖完整时 caseStatus 为 passed。
有 Bug 时事项保持 open，回传只列已复现问题的级别、位置、标题、影响及完整报告路径。
来源实现 Agent 按原任务已有授权核对、修复并验证，用户最新的只读、等待确认、停止或人工接管限制优先。
零 Bug 但有必需验证缺口时，阶段为 blocked，完整报告保留未执行项和缺失证据。
菜单入口与发送旧请求的客户端回传已复现 Bug，其他结果从 Review 记录读取。
此时再次点击 Review 会复用该事项的独立 Reviewer，在新快照上执行新一轮全范围审查，保留旧报告。
仅复用原会话仍可用、空闲且保有自动控制权的 Reviewer；重启后或人工接管时为同一事项新建 Reviewer，不夺回人工控制权。
`POST /api/terminal/code-reviews/:reviewId/close` 由用户主动结束当前事项，caseStatus 为 closed；
不修改问题结论，不代表 Bug 已修复。结束后再次发起 Review 必须新建事项和 Reviewer。
正在执行或等待回传的一轮不能开始复审或关闭事项；跨端共享 Backend 状态，报告仍可从菜单读取。
产物通过该路径下 `artifacts/:artifactId` 鉴权读取，客户端不提交文件系统绝对路径。
旧 Backend 的 404/501 显示能力不支持，不回退为向来源 Agent 发指令。

审查范围与项目变更页一致：staged 是 HEAD→index，working 是 index→working，包含未跟踪
文件，不自动审整个分支。快照对两侧内容和版本进行两次读取核对，最多重捕获一次；
单文件沿用预览限制，本轮文本上限 16 MiB。二进制、大文件、冲突、符号链接及读取失败保留
明确缺口。无变更或全部不可读时停止自动推进，不启动空审查。

来源身份、工作区及回传账本仅存于 Backend。Reviewer prompt 通过白名单模板构造，只包含
本轮编号、代码路径、冻结快照、冻结用户要求、通用规则和自有输出目录。冻结用户要求由
Backend 通过当前终端的会话阅读接口取得，只保留用户消息及其直接引用的项目内计划，
不传入实现者探索、自评或完整对话；Reviewer 不再自行读取来源历史或交接。
每轮自动保存只读 `requirements.json`，最多64条用户消息、5份单份不超过24000字节的计划，
总包不超过48000字节。缺失、不完整、超限或身份漂移时降级为 scope=code，只评价代码覆盖，
summary 与客户端明确“未核验用户目标”；需求缺失本身不阻塞代码审查结束，也不生成目标待办。
需求可用时默认 scope=code_and_goals；用户明确仅审代码、没有可核验业务要求或目标已全部取消时，可在报告中引用用户来源声明 scope=code。不得因目标失败或证据缺失降级范围。必要目标或证据缺口仍使事项保持 open。scope 为可选兼容字段，旧报告不回填。
计划引用并不自动表示采纳；按原文及后续修订判断当前范围。需求包摘要与代码指纹分别保留，
完成时比较代码指纹，code_and_goals 范围另比较需求摘要，变化均标 stale；旧轮次没有需求包时继续按代码审查语义读取。
同一 Reviewer 使用统一 `review-only` 职责，在 checks 中以“目标核验：”记录逐项条件、用户来源、
预期、实际、版本及证据；不再创建第二个核验 Agent。必要条件失败或未执行使 coverageComplete
为 false，缺口本身不伪造为 findings。旧报告保持原文，现有 Web/iOS 验证记录直接展示目标核验。
Reviewer 自行选择审查方法和必要验证。终端最终回复显示结论、已复现问题和关键缺口。
Reviewer 将完整 JSON 写入本轮输出目录，Backend 在同一评审轮次结束后校验并归档报告及证据。
没有待复现疑点或必要运行检查时 checks 可为空；有问题时必须关联已执行的同版复现检查，记录步骤、预期与实际结果及证据。
新 Reviewer 使用现有 Codex provider 和用户模型配置；缺少原生 thread/final 或工具环境时
明确阻塞或记录未执行，不切换模型制造通过。本功能没有新增文件系统安全沙箱。
Reviewer 专用启动参数显式固定 `--sandbox danger-full-access --ask-for-approval never`，
不依赖本机 Codex 权限默认值；通用启动器同时传入 `-c check_for_update_on_startup=false`。

数据保存在 Backend 数据目录的 `terminal-code-reviews/`。冻结输入和保存报告分目录，
原生完成轮次、完整 final 与执行侧 idle 必须同时成立，才校验并保存报告；证据复制到
Backend 管理的白名单目录。文件存在及 JSON 合法不证明语义正确或复现成功。
完成时重新比较范围指纹，漂移则标 stale，原报告仍属于旧快照。用户可在来源状态条打开
报告或 Reviewer；不会自动切走来源页面。Reviewer 终端与历史报告保留。

CLI 回传绑定发起时的面板、会话和执行环境。原 Agent 忙时由 Backend 保留待投递结果，
空闲后检查原会话和人工输入状态再投递。来源面板的人工输入、无法归属面板的输入、人工接管、
来源身份变化或 Backend 重启使本轮自动回传失效，
结果仍可按原 reviewId 查阅。菜单入口的已复现 Bug 继续通过原终端的普通输入路径交付。
写入意图先持久化，投递结果不确定时保留 unknown 和原编号，不重放。written 仅指输入 I/O 接受，
原 Agent 是否已消费要查原生会话。

启动等待上限 120 秒，审查观察上限 30 分钟，超时不强杀 Reviewer。

验收入口为 [独立 Review 计划](../testing/terminal/independent-code-review.testplan.yaml)。
事项闭环见 [Review 生命周期](../testing/terminal/independent-code-review-lifecycle.testplan.yaml)。
构建、API、浏览器与 iOS 交互、真实 Reviewer、自动回传、重启与草稿保护需分别取证；
格式校验通过不代表该计划的 20 个用例已经执行。

Reviewer 启动先通过原生 `hooks/list` 只读核对该工作区的配置。仅当所有**已启用** Hook 都已受
信任或由管理员托管时，才给本轮进程传入 `--dangerously-bypass-hook-trust`，略过 Codex 对已
停用但内容变更的插件副本显示的启动审核。停用项继续停用，不写全局信任状态，不更换模型。
存在已启用且未受信任的 Hook、配置读取不完整或原生能力不可用时，在 Backend 明确阻塞，
不启动一个等待用户处理 Hooks 弹窗的 Reviewer。这个选项只用于独立 Review 进程。
预检解析 `agents.codex.binary`（缺省为 PATH 中的 Codex）后，将同一绝对可执行路径用于
Hooks 查询和 Reviewer 启动，避免预检与实际启动使用不同版本；解析失败时停止启动。
对应行为验收见 [Reviewer Hooks 启动计划](../testing/terminal/independent-code-review-hooks.testplan.yaml)。

Review 反馈使用 `[runweave-code-review-feedback:<reviewId>]` 标记，后续 Review 需求冻结和任务监督目标提取都排除该自动反馈，避免把反馈当成用户新增要求。超过48000字节的反馈仅投递明确标记的摘要与完整报告路径，不声称已传递全部条目。written 仍不表示原 Agent 已消费。

报告中每条问题的全部 evidenceRefs 均须由前后指纹匹配冻结快照的已执行检查覆盖；允许
复现、版本和来源检查共同提供证据，不要求单条检查包含全部引用。仅由 not_run、错误指纹
或未登记产物支撑的证据仍被拒绝，不自动补写证据或把问题降为通过。
