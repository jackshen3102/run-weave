# 旁聊接入执行证据

当前交付见 [2026-10-16 受管版本验收记录](managed-acceptance.md)：实现已在隔离 Beta 验证。以下为 2026-10-15 未打补丁上游的历史调查，保留作为采用受管适配的依据，不代表当前仍阻塞。

2026-10-15 的阶段性记录，不是完整功能交付。执行方案仍见 [实施计划](approved-plan.md)。

## 本轮已实现的范围

`frontend/src/components/terminal/surface/use-emulator.ts` 补齐聚焦终端中的 `Ctrl+/` 编码：按标准旧式终端编码发送 `0x1f`，与已有 `Ctrl+7` 一致。按键含义仍由前台应用解释；没有新增全局快捷键、旁聊状态、线程猜测或聊天服务。排除 IME 组合输入及额外 Shift/Alt/Meta 修饰键。

## 修复前的真实源码环境

Dev Session `dvs-f761b8`，Beta `pool-04`，工作树 `81e6c04f594ce8c831ee5cea4a614e300c802495`；Backend `backend:0a18e252-456f-4dd3-8623-a068f0b3c3f4`。本轮磁盘已恢复可用，成功启动源码构建；旧记录中的磁盘阻塞不再代表当前条件。

仅操作本例 terminal `f7e2e530`、panel `c1d4d75e-e369-48e5-bc88-551aa236da0c`、pane `%0`。通过 `dev:open` 返回的 Desktop CDP 执行真实键盘操作。

- 输入 `/side 问题` 成功创建原生旁聊，回复父上下文标记 `SIDE_IMPL_PARENT_1015`。
- `Ctrl+/` 在终端已有焦点时没有发出 WebSocket input；仓库固定 xterm 的 `src/common/input/Keyboard.ts` 处理了 Ctrl+7，未处理 Ctrl+/。
- 同一画面按 `Ctrl+7` 能切回主会话、再切回旁聊；空输入 `Ctrl+C` 能关闭。HTTP raw 注入与实际桌面键盘不是同一路径，旧版 raw 测试失败不能外推为桌面 Ctrl+C 失败。
- [切回后的状态](./beta-parent-after-toggle.json) 与 [关闭后的状态](./beta-after-close.json) 均显示父画面，而 `lastThreadId` 仍为旁聊 `01a13f18-2f88-7051-aa49-4cf1351bdd37`。真实父 ID 是 `01a13f17-93f2-7491-98dd-8129ae0105c2`。[Panel 采样](./beta-panels-after-close.json) 同样保留旁聊 ID。当前源码也存在身份污染，不再只是旧安装版风险。

## 身份信号门槛：未通过

[原始 hook 载荷](./native-hooks.jsonl) 使用本例启动命令的临时 hook wrapper 捕获 stdin，再不修改载荷地转交仓库原 dispatcher。只覆盖自有 Codex 调用，未修改全局 hooks；不记录认证信息。

| 原生事件                   | 实际可见字段                                                                     | 缺失的接入信息           |
| -------------------------- | -------------------------------------------------------------------------------- | ------------------------ |
| 父 SessionStart            | session_id、非空 transcript_path、source=startup、cwd、model、permission_mode    | 无当前显示会话事件       |
| 子 SessionStart            | 新 session_id、transcript_path=null、source=fork、相同 cwd/model/permission_mode | 无 parent ID、side 标志  |
| 子 UserPromptSubmit / Stop | 子 session_id、turn_id、transcript_path=null、prompt 或回答                      | 无父身份、显示身份       |
| 主旁聊专用切换及关闭       | 本次捕获没有新增上述 hook                                                        | 无显示切换或旁聊丢弃通知 |

与固定上游 [`schema.rs`](https://github.com/openai/codex/blob/rust-v0.160.1/codex-rs/hooks/src/schema.rs#L499) 的 SessionStart/UserPromptSubmit/Stop 合同一致；该版本 [TUI fork 调用](https://github.com/openai/codex/blob/rust-v0.160.1/codex-rs/tui/src/app_server_session.rs#L877) 内部知道父子关系，不代表外部 hook 获得这些信息。

`fork` 不是旁聊专属，空 transcript 也不能单独证明旁聊身份。基于它们猜测并忽略新 thread 会伤害普通 fork、临时主会话和真正会话切换；保持“首次 thread 永远为主”也不符合计划。仅靠子 hook 即使补出父子关联，仍不能判断用户已切到哪个输入上下文。

官方 [App Server 文档](https://learn.chatgpt.com/docs/app-server) 描述 RPC 线程查询，但当前 TUI 可运行内嵌服务器；另起 `codex app-server` 并不等于附着已有 TUI 的内存旁聊。首次本机 daemon 查询返回 control socket connection refused。这个结果只说明默认 daemon 未连接，不能据此排除原生 TUI 连接受管 App Server 的路线；后续已实际核查如下。

主身份、监督、恢复及浮动输入隔离未实现，完整 required 合同未通过。后续信号核查补齐了具体依赖，不能用猜测补齐 DTO。

## 补充核查：终端协议与同一 App Server

2026-10-15，真实二进制仍为 0.160.1。使用独立 tmux socket `rw-side-signal-audit`，先启动原生 `codex --no-daemon --no-alt-screen -c 'tui.terminal_title=["thread-id"]'`，再以自有临时 App Server、仅转发的本地 WebSocket 探针和原生 `codex --remote ws://127.0.0.1:<probe-port>` 核查另一条连接路径。探针未实现聊天 UI，也未加入产品启动链路。RPC 日志只保留方法、关联 ID 和挑选的线程元数据，没有记录认证信息、完整配置或正文。

测试进程移除了继承的 `RUNWEAVE_*` / `CODEX_*` 任务变量，没有向当前用户任务发送 hook。原生内嵌测试在临时目录进行；远端模式使用已受信任的当前工作树，只发送“回复固定标记，不使用工具、不编辑文件”的测试问题。没有确认临时目录的持久信任提示，没有修改全局配置或升级 CLI。

| 核查项                                     | 真实结果                                                                                                                  | 能用于何处及限制                                                                                                     |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 终端 OSC 0 标题                            | 配置名 `thread-id`，实际输出 `01a13f9e-811b-7bc0-bbe2-7443b...`；主→子→主→子→关闭后主均更新                               | 可验证显示切换确实发生；不是完整 ID 合同。仅保留 29 字符并附 `...`，生成标题时另有 spinner；用户可关闭或修改标题配置 |
| 原生 `thread/fork` 返回及 `thread/started` | 子 `01a13fa3-a7bb-7ae1-ba1d-5740acc78a1c` 的 `forkedFromId` 为主 `01a13fa2-ee23-7050-a798-677865787434`，`ephemeral=true` | 同一运行时的创建关系可观测；不是旁聊专属角色标记                                                                     |
| 活着的子会话 `thread/read`                 | 同一完整子 ID 返回 `ephemeral=true`、`forkedFromId=null`、`parentThreadId=null`，`sessionId` 为子自身 ID                  | 不能靠重新查询补回错过的 fork 关系；`sessionId` 也不能替代父 ID                                                      |
| 专用切换 RPC                               | 切父出现 `thread/read`；切回旁聊没有该查询，但有 skills/plugin/app 刷新。两次均没有专门的显示会话事件                     | 不能把最后查询或刷新工具目录的 thread 当作当前显示会话；这些方法没有焦点语义                                         |
| 空输入关闭旁聊                             | 原生发 `thread/unsubscribe` 并立即返回父界面；稍后查询子仍为 idle；`thread/closed` 比 unsubscribe 晚 **60,007 ms**        | unsubscribe 是连接订阅变化，closed 是服务器卸载。后台观察者不能把其等同于 TUI 已丢弃旁聊                             |
| 内部会话记录                               | `CODEX_TUI_RECORD_SESSION` 对其他 AppEvent 只记录 variant；专用切换在 TUI 内直接选择 thread                               | 不提供带身份的选择成功快照，不能拿调试事件名补齐上下文                                                               |

原始数据：[标题时间线](./signal-title-stages.jsonl)、[OSC 载荷](./signal-osc-titles.json)、[RPC 元数据流](./signal-rpc-events.jsonl)、[RPC 操作时间线](./signal-rpc-stages.jsonl)、[关闭前查询](./signal-side-read-before.json)、[关闭后仍存活](./signal-side-read-after.json)、[稍后卸载](./signal-side-read-after-later.json)。[审计汇总](./signal-audit.json) 记录版本、源码 SHA256、60,007 ms 差值和自有资源清理结果。以上是原生终端和 RPC 探针证据，不是 Runweave 产品集成验收。

源码依据固定在官方 tag：

- [标题项输出](https://github.com/openai/codex/blob/rust-v0.160.1/codex-rs/tui/src/chatwidget/status_surfaces.rs#L941) 调用 32 字符截断，实际 UUID 36 字符变为 29 字符加省略号；[截断函数](https://github.com/openai/codex/blob/rust-v0.160.1/codex-rs/tui/src/chatwidget/status_surfaces.rs#L1091)、[OSC 0 输出](https://github.com/openai/codex/blob/rust-v0.160.1/codex-rs/tui/src/terminal_title.rs#L53)。
- [fork 响应](https://github.com/openai/codex/blob/rust-v0.160.1/codex-rs/app-server/src/request_processors/thread_processor.rs#L5317) 额外写入 `forked_from_id`；[live snapshot](https://github.com/openai/codex/blob/rust-v0.160.1/codex-rs/app-server/src/request_processors/thread_processor.rs#L6261) 默认该字段为空；[thread/read](https://github.com/openai/codex/blob/rust-v0.160.1/codex-rs/app-server/src/request_processors/thread_processor.rs#L2824) 没有替观察者恢复 TUI 本地关系。
- [选择会话](https://github.com/openai/codex/blob/rust-v0.160.1/codex-rs/tui/src/app/session_lifecycle.rs#L540) 在 TUI 更新 `active_thread_id` 并重放 widget；[旁聊映射](https://github.com/openai/codex/blob/rust-v0.160.1/codex-rs/tui/src/app/side.rs#L726) 由 TUI 的 `side_threads` 维护。[fork presentation](https://github.com/openai/codex/blob/rust-v0.160.1/codex-rs/tui/src/app_server_session.rs#L182) 区分普通 fork / side，但 [RPC 参数](https://github.com/openai/codex/blob/rust-v0.160.1/codex-rs/tui/src/app_server_session.rs#L942) 不传播这个枚举；不能把任意 ephemeral fork 都归为旁聊。
- [关闭旁聊](https://github.com/openai/codex/blob/rust-v0.160.1/codex-rs/tui/src/app/side.rs#L423) 先 unsubscribe 再丢弃本地状态；[服务器 unsubscribe](https://github.com/openai/codex/blob/rust-v0.160.1/codex-rs/app-server/src/request_processors/thread_processor.rs#L1020) 只移除该连接订阅；[会话日志](https://github.com/openai/codex/blob/rust-v0.160.1/codex-rs/tui/src/session_log.rs#L215) 不记录其他 AppEvent 的身份载荷。

原生升级提示给出 0.162.1，因此另取该 tag 的六个对应源码文件核查，没有升级运行时。其 [标题输出](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/tui/src/chatwidget/status_surfaces.rs#L949)、[fork 返回](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/app-server/src/request_processors/thread_processor.rs#L5337)、[snapshot](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/app-server/src/request_processors/thread_processor.rs#L6293) 仍有上述限制；所查 hook、RPC 方法合同和 TUI 选择代码未补显示上下文事件。这是源码核查，不是新版运行证明，也不外推到所有未来版本。

### 路径判断与最小外部依赖

**“原生 TUI + 同一受管 App Server”确实能运行并暴露 fork 的创建关系，不应再称作完全没有信号。** 但它仍未提供旁聊角色和 TUI 当前显示身份的完整可重建合同，不能单靠改启动架构解决本计划的隔离要求。截断标题匹配、隐藏边界提示词、最后一次 app/read 或最近一个 ephemeral thread 都属于对实现细节的推断，本计划不把它们作为监督和自动输入的依据。

最小解锁条件是原生 **TUI 所有者** 提供可订阅并可重取的结构化上下文：完整主 ID、旁聊 ID 及其父关系、当前显示 ID、选择/丢弃成功后的更新顺序，并能绑定 CLI 启动代际。它可通过原生 hook、终端结构化协议或 TUI 可访问的接口提供；不能仅补服务器 thread/read，因为服务器不拥有 TUI 的显示状态。以上是缺失能力清单，不是声称 Codex 已存在某个新 API。

取得该能力后，Runweave 的接入顺序已明确：先在 hook 写入主状态前分类 → 持久恢复目标只接受真实主会话变更 → 完成与监督按主 thread 归属 → 浮动草稿及附件按显示上下文隔离并拒绝旧代发送 → 执行现有 YAML 的并发、重连、恢复用例。当前没有自行修改 Codex、接管默认 daemon 或新增生产旁聊运行时；这几项依赖的实现仍未完成。

| 本轮验收范围                                   | 状态                                                        |
| ---------------------------------------------- | ----------------------------------------------------------- |
| 原生命令、切换、关闭；Runweave Ctrl+/ 键盘兼容 | pass，真实 Beta 证据见下                                    |
| 父子关系与显示身份能否从现有信号完整接入       | fail，hook / OSC / RPC / TUI 调试记录均已核查，具体缺口见上 |
| 主身份污染                                     | fail，当前源码 Beta 已复现，尚未修复                        |
| 完成、监督、浮动草稿与附件、重启恢复隔离       | blocked，未实现，不能计为通过                               |

自有两个原生 TUI 已 `/quit`，专用 tmux server 已退出，临时 App Server 与 RPC 探针均已停止。没有停止或修改用户的 Codex 进程。

## 修复后验证

新 Dev Session `dvs-256702`、Beta `pool-04`，同一工作树 revision 加本次未提交补丁，terminal `2ec4a621`。

- 真实终端 `/side 问题` 创建并回答父标记；`Ctrl+/` 从旁聊切回父，再次 `Ctrl+/` 返回同一回答，分别只发送一个 `[31]` 输入帧。[键盘结果](./keyboard-results.json)、[切回父](./fixed-toggled-parent.json)、[返回旁聊](./fixed-returned-side.json)。
- 焦点在终端外按钮时，`Ctrl+/` 不发送终端输入；普通斜杠仍用于原生命令。
- 旁聊空输入 `Ctrl+C` 返回主会话且切换提示消失：[关闭证据](./fixed-closed-side.json)。
- [修复后真实 Beta 截图](./beta-fixed-side.png)，已实际查看；不是 HTML 原型截图。
- 前端 typecheck、lint、architecture:check、docs:check 通过；15 条 YAML 格式校验通过，不能将其视为 15 条产品用例执行通过。

两个自有 Beta Session 均已停止，自建终端与项目已删除。未新增单元测试，未更新 Stable，未提交代码。
