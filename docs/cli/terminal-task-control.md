# 主 Agent 控制终端任务

`rw terminal task` 用于 Dots 等主 Agent 创建专用终端、持续交办、读取原生结果并记录验收。
当前执行器是 Codex，运行于 tmux。一个任务绑定一个终端和固定面板；返工沿用该终端。
主 Agent 决定目标和下一步，Backend 保存执行事实，不运行第二个调度器。

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

## 终端页面独立代码 Review

桌面 / Web 与原生 iOS 的终端「更多 → 代码 Review」直接请求 Backend 创建独立的可见
Reviewer 终端，不需要来源 Agent 调用 CLI。它复用本页的任务执行能力，但**不调用
`task review` 登记验收**；完成仅表示独立报告已保存，不表示需求符合、无缺陷或可发布。

[共享合同](../../packages/shared/src/terminal/code-review.ts)与
[Backend owner](../../backend/src/terminal/code-review/service.ts)定义当前协议。
`POST /api/terminal/session/:id/code-reviews` 按 requestId 去重，同来源的活跃运行复用；
GET 同一路径返回最近 20 条记录和 before 游标；
`GET /api/terminal/code-reviews/:reviewId` 返回状态、快照摘要和独立报告。
产物通过该路径下 `artifacts/:artifactId` 鉴权读取，客户端不提交文件系统绝对路径。
旧 Backend 的 404/501 显示能力不支持，不回退为向来源 Agent 发指令。

审查范围与项目变更页一致：staged 是 HEAD→index，working 是 index→working，包含未跟踪
文件，不自动审整个分支。快照对两侧内容和版本进行两次读取核对，最多重捕获一次；
单文件沿用预览限制，本轮文本上限 16 MiB。二进制、大文件、冲突、符号链接及读取失败保留
明确缺口。无变更或全部不可读时停止自动推进，不启动空审查。

来源身份、工作区及回传账本仅存于 Backend。Reviewer prompt 通过白名单模板构造，只包含
本轮编号、代码路径、冻结快照、通用规则和自有输出目录，不读取来源历史、目标或交接。
新 Reviewer 使用现有 Codex provider 和用户模型配置；缺少原生 thread/final 或工具环境时
明确阻塞或记录未执行，不切换模型制造通过。本功能没有新增文件系统安全沙箱。

数据保存在 Backend 数据目录的 `terminal-code-reviews/`。冻结输入和保存报告分目录，
原生完成轮次、完整 final 与执行侧 idle 必须同时成立，才校验并保存报告；证据复制到
Backend 管理的白名单目录。文件存在及 JSON 合法不证明语义正确或复现成功。
完成时重新比较范围指纹，漂移则标 stale，原报告仍属于旧快照。用户可在来源状态条打开
报告或 Reviewer；不会自动切走来源页面。Reviewer 终端与历史报告保留。

发起与自动回传只使用总终端 ID。客户端无需提交 panel、thread 或启动操作编号；后台从该
终端所属项目捕获代码，报告保存后通过普通终端输入接口直接发回原总终端。Review 不新增
忙闲、草稿、任务或会话切换判断，不新增设置；排队及输入行为与手动发送相同。界面切换
到其他终端不会改变回传目标。写入意图先持久化，不确定写入记 unknown，不重放；written
只说明输入 I/O 接受，不代表来源 Agent 已确认。Backend 重启后只重新排队从未尝试写入
的已保存报告，不恢复通用任务的 supervisor 权限；已尝试且结果不确定的回传记 unknown。
启动等待上限 120 秒，审查观察上限 30 分钟，超时不强杀 Reviewer。

验收入口为 [独立 Review 计划](../testing/terminal/independent-code-review.testplan.yaml)。
构建、API、浏览器与 iOS 交互、真实 Reviewer、自动回传、重启与草稿保护需分别取证；
格式校验通过不代表该计划的 20 个用例已经执行。

Reviewer 启动先通过原生 `hooks/list` 只读核对该工作区的配置。仅当所有**已启用** Hook 都已受
信任或由管理员托管时，才给本轮进程传入 `--dangerously-bypass-hook-trust`，略过 Codex 对已
停用但内容变更的插件副本显示的启动审核。停用项继续停用，不写全局信任状态，不更换模型。
存在已启用且未受信任的 Hook、配置读取不完整或原生能力不可用时，在 Backend 明确阻塞，
不启动一个等待用户处理 Hooks 弹窗的 Reviewer。这个选项只用于独立 Review 进程。
对应行为验收见 [Reviewer Hooks 启动计划](../testing/terminal/independent-code-review-hooks.testplan.yaml)。
