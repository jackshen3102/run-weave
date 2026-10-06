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
