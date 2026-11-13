# tmux base 压测执行计划

本计划中的 tmux base 指 Runweave 的 `runtimeKind=tmux` 基础运行链路：tmux server/session/pane、node-pty attach、后台 pipe-pane watcher、Backend 与观看端。不是仅对裸 tmux 跑吞吐。目标是测出可持续负载、先达到的资源边界，以及达到边界后能否保住任务、隔离故障并恢复交互。

本轮只编写计划，未执行压测，也不预设已发现缺陷。现有 [Windows PTY 计划](./2026-11-13-windows-terminal-stress.md)继续独立保留；macOS 与 Linux 分别执行和出具结果，不能相互代替。

## 代码事实与判定边界

- [tmux 生命周期合同](../architecture/terminal-tmux-recovery.md)：任务属于 tmux pane，node-pty 是 attach 通道。必须分别记录 Backend PID、tmux server PID、pane ID、pane PID、探测任务 PID/启动时间及展示 streamId；只验证 Backend 健康或 thread 相同不算进程保活。
- [会话服务](../../backend/src/terminal/tmux/session-service.ts)串行协调同会话操作；[命令执行](../../backend/src/terminal/tmux/process.ts)默认超时 5 秒。查询超时不等于 session 不存在。
- [显示恢复](../../backend/src/terminal/runtime/registry.ts)按观看端独立 attach；续传窗口为 60 秒、512 KiB、8192 帧。idle attach 最多 60 秒、全局最多 8 个。WS 发送预算 4 MiB，慢端请求 1013 关闭；强制断开时客户端可能只见 1006，需用服务端回执判定。
- [后台 watcher](../../backend/src/terminal/tmux/output-watcher.ts)默认每 500 毫秒采集、每 5 秒协调生命周期；transport 配额 1 MiB，持续增长超过两倍配额时存在强制 reset。[poller](../../backend/src/terminal/tmux/output-poller.ts)允许有诊断的截断并作废旧 cursor。启动仅恢复最近 8 个 session 的 watcher，并发为 2；不能把这个上限混同于全部 session 的环境同步。
- [输入分片](../../backend/src/terminal/tmux/internals.ts)的 send-keys 文本块上限为 8 KiB UTF-8，CR/LF 有 Enter 转换。原始 WS 输入没有 Windows Host operationId 幂等协议；不重发结果不确定的输入，不要求一个不存在的 ACK。

执行时重新核对上述常量、运行配置和代码版本；发生变化时记录差异并调整边界输入，不能按旧值宣称通过。

## 隔离与证据

每例创建独占 profile/config root、terminal store、短路径 tmux socket、端口、临时项目和合成数据。显式设置 `TERMINAL_TMUX_SOCKET_PATH`；保活用例设置 `TERMINAL_TMUX_SHUTDOWN_POLICY=preserve`，cleanup 用例独立建立 fixture。保存非测试资源的只读基线，禁止操作默认 socket、现有用户终端或生产服务。所有 tmux 命令必须显式指定本例 socket；停止、信号注入与删除前校验 PID 启动时间和资源归属，finally 负责恢复 SIGSTOP 与清理自有资源。

负载驱动和回执放工作区外，不新增单测、产品接口或测试框架。驱动需通过现有鉴权 API/WS 创建和操作真实终端；直接调用 TmuxService 的分片探针单列为集成证据。若需 `dev:session` 生命周期，使用 `toolkit:runweave-dev-session`；执行 YAML 使用 `toolkit:run-test-cases`，浏览器操作使用 `toolkit:playwright-cli`。本计划不授权生产故障注入、发布或部署。

证据分三条链，不能混合比较：

1. 探测进程写独立账本：runId、输入序号、收到的字节摘要、执行次数、输出数量、单调时钟。驱动先在无负载下自校验，避免 shell 行规程、echo 和生成器自身限速造成假阳性。
2. 显示链记录同一 attach 的 streamId、cursor、range、快照和 resize 边界。tmux 会重绘与合并画面，不能用应用输出的行数或 VT 文本出现次数判定显示丢包。只在同流内检查 offset 连续性，在静止屏幕检查最终 marker、光标和网格；真实页面另行验收。
3. 后台 pipe-pane transport 与持久化历史按实际保留窗口检查序号、UTF-8、截断日志和末尾 marker。明确截断不算无损通过；必须报告发生档位、丢弃边界及恢复情况。Backend 停机期间也不承诺无损历史。

每例每档记录目标/实际输出速率、输入 p50/p95/p99/max/超时数、API 延迟、恢复时间、错误与关闭原因。输入延迟从驱动发送到同一观看端收到探测进程的唯一响应计算，使用驱动单调时钟；进程账本另外证明实际执行，不能用 send/write 返回作为响应。协议响应不证明页面已渲染，UI 另行取证。每秒采集 Backend/tmux/attach/pipe 子进程 CPU/RSS、FD、进程数、磁盘大小；可用时采集 event-loop lag、runtime/subscriber/watcher 计数。没有现成内部指标时用进程和协议证据，不能把未采到写为 0。回执绑定 HEAD、dirty diff 摘要、实际构建产物、OS/架构、CPU/内存、shell、运行中 tmux server 版本与客户端版本，不只记录 PATH 中的 `tmux -V`。

## 负载与通过标准

以下数字是本次拟定的验收预算，不是已有性能承诺。先跑 60 秒无负载基线，各吞吐档预热 10 秒、采样 60 秒并重复 3 次；恢复基线后再升档。macOS、Linux各自报告最大连续通过档位，不平均掩盖较差平台。

| 维度              | 档位                                                                   |
| ----------------- | ---------------------------------------------------------------------- |
| 单 pane 持续输出  | 64 KiB/s、256 KiB/s、1 MiB/s、4 MiB/s                                  |
| 突发输出          | 512 KiB、4 MiB、16 MiB、64 MiB                                         |
| 并发 session      | 1、4、8、16、32，每 session 64 KiB/s                                   |
| 同 session 观看端 | 1、4、8、16；每端独立 resumeClientId                                   |
| 输入              | 1、10、50 次/秒；单操作 8 KiB 前后边界与 64 KiB 多字节文本             |
| 生命周期循环      | 重连 100 次；创建删除每个并发档 200 次；正常/异常 Backend 重启各 10 次 |
| 持续运行          | 默认 20 分钟；全量另跑 2 小时                                          |

- 正确性硬门禁：所有实际执行档位均不能串会话、重复执行输入、静默错接输出、误删 pane 或把超时判成任务丢失。容量不足时允许明确拒绝或合同内快照降级；单列容量结果，不能算该档吞吐通过。
- 常用负载门禁：单 session 64/256 KiB/s，以及 4 session 各 64 KiB/s，本机回环每秒 10 次输入探测，p95 ≤250 毫秒、p99 ≤1 秒、单次 5 秒未回执判超时，超时为 0，不能靠断开显示流维持指标。高档仅探测容量，但正确性仍是硬门禁。
- 无故障时，同流重连恢复至新输入可见 ≤5 秒；Backend 重启从 fresh `/health` ready 起 ≤10 秒恢复交互；故障用例按自己的预算判定。
- 资源门禁：每轮负载结束等 75 秒，再取 30 秒稳定窗口。允许保留的有界缓存单列；专用 attach、pipe 子进程、FD 与订阅最终应回到空闲基线。预热后各轮 Backend+tmux 总 RSS 稳态中位数不高于基线加 `max(64 MiB, 20%)`，超预算记性能失败并保留趋势，不仅凭 RSS 单次上涨断言泄漏。
- 运行中可用磁盘不足 1 GiB、系统内存压力持续 10 秒、非测试终端受影响或无法确认清理归属时立即停止升压，保留证据。记录为容量停止或验收阻塞，不补记未跑档位为通过。

## 执行顺序与交付

1. 校准驱动和进程身份，确认 runtimeKind 实为 tmux；fallback 到普通 PTY 则本次 tmux 验收阻塞。
2. 执行 [传输与后台采集压力](../testing/terminal/runtime/tmux-transport-stress.testplan.yaml)，逐档测量，失败后先保存最小可复现负载。
3. 独立执行 [生命周期与资源压力](../testing/terminal/runtime/tmux-lifecycle-stress.testplan.yaml)。重启、attach 退出、server 查询暂停、session 丢失、删除均有自己的 fixture 和 verdict。
4. 执行 [真实终端交互压力](../testing/terminal/runtime/tmux-ui-stress.testplan.yaml)。浏览器用例不能被原始 WS 或截图替代；原生 iOS、整机重启和休眠唤醒不在本轮默认矩阵中。
5. 汇总逐平台、逐 case、逐档 pass/fail/blocked/not_run、吞吐与延迟、资源峰值/回落、最大稳定档位和第一失败档位。已知截断单独报告。所有自有资源清理完成后复核非测试资源基线。

既有 [tmux 持久化](../testing/terminal/runtime/tmux-persistence.testplan.yaml)、[输出恢复](../testing/terminal/runtime/output-recovery.testplan.yaml)和 [网格同步](../testing/terminal/runtime/viewport.testplan.yaml)作为语义依据；本次增加可复现的负载与循环，不把单次功能通过当成压测通过。

## 文件范围与后续修复

本次仅新增本说明和上面三份 YAML。执行时优先复用当前部署/集成入口；如发现产品缺陷，先交付版本、负载、独立证据与最小复现，再按后续授权修复。可能涉及 `backend/src/terminal/tmux/`、`backend/src/terminal/runtime/`、`backend/src/ws/`、`backend/src/terminal/scrollback/`；协议变更进入 `packages/shared`，真实 UI 缺陷才改对应消费者。

当前无 API、存储、认证或配置迁移。若后续改变它们，另写兼容和回滚方案；不能用清空 terminal store、换 socket 或降低原门禁来掩盖失败。保留所有已有工作区改动。

计划检查：分别运行三份 YAML 的 `pnpm testplan:validate <path>`，再运行 `pnpm docs:check` 和本次新增文件的空白检查。格式通过仅表示计划可解析，运行结果以未来实际回执为准。
