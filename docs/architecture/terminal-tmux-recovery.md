# Terminal tmux 生命周期与恢复

本文描述当前恢复边界，不保留旧的分阶段改造或新增字段建议。用户任务由 tmux server/pane 承载，
node-pty 是 Backend 与终端之间的 attach 通道；attach client 或 Backend 退出不等于用户任务退出。

## 入口与状态所有者

| 职责                                    | 入口                                                                                                                              |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| session/panel 记录与生命周期            | [Terminal Manager](../../backend/src/terminal/manager/)                                                                           |
| tmux 创建、探测、pane 操作与串行化      | [Tmux Service](../../backend/src/terminal/tmux/service.ts)、[Session Service](../../backend/src/terminal/tmux/session-service.ts) |
| runtime attach、缺失恢复与 Agent resume | [Runtime Launcher](../../backend/src/terminal/runtime/launcher.ts)                                                                |
| WebSocket 客户端与 idle attach 释放     | [Terminal WS](../../backend/src/ws/terminal-server.ts)                                                                            |
| 后台输出与 metadata                     | [Output Watcher](../../backend/src/terminal/tmux/output-watcher.ts)                                                               |
| 运行参数与重建限制                      | [Tmux Internals](../../backend/src/terminal/tmux/internals.ts)                                                                    |
| 跨端 session DTO                        | [Shared Session](../../packages/shared/src/terminal/runtime/session.ts)                                                           |

session 的 `running/exited`、runtime 是否 attached、tmux 是否存在以及 Agent 是否正在工作是不同维度。
不要把其中一个状态直接当作另一个状态；用户可见状态归属见 [Terminal 状态](./terminal-state.md)。

## 创建与隔离

- session 使用确定性的 tmux 名称和专用 socket；同名 session 的存在性、创建和恢复必须由现有服务协调，
  不能让每个 WebSocket 连接各自创建一套 owner。
- runtime 选择应遵循创建请求和环境配置；tmux 不可用时的 pty 路径保留普通 node-pty 行为，
  不承诺 Backend 重启后保活。不能用“所有终端都是 tmux”的旧假设替代实际 metadata。
- 稳定的 terminal store、socket 和活着的 tmux server 是恢复前提。存储位置由
  [Runtime Services](../../backend/src/bootstrap/runtime-services.ts) 及当前部署配置提供，不能根据工作目录猜测。
- Runweave 专用 tmux 配置由 [Tmux Process](../../backend/src/terminal/tmux/process.ts) 管理，
  包括历史上限和按键设置，不修改用户默认 tmux server。

## 连接与恢复

1. WebSocket 根据 session/panel 身份取得 runtime；已有有效 runtime 时复用。
2. tmux session 仍存在而 attach runtime 缺失时，重新 attach，并取得当前 pane 的 fresh snapshot。
3. 最后一个终端 WebSocket 客户端断开时只释放 idle attach runtime；tmux session 与用户任务继续存活。
   后台输出和 metadata 仍由 watcher 与全局 terminal events 链路维护。
4. snapshot 与 live output 可能并发；前端恢复、防止旧 snapshot 覆盖新输出及 output batching 继续走现有链路。

如果原 tmux session 已消失，恢复不再等价于接回原进程。Launcher 会区分原 shell、可恢复的 Agent thread
和不可恢复的执行状态；有可恢复 thread 时可按保存的身份启动 resume，并记录丢失提示。
具体分支以 Launcher 为准，不能把重建后的 shell 宣称为原 TUI 未中断。

自动重建受时间窗口与次数限制；当前常量为 60 秒内最多 3 次。超过限制会标记不可恢复/退出并返回错误，
不能无限重建。tmux 不可用、探测失败和 session 明确不存在也要分别保留诊断信息。

存在性探测只有明确的 session 不存在结果才能触发缺失恢复；timeout、权限或基础设施错误应保留
原状态并返回失败。只读列表可能继续显示 running，历史接口也可能回退存储内容，这些响应不能证明
一次新的 runtime attach 成功；验收需核对实际探测与 tmux 身份。

## 客户端恢复与输入边界

- 已恢复运行时但原 tmux 会话丢失等非致命提示，通过 terminal WS 的 `notice` 消息展示；
  `error` 留给失败。Web 与原生 iOS 收到 `notice` 后继续处理连接、快照和输出。
- Web 对建连早期的异常断线也执行有上限的退避重连；连接存活时间只决定重置重试预算。
  正常关闭、鉴权拒绝、已退出会话仍不自动重连。
- 悬浮输入框等待 HTTP 输入确认后才清空，20 秒未收到确认则回到可操作状态；结果未确认时保留按终端和分屏隔离的草稿，
  显示提示并由用户检查终端后决定是否再次发送，不自动重放。HTTP 成功仅表示输入已交付，
  不表示 Agent 已执行或完成任务。tmux 的 `prompt_replace` 在目标分屏退出回看模式后才写入。
- iOS 手动重连可在离线状态发起新的健康检查；检查成功后重接终端。离线写入仍被禁止。

## 历史与显式关闭

- tmux-backed 运行中历史取自 pane history；专用配置当前保留 5,000 行。这是运行上下文，不是长期审计日志。
- pty 路径继续使用自身 recorder/persisted scrollback，不套用 tmux 的历史删除语义。
- 释放 attach client 与用户显式删除 session 不同。删除 session 才走对应 tmux/panel 清理与记录删除，
  不能在普通网络断开时杀掉 tmux。
- 初始 snapshot 的 capture 延迟会影响打开终端的体感；性能证据需要实际测量，文档中的历史目标不是当前性能通过证明。

## 孤儿 session 与维护操作

当前 [Orphan Scanner](../../backend/src/terminal/tmux/orphan-scan.ts) 只扫描并记录异常。
Backend 启动时仅在配置启用扫描时调用；不可用或扫描失败只记录 skip/failure，不阻塞启动。

- `GET /api/terminal/tmux/orphans` 查看专用 socket 下不在当前 session store 的 Runweave session。
- `DELETE /api/terminal/tmux/orphans?confirm=true` 是独立的显式维护操作，默认仅处理 detached orphan；
  包含 attached session 需要额外选项。
- 不能将“当前 store 查不到”视为跨 Backend 的删除授权。多个 Backend 或不同 store 共用一个 socket 时，
  必须先确认归属；未知资源保持不动。详细实现见 [Terminal routes](../../backend/src/routes/terminal/)。

旧计划中把启动扫描写成自动 GC 的步骤已失效。多实例生产化的 owner/lease、最小年龄和审计保障仍应作为
后续设计边界核对，不能因已有删除接口就认定这些保障齐备。

## 更新与部署前提

- 标准 Stable 通道默认使用用户目录下按 Profile 隔离的持久 socket，Backend 正常退出时保留 tmux。
  Beta 与本地开发默认使用临时 socket，正常退出时停止自身 tmux server；其中的 shell、Agent 和后台
  命令不会跨退出保留。Beta 还回收同 Profile 的旧版持久 socket。崩溃或 `SIGKILL` 无法执行进程内清理。
- 上述隔离依赖标准启动入口的 channel 与独立 Profile。不要手动让 Beta 使用 Stable Profile，
  本地开发从仓库规定入口启动，避免继承错误的 Stable channel。
- 本机客户端或 Backend 重启，只在 tmux server、store 与 socket 保留时才能重新连接。
  pty 终端不具备同样保障；任何更新流程都应依据实际 runtime 判断影响。
- 服务端滚动部署需要新旧 Backend 能访问相同的运行环境与稳定存储。tmux 若位于随部署销毁的容器/Pod 中，
  该容器退出仍会终止任务；仅持久化 socket 文件不会保住进程。
- 独立 daemon、host-level runtime、sidecar 或固定实例是部署选择，本文不声称仓库已交付这些方案。
- 本地更新操作从 [部署入口](../deployment/README.md) 查找；Dev Session 的启动与清理遵循
  [控制面规则](../../scripts/dev-session/AGENTS.md)。

已知元数据限制：旧 socket 中的 session 缺失时，Launcher 可能在重建成功前就改写 socket 并标记
`recoverable: true`。该标记和迁移日志不能独立证明恢复成功，仍需验证目标 tmux session 与实际附着。

## 验证入口

使用 [Terminal Runtime 用例](../testing/terminal/runtime/core.testplan.yaml) 与
[tmux 生命周期用例](../testing/terminal/runtime/tmux-persistence.testplan.yaml)、
[命令矩阵](../testing/command-matrix.md) 选择本轮检查，保留以下行为边界：

- 原任务存活与缺失重建分别取证；Backend 重启后接回正确 session/panel。
- idle attach 释放、重连 fresh snapshot、后台活动事件和多客户端互不串线。
- 显式关闭与孤儿维护只影响确认归属的资源；pty fallback 保持自己的退出和历史行为。
- Ctrl-C、Esc、方向键、resize、alternate screen、鼠标与 TUI 输出的真实交互。

不新增单元测试或重建 Markdown 测试案例；按现有 YAML 在真实环境取证。本文整理未重新执行这些用例，
也不宣称所有部署形态已经验收。
