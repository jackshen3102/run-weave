# Terminal tmux 生命周期与恢复

本文描述当前恢复边界，不保留旧的分阶段改造或新增字段建议。用户任务由 tmux server/pane 承载，
node-pty 是 Backend 与终端之间的 attach 通道；attach client 或 Backend 退出不等于用户任务退出。
本文的直接 PTY 回退不包含 Windows standalone 的独立 Host；该模式的进程保活、输入确认和升级边界
见 [Windows PTY Host](./windows-pty-host.md)。

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

Backend 的 tmux 退出策略通过部署变量 `TERMINAL_TMUX_SHUTDOWN_POLICY` 独立配置：
`preserve` 保留 tmux server 和用户任务，只释放本进程的连接与资源；`cleanup` 沿用所属环境的
tmux 清理范围。未设置或空值兼容原行为（Stable 保留、Beta/Dev 清理），非法非空值在领域资源
装配前拒绝启动。该策略也适用于装配失败的回收；不改变显式删除终端的语义。

退出策略不影响 socket 选择：显式 `TERMINAL_TMUX_SOCKET_PATH` 优先，默认路径继续按 channel
选择。服务器应明确设置 preserve，并保持 Profile、terminal store 和 socket 不变。
Backend 重启仍会断开 WebSocket；只有原 tmux/pane/任务 PID 不变才算进程保活，恢复 Agent thread
不能代替这一保证。首次从旧清理策略切换的运维边界见[部署概览](../deployment/overview.md#后端重启与终端保活)。

1. tmux WebSocket 按 session 与观看端的 `resumeClientId` 取得独立 attach runtime；只有同一观看端
   重连才复用其显示流。旧客户端未提供恢复身份时，每个连接独立 attach。各端共享原 tmux pane/任务，
   但 PTY 行列数、输出镜像和恢复缓存相互独立，不能把桌面尺寸的 VT 指令广播到手机网格。
   普通 PTY 仍按 session 复用 runtime。控制面输入优先借用在线显示通道；无在线通道时建立的临时
   attach 使用 `ignore-size`，不参与观看端尺寸选择，并按 idle 规则回收。
2. tmux session 仍存在而 attach runtime 缺失时，重新 attach，并取得当前 pane 的 fresh snapshot。
3. 一个观看端断开后，其 attach runtime 最多保活 60 秒；到期或超过全局 8 个 idle
   runtime 的上限时释放最早 idle 的实例。tmux session 与用户任务继续存活。
   后台输出和 metadata 仍由 watcher 与全局 terminal events 链路维护。
4. tmux 的 snapshot 与 live output 使用同一 attach 输出流的字节游标衔接，不能拼接独立 attach 的快照。
   删除终端或项目时按 session 清理全部观看端 runtime；某个 attach 的失败和回收只作用于该显示流。

## 弱网输出恢复

[共享协议](../../packages/shared/src/terminal/runtime/websocket.ts) 的可选 `recovery`、`cursor`、
`range` 字段只描述展示输出，不代表命令执行确认。客户端以实例内存中的 `resumeClientId`、
`resumeStreamId`、`resumeOffset` 请求恢复；ticket/session 鉴权保持独立。

- 同一 runtime、有效客户端 lease 和完整缓存边界同时成立时，仅续传已提交 cursor 之后的输出。
  Web 在 xterm write callback 后提交，iOS 在完整帧同步 feed 后提交；接收队列中的数据不算已显示。
  本地终端尺寸变化会作废旧网格的恢复游标；包括断线期间外围提示条导致的布局变化，此时安全降级
  为快照，不承诺短断线无清屏。恢复身份在同一 API/session 的客户端实例内稳定，不写入持久化存储。
- Web 通过 `resizeMode=ordered` 协商按序尺寸确认；Backend 先发完旧网格的输出，再发送带
  cursor 的 `resize` 边界。Web 在同一写入队列中切换网格，隐藏或零尺寸容器不发起适配。
  字节续传缓存不保存尺寸边界，因此实际网格变化仍作废恢复游标；未协商的旧客户端和服务端
  保留原尺寸同步路径。正常适配不重置终端缓冲或退出 tmux copy mode。
- 客户端 lease、输出数据各自最多保留 60 秒。超过时间、字节上限、stream 改变或游标无效时，只取
  当前屏幕快照，不推送裁剪后的尾部，不从 persisted scrollback 补历史。
- [输出镜像](../../backend/src/terminal/runtime/output-screen.ts) 使用固定版本的 headless xterm，
  只保存正常/备用屏幕，scrollback 为零。等待同流解析完成和完整 ANSI 边界后序列化，再补发快照
  cursor 后的连续输出；没有临时 tmux attach，也没有静默 50 ms 即视为一致的假设。
- [状态适配层](../../backend/src/terminal/runtime/output-screen-state.ts) 补充序列化器遗漏的滚动区域、
  保存光标、字符集、鼠标编码、隐藏光标、行尾 wrap 状态及 OSC 8 链接属性。它依赖固定版本的内部字段；升级依赖必须
  重新验证状态及后续 VT 操作一致性。无法安全序列化的状态拒绝恢复，不发送不完整快照。
- Runweave 的 tmux attach 客户端声明 `hyperlinks` 能力；tmux server 3.4 起支持 OSC 8，
  copy mode 历史阅读需 3.5 或更新版本。只有 server 已保留真实目标时，实时输出和重连快照才能保留
  完整地址及字符绑定；仅更新客户端或重启 Backend 不能升级运行中的旧 tmux server，也不能恢复已丢弃的历史目标。
  快照只从镜像里的真实链接属性恢复，不扫描文本。iOS 对旧 TUI 的有限候选确认见
  [原生终端架构](../../packages/app-ios/docs/architecture.md)，候选不代表已恢复 OSC 8 属性。
- Web 终端优先使用 xterm 的 OSC 8 链接，普通 HTTP(S) 文本由官方 `WebLinksAddon`
  识别，两者复用所属页面的打开入口。普通文本只沿终端软换行延伸，不拼接硬换行或缩进续行。

| 资源                  | 上限与行为                                                         |
| --------------------- | ------------------------------------------------------------------ |
| 每条流的续传缓存      | 60 秒、512 KiB UTF-8、8,192 帧；保留完整帧边界                     |
| 展示输出帧            | 64 KiB UTF-8，batch 合并仍保持连续 from/to offset                  |
| 镜像待解析数据 / 操作 | 512 KiB / 8,192；未闭合控制串也有 512 KiB 上限                     |
| 镜像尺寸              | 2～500 列、1～200 行，与对应 PTY resize 一起校验                   |
| 快照                  | 同流 singleflight、全局最多两个工作、2 秒、512 KiB；失败关闭本连接 |
| WS 待发送队列         | 现有 bufferedAmount 加本次 JSON 的 UTF-8 字节不能超过 4 MiB        |
| 断线客户端 lease      | 每 runtime 最多 8 个、全局 64 个，定时过期                         |
| idle attach           | 最多 60 秒、全局 8 个，淘汰不删除 tmux pane                        |

快照的 512 KiB 上限按原始 UTF-8 内容计算；ANSI 控制字符经过 JSON 转义后会增大消息，因此 WS
发送上限单独设为 4 MiB。续传缓存与快照原始内容的上限仍为 512 KiB。

慢客户端使用 1013 关闭，立即退订并在 1 秒内强制结束未完成的 close handshake；Web/iOS 对此停止
自动重试，网络稳定后由用户手动重连。镜像自身超限时释放该 attach，连接明确停止，tmux 任务仍保留。
普通 PTY 不启用游标恢复，旧服务端的无恢复字段消息仍按原路径消费。

### 滚动的归属与位置

tmux 连接通过 `scrollInput: normalized-v1` 协商语义化滚动。Web 和原生 iOS 按行高归一化
手势距离，保留小数余量，同方向合并；每客户端只保留一个未确认批次。一步在 tmux 历史中是
一行，在应用中是一个普通滚轮事件，不能据此推断 Claude 等应用的实际行位移。
原生 iOS 的历史拖动保留原有两倍距离增益；应用内部滚动按一倍行高换算，VoiceOver 的离散行数不乘增益。

[滚动服务](../../backend/src/terminal/runtime/scroll-service.ts)按实际 pane 的状态路由：
已有 copy mode 优先处理历史；应用请求鼠标报告时通过该显示流的 attach runtime 转交普通
滚轮，由 tmux 完成应用协议编码；其余向上滚动进入历史，实时位置继续向下为无操作。
不依据 renderer 的 alternate/mouse 模式或进程名猜测；tmux 外层本身也会启用鼠标报告。
旧 raw input 和旧 wheel bindings 保留，未声明新能力的 Backend 仍使用原兼容路径。

手势绑定实际 pane 和滚动归属。同一 pane 的批次有序执行，单批最多 128 步，待处理最多
512 步；新触摸通过 `scroll-stop` 取消未执行位移。切 pane、应用模式变化、断线和退出会
停止旧手势，不在重连后重放。Web 切走终端、旁聊遮挡、文档隐藏或窗口失焦时取消排队位移，
不能因旧回执到达而继续滚动隐藏的终端。原生 iOS 的远端滚动惯性使用 CADisplayLink 与系统减速率，
新触摸、选区或页面停用立即停止；本地历史继续使用 UIScrollView 自带滚动。

`scroll-state` 返回真实 copy mode、当前 `paneId` 和可用的历史偏移；应用内部位置为未知，客户端不再
按已发送事件数估算其底部。tmux pane 元数据同步在 `activeCommand`、活跃 `paneId` 或备用屏幕/鼠标报告
状态变化时联动刷新 `scroll-state`。

原生 iOS 在 `runtimeKind: tmux`、`scroll-state.owner: history` 且远端未处于外部 `copyMode` 时，使用通过
`GET /api/terminal/session/:id/scrollback/ansi`（`capture-pane -e -J -p -S -5000`，单 pane 并发收敛、
按完整行裁剪至不超过 1 MiB UTF-8）预热的只读本地历史 `SwiftTermSurface` 与 `UIScrollView` 像素滚动承载
向上回看，不进入远端 `tmux copy-mode`；当 `owner: application`（全屏鼠标应用）、远端已处于 `copyMode`、
首次预热未完成或连接旧版 Backend（HTTP 404）时，手势继续走 `normalized-v1` 远端滚动。分屏切换通过
`scroll-state.paneId` 与响应 `paneId` 隔离并作废旧 pane 本地历史。全局回到底部入口只处理本地/tmux 历史，
不把退出 tmux copy mode 声称为返回应用内部底部，未知位置也不作为完成通知的自动已读依据。
滚动回执只确认输入处理，不代表应用已完成显示。

如果原 tmux session 已消失，恢复不再等价于接回原进程。Launcher 会区分原 shell、可恢复的 Agent thread
和不可恢复的执行状态；有可恢复 thread 时可按保存的身份启动 resume，并记录丢失提示。
具体分支以 Launcher 为准，不能把重建后的 shell 宣称为原 TUI 未中断。

`Recover agent` 提供用户显式重建并恢复对话的入口。tmux 继续限定为空闲 Codex/Pi pane；
Windows hosted PTY 的同一入口与状态边界见 [PTY Host](./windows-pty-host.md)，不依赖 tmux pane 身份。

自动重建受时间窗口与次数限制；当前常量为 60 秒内最多 3 次。超过限制会标记不可恢复/退出并返回错误，
不能无限重建。tmux 不可用、探测失败和 session 明确不存在也要分别保留诊断信息。

存在性探测只有明确的 session 不存在结果才能触发缺失恢复；timeout、权限或基础设施错误应保留
原状态并返回失败。只读列表可能继续显示 running，历史接口也可能回退存储内容，这些响应不能证明
一次新的 runtime attach 成功；验收需核对实际探测与 tmux 身份。

## 客户端恢复与输入边界

- tmux 连接通过可选 `connected.tmuxScrollMode = single-row` 声明细粒度回看能力。
  新 Web 在无应用鼠标追踪的备用屏幕中使用专用 Ctrl-wheel 绑定按一行发送，按动画帧合并输入，
  保持滚动距离与方向顺序；切回底部或销毁 surface 时取消未发送输入。普通 wheel 仍为五行，
  未协商 `normalized-v1` 时沿用该兼容路径，不依赖 Backend 与客户端一起升级；未知协议版本也不启用新消息。
- 已恢复运行时但原 tmux 会话丢失等非致命提示，通过 terminal WS 的 `notice` 消息展示；
  `error` 留给失败。Web 与原生 iOS 收到 `notice` 后继续处理连接、快照和输出。
- Web 对建连早期的异常断线也执行有上限的退避重连；连接存活时间只决定重置重试预算。
  正常关闭、鉴权拒绝、已退出会话及 1013 背压/恢复失败仍不自动重连。
- 原生 iOS 的 [SessionController](../../packages/app-ios/Sources/RunweaveIOS/Features/Terminal/SessionController.swift)
  对 ticket 请求的 408、429、500、502、503、504 沿用退避重连；404 等其他 API 错误停止连接，
  不把终端不存在当作临时网络故障。仅恢复 WebSocket 时不取消正在等待确认的 HTTP 输入。
  输入提交开始后若请求取消或连接代次变化，结果标为未确认，保留草稿并提示核对，不自动重发；
  提交前取消不能据此判断命令已经发送。输出恢复游标也不能代替输入确认。
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

原生 iOS 的终端详情请求使用 `includeScrollback=false`，只取导航所需元数据，历史由 WebSocket 首屏传输。
该参数保留 `scrollback: ""` 响应字段并跳过 live history 读取；省略参数仍保留完整详情，旧 Backend 忽略参数时也能解码。

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
[弱网输出恢复用例](../testing/terminal/runtime/output-recovery.testplan.yaml)、
[命令矩阵](../testing/command-matrix.md) 选择本轮检查，保留以下行为边界：

- 原任务存活与缺失重建分别取证；Backend 重启后接回正确 session/panel。
- idle attach 释放、重连 fresh snapshot、后台活动事件和多客户端互不串线。
- 显式关闭与孤儿维护只影响确认归属的资源；pty fallback 保持自己的退出和历史行为。
- Ctrl-C、Esc、方向键、resize、alternate screen、鼠标与 TUI 输出的真实交互。

不新增单元测试或重建 Markdown 测试案例；按现有 YAML 在真实环境取证。本文整理未重新执行这些用例，
也不宣称所有部署形态已经验收。

弱网恢复还需分别验证原生真机热点、切后台、积压断线与 TUI 显示，以及旧 Backend 的整页兼容
和长时间高并发 RSS；已有构建或局部 Web/Simulator 记录不能替代这些边界。协议检查应比较连续
cursor 区间的完整字节及最终屏幕/光标，tmux 重绘导致的重复 marker 不等于重复补发。
