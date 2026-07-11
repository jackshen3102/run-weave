# Terminal 事件恢复与架构问题测试用例

本文档验证 Terminal Workspace / App 的全局事件链路在 backend 重启、事件保留窗口溢出和突发事件下是否可靠，并为架构诊断图中的 P1—P5 提供“先复现、再修复”的统一证据。

涉及浏览器页面复现或验收时必须使用 `$toolkit:playwright-cli`。本仓库不为这些场景新增单元测试文件。

## 处理门槛

- 只有在当前代码或隔离运行环境中稳定复现的问题才进入修复。
- 只有数量事实、理论风险或极端边界，且没有可见错误或可测成本时，记录为 `NOT REPRODUCED`，不修改产品代码。
- 修复后的回归必须沿用原复现步骤，不能以类型检查代替行为证据。

## P1：event cursor 恢复

| ID      | 场景                        | 复现步骤                                                                                                          | 修复前失败信号                                        | 修复后预期                                                                                                  |
| ------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| TER-001 | backend 重启后 ID 从 1 复用 | 客户端先消费事件 1、2 并保留 cursor/seen set；重建 `TerminalEventService`；用旧 cursor 2 重连并记录新事件 1、2、3 | catchup 为空；新事件 2 被当成旧事件去重，只交付事件 3 | ticket 携带新的 stream identity；客户端清空旧 cursor/seen set、重拉权威快照，新 stream 的事件不被旧 ID 去重 |
| TER-002 | cursor 落后 500 条保留窗口  | 记录 502 条事件后用 `after=1` 重连                                                                                | 服务只返回 3—502，事件 2 静默缺失且没有 gap 信号      | `connected` 明确返回 `cursor-too-old`；Web/App 重拉权威快照，再消费可用 catchup                             |
| TER-003 | 保留窗口边界                | 记录 502 条事件后分别用 `after=1`、`after=2` 重连                                                                 | 无法区分真正缺失与刚好覆盖边界                        | `after=1` 有 gap；`after=2` 无 gap且返回 3—502                                                              |
| TER-004 | cursor 超前于当前 stream    | 当前最新事件为 3，用 `after=9` 重连                                                                               | catchup 为空且没有恢复信号                            | `connected` 返回 `cursor-ahead`，客户端重拉权威快照                                                         |
| TER-005 | 正常断线重连                | 同一 stream 已消费到 2，断线期间产生 3、4，再用 `after=2` 重连                                                    | 不应触发误恢复                                        | stream identity 不变且无 gap；只 catchup 3、4，不触发全量重拉                                               |

## P2—P5：其它问题复现门槛

| ID      | 原型问题                       | 必须执行的复现                                                                                                            | 进入修复的判定                                           | 不处理的判定                                             |
| ------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------- |
| TER-101 | P2 结构事件放大全量刷新        | 在隔离 Web/App 环境连续产生至少 3 个结构事件，记录实际 overview/project/session HTTP 请求数量与并发关系                   | 单个用户动作稳定触发重复、等价且未合并的全量请求         | 请求已被调用层合并，或只能靠非现实事件洪泛触发           |
| TER-102 | P3 cached surface 资源乘数     | 用 `$toolkit:playwright-cli` 依次访问多个 terminal，记录实际 `/ws/terminal` 数量、inactive surface 输出行为和可见性能数据 | 正常操作即可稳定造成用户可见卡顿、错误或明确资源异常     | 只能确认连接数量，未出现可见问题或可测异常               |
| TER-103 | P4 断线 pending input 延迟执行 | 在 terminal WS 断开但页面仍可输入时键入有唯一标记的无害文本，恢复连接后检查是否执行及 UI 是否清楚提示                     | 正常网络闪断可稳定让未明确确认的旧输入在上下文变化后执行 | UI 已阻止输入/明确展示待发送，或只能通过极端人工篡改触发 |
| TER-104 | P5 metadata 协议出口重叠       | 触发 cwd/activeCommand 变化，同时记录 session WS metadata、global event 与 Web store 更新次数                             | 同一变化稳定造成双写 store、竞态或错误 UI                | session metadata 仅兼容输出且没有状态写入或用户可见错误  |

## 验证命令

```sh
pnpm --filter ./packages/shared typecheck
pnpm --filter ./backend typecheck
pnpm --filter ./frontend typecheck
pnpm --filter ./app typecheck
pnpm lint
```

真实协议复现脚本必须使用仓库里的 `TerminalEventService` 与 `/ws/terminal-events` server，不得用纯 mock 替代；浏览器用例必须保存 `$toolkit:playwright-cli` 的页面/连接证据。

## 2026-07-11 执行结果

| Case ID | 环境                                         | 修复前证据                                                                  | 修复后证据                                                                     | 结果           | 是否改代码 |
| ------- | -------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | -------------- | ---------- |
| TER-001 | isolated WS + Web backend restart            | 新 service 复用 ID 2，被旧 `seenEventIds` 丢弃                              | streamId 变化后 Web 重拉 1 次 Project + 1 次 Session；新进程 ID=1 项目事件可见 | PASS           | 是         |
| TER-002 | real TerminalEventService + WS               | 502 条事件、`after=1` 只返回 3—502 且无信号                                 | `connected.gap.reason=cursor-too-old`，范围为 3—502                            | PASS           | 是         |
| TER-003 | real TerminalEventService + WS               | 无法区分窗口边界                                                            | `after=1` 有 gap；`after=2` 无 gap且返回 500 条                                | PASS           | 是         |
| TER-004 | real TerminalEventService + WS               | `after=999` 静默返回空 catchup                                              | 返回 `cursor-ahead`，latest=502                                                | PASS           | 是         |
| TER-005 | real TerminalEventService + WS               | 基线行为                                                                    | 同 stream 的 `after=2` 只返回 3、4且无 gap                                     | PASS           | 否         |
| TER-101 | Web + App `$toolkit:playwright-cli`          | Web 连续 3 个创建事件触发 3 次 Project GET + 3 次 Session GET               | Web 合并为 1 次 Project GET + 1 次 Session GET；App 合并为 1 次 overview       | PASS           | 是         |
| TER-102 | Web `$toolkit:playwright-cli`                | 1→3 个 surface 时保留 3 个 xterm、产生 2 条新增 session WS，heap 约 +4.2 MB | 未出现卡顿、错误或异常资源证据                                                 | NOT REPRODUCED | 否         |
| TER-103 | Web `$toolkit:playwright-cli` offline/online | 离线输入在恢复后自动执行，页面无离线提示                                    | 唯一标记恢复后仍未执行，页面显示 `Input was not sent`                          | PASS           | 是         |
| TER-104 | Web `$toolkit:playwright-cli` WS frames      | 同一 cwd 变化抓到 session metadata 与 global metadata                       | UI 只收敛为一个 cwd，未出现双写或竞态                                          | NOT REPRODUCED | 否         |

真实协议回归命令：

```sh
pnpm --filter ./backend exec tsx ../scripts/verify-terminal-event-recovery.ts
```

## 测试报告模板

| Case ID | 环境        | 修复前证据 | 修复后证据 | 结果 | 是否改代码 | 备注 |
| ------- | ----------- | ---------- | ---------- | ---- | ---------- | ---- |
| TER-001 | isolated WS |            |            |      |            |      |
