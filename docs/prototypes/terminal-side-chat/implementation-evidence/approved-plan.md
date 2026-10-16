> 历史实施计划，已于 2026-10-16 执行。下文保留阶段性判断和清单；最终结果及适用边界以 [受管版本验收记录](managed-acceptance.md) 为准。当前合同见 [受管 Codex](../../../../packages/agent-bridge/codex/README.md)。

# Codex 旁聊终端接入实施计划

状态：用户已批准 Runweave 独立管理带最小适配补丁的 Codex，正在实现和真实验收。受管版本固定 `0.160.1`，不替换全局 CLI。历史信号调查仍成立；缺失的 TUI 身份通过受管版本直接发布，不再把上游缺少公开接口作为无法推进的外部依赖。具体实现与启用合同见 [受管 Codex 接入](../../../../packages/agent-bridge/codex/README.md)，实际验证见 [实施证据](README.md)。

本次授权调整：允许在受管 Codex 中发布主会话、当前显示会话、旁聊父子关系、输入就绪状态及代际/版本；在同一个原生 TUI 事件中校验浮动输入并执行原生编辑/发送。旁聊 fork、权限、上下文、模型、切换、关闭与回收仍使用上游实现。

## 1. 目标与决策边界

让用户在主任务运行期间使用 Codex 旁聊，保持独立上下文、主任务继续运行、专用切换保留旁聊、关闭丢弃旁聊。只对齐已核实的 Codex CLI `/side`，不声称复刻桌面端内部实现。

**先验证原终端内的 Codex 原生 `/side`；通过终端管理兼容性门槛后再接入。** 复用终端是实现方向，不是“同一终端内多线程已经管理正确”的证明。不先建设独立聊天服务，不把普通 Fork 改成旁聊。

用户已明确要求：行为与 Codex 对齐、基于证据、原型可实现、不要自行增加功能；最新补充要求独立判断终端复用的可行性。

范围：本机 Codex、现有 Web/Electron 终端。非目标：Diff、历史旁聊、多旁聊列表、持久化子会话、回填主输入、强制只读、新 worktree、其他 Agent、SSH 执行器、iOS 新入口。原有跨端终端访问及普通 Fork 不得回归。

## 2. 三条路径比较

| 路径                             | 能复用什么                                                                            | 实质成本与不一致                                                                                                             | 本计划处理                                           |
| -------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| A：原终端中的原生 `/side`        | 同一 Codex 的上下文、权限、模型、审批、流式输出、旁聊切换与关闭；现有 xterm、WS、tmux | 一个 pane 内有多个 thread，Runweave 的身份、状态、监督、通知、草稿需验证兼容                                                 | 优先验证；通过后作为实现路径                         |
| B：创建独立普通子终端            | 现有终端列表、输入和生命周期管理                                                      | 现有 Fork 是持久 thread + 新终端；不能把 ephemeral fork 交给另一个 `codex resume` 后就假定临时状态可用。改变用户可见生命周期 | 不采用现有普通 Fork 冒充旁聊；A 失败也不自动切换到 B |
| C：受管 app-server + 自建聊天 UI | 部分 RPC 和正文渲染基础                                                               | 要补通知、服务端请求、审批、取消、连接恢复、权限配置同步；当前语音 RPC 客户端不具备完整能力                                  | 不作为本轮实现路线；A 失败后也不擅自扩大为 C         |

A 的优势来自复用原生所有者，并非“终端一定最好”。如果身份来源不能可靠取得，不能靠解析屏幕关键词或最近一次 thread 猜测来补齐；应在阶段 0 明确给出阻塞证据和所需上游能力。

补充验证了 A 的连接变体：保留原生 TUI，让它连接同一受管 App Server。它不是 C 的自建 UI，实际能创建、切换和关闭旁聊；fork 响应能提供父 ID。但 `thread/read` 对活着的临时子会话返回空父 ID；没有专门的 TUI 显示选择事件，`thread/closed` 在本例比界面关闭晚 60,007 ms。故更换连接方式尚不足以解除身份门槛，未将探针变为生产服务。原生标题也已实测：`thread-id` 被截为 29 字符加省略号，不能宣称完整身份接口。

## 3. 已核实事实与尚未证明的内容

### Codex 固定版本证据

- [`side.rs`](https://github.com/openai/codex/blob/rust-v0.160.1/codex-rs/tui/src/app/side.rs)：`side_fork_config` 克隆配置并设置 ephemeral；隐藏边界把旧历史变为参考；明确允许新问题要求的最小修改，禁止子 Agent。`toggle_side_conversation` 不清理，关闭及普通导航走 discard。
- [`app_server_session.rs`](https://github.com/openai/codex/blob/rust-v0.160.1/codex-rs/tui/src/app_server_session.rs#L877)：`fork_side_thread` 使用原生 fork、继承权限与会话配置；不是把终端文本摘要拼成新 prompt。
- [`input.rs`](https://github.com/openai/codex/blob/rust-v0.160.1/codex-rs/tui/src/app/input.rs#L531)、[`keymap.rs`](https://github.com/openai/codex/blob/rust-v0.160.1/codex-rs/tui/src/keymap.rs)：专用切换与空输入关闭路径；实际快捷键服从用户配置。
- [官方命令说明](https://learn.chatgpt.com/docs/developer-commands#start-a-side-chat-with-side)：`/side`、`/btw`、内联问题；审查模式和旁聊内不可再次创建。
- [`SessionStartRequest`](https://github.com/openai/codex/blob/rust-v0.160.1/codex-rs/hooks/src/events/session_start.rs)、[`UserPromptSubmitRequest`](https://github.com/openai/codex/blob/rust-v0.160.1/codex-rs/hooks/src/events/user_prompt_submit.rs)：含 session 身份与可选 transcript 路径；`SessionStartSource` 包含 `fork`，但它不是专属旁聊标记，也不直接提供父 thread。所读结构不能直接证明存在可供 Runweave 使用的 side/parent 标记；不能拿 subagent 字段或 `transcript_path=null` 直接代替旁聊身份。

### Runweave 当前链路

| 事实                                                                                             | 对应源码                                                                                                                                                                   | 对计划的约束                                                                               |
| ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| xterm 的 onData 进入现有终端输入；Backend 写回当前 PTY/tmux                                      | [use-emulator.ts](../../../../frontend/src/components/terminal/surface/use-emulator.ts)、[terminal-input-handler.ts](../../../../backend/src/ws/terminal-input-handler.ts) | 原生命令已有输入通道，先验证是否仅需兼容修复；不默认新增创建 API                           |
| 普通 Fork 要求 idle，创建新终端，调用 fork 后关闭 RPC 进程，再 resume 新 thread                  | [agent-fork.ts](../../../../backend/src/terminal/application/agent-fork.ts)                                                                                                | 原样保留，不解除普通 Fork 空闲保护，不用于托管 ephemeral 子会话                            |
| hook 把 session_id/thread_id 归一为 threadId；过滤 compact 与嵌套 Codex 进程                     | [hook-payload](../../../../packages/agent-bridge/hooks/runweave-hook-payload.cjs)、[hook-bridge](../../../../packages/agent-bridge/hooks/runweave-hook-bridge.cjs)         | 同一 Codex 内旁聊不是另一个嵌套 CLI，现有进程祖先过滤不能被当作旁聊隔离证明                |
| SessionStart/UserPromptSubmit 更新 current thread；各 hook 更新 last thread，Stop 可清空 current | [agent-hook-processor.ts](../../../../backend/src/terminal/application/agent-hook-processor.ts)                                                                            | 安装版及当前源码 Beta 均已复现：旁聊覆盖 current/last thread，切回及关闭后 last 仍为子身份 |
| completion 推进完成 revision、最新回复及后续处理                                                 | [event-service.ts](../../../../backend/src/terminal/completion/event-service.ts)                                                                                           | 旁聊完成不能被解释为主任务完成，不能仅修首页显示                                           |
| 监督目标取 terminal/panel 的当前 thread；hook 带相同启动代际                                     | [target.ts](../../../../backend/src/task-supervision/target.ts)、[supervision hook](../../../../packages/agent-bridge/hooks/runweave-task-supervision.cjs)                 | 主、子同一 launch 不等于同一任务；不能让旁聊消费主任务监督或收到自动续接                   |
| 浮动草稿 key 为 apiBase + terminal + panel，没有子 thread 维度                                   | [use-floating-draft-controller.ts](../../../../frontend/src/components/terminal/input/use-floating-draft-controller.ts)                                                    | 原生切换后必须验证草稿和附件不串；不能只检查 TUI 自身草稿                                  |
| tmux 丢失时可用保存的 threadId 恢复                                                              | [launcher.ts](../../../../backend/src/terminal/runtime/launcher.ts)                                                                                                        | 恢复必须指向持久主 thread，不能保存临时旁聊作为恢复目标                                    |

**已实测：** 安装配置开放 `/side`；同一 terminal/panel/pane 可创建、继承父上下文、切换、关闭并再次创建；主任务运行时可进入旁聊且两边都完成。Runweave 的 `lastThreadId` 在关闭后仍指向子会话，管理门槛未通过。

**已补证：** 主/子 hook 原始载荷和真实桌面键盘编码链路；同一原生 App Server 的 fork、read、切换、unsubscribe / closed 时间线；终端 OSC 标题载荷。**尚未完成：** 全部并发交错下的完成/监督隔离、浮动输入与附件、重启恢复；依赖的 TUI 身份合同缺口见实施证据，不能把已完成核查写成已完成接入。

## 4. 行为合同

1. 创建、问题提交、权限、审批、忙碌时输入处理由原生 Codex 决定，不自建提示词替代品。入口使用 `/side`，别名 `/btw`；不可用原因按原生反馈显示。
2. 只保留原生允许的一个临时旁聊；主会话再次创建时遵循原生替换语义，不新增历史列表或恢复按钮。
3. 主／旁聊专用切换保留临时旁聊；关闭清理子任务并返回主会话。关闭不是 Stop 主任务。输入不为空、弹层、复制选区和自定义按键时遵循原生规则，不全局抢占 Ctrl+C。
4. 父任务的执行、审批和完成状态由 Codex 原生显示。Runweave 的持久恢复身份和主任务监督不能随显示切换而变成子 thread。
5. 原生旁聊不持久化，不保证 Codex 进程退出后恢复。仅浏览器重连且原进程仍在时，恢复已有终端画面，不新建或重放旁聊。
6. 原生权限继承不等于“只读”：明确修改请求按现有权限和审批执行。首期不另加权限模式或替代 Codex 审批弹层。
7. 主任务的新输出不会持续追加到已创建子上下文；用户未发送的主草稿不能作为旁聊消息提交。

[已评审原型](../README.md)是上述行为参考。最新终端复用方向下，原型已改为终端呈现并移除独立按钮；HTML 文本和隐藏计时器不能直接转成生产终端实现；真实正文与交互优先保留原生终端。不得为追求原型像素一致而另建聊天运行时。宿主可点击快捷入口只有在能验证目标与输入前提后才接入；否则先保留原生命令，不声称快捷入口已完成。

## 5. 分阶段任务与退出标准

### 阶段 0：原生能力与归属验证，先于产品改动

本轮结果：已启动当前源码隔离 Beta，补抓原始 hook 并复现主身份污染，完成独立 Ctrl+/ 编码修复。随后完成原生终端标题、同一 App Server RPC 和 TUI 调试记录源码核查；创建关系部分可取得，完整 TUI 显示/旁聊身份合同仍缺失，阶段 0 门槛未通过。这描述未打补丁的上游基线；后续已获准实现受管适配，进入身份、输入与管理接入验证。下列组合任务尚未全部完成，不整体勾选；旧安装版验证中的磁盘及界面控制阻塞已由隔离 Beta 消除，不能继续用作身份接入未完成的理由。

- [x] 依据 `toolkit:runweave-dev-session` 取得自有隔离运行环境；使用项目配置的真实 Codex 二进制。不得向用户当前工作终端插入 `/side` 或 Ctrl+C。
- [ ] 记录 terminal、panel、tmux pane、CLI PID、launch operation、主 thread、模型及权限模式；在自有临时目录建立已开始的主会话。
- [ ] 实际完成运行中 `/side 问题`、多轮追问、切回、返回旁聊、关闭、再次创建。采集 UI 与输入输出、原始 hook 和状态 API，给出事件时间线；不记录凭据或完整全局配置。
- [ ] 在父运行/子完成、父完成/子运行两种交错下，核对 current/last thread、完成 revision、监督目标、恢复目标、草稿及附件归属。
- [x] 核对原生是否提供可靠的父子关系与当前显示 thread 信号。真实载荷、来源文件、更新时机及失效条件已记录；核查结果为未满足完整接入合同，不代表该门槛通过。
- [x] 给出逐项 pass/fail/blocked：原生行为、主子身份、完成与监督隔离、输入隔离、恢复。结果见实施证据，不进入长期架构事实。

**退出标准：** 核心原生交互全部成立，并且管理风险已排除或有可验证、用户已批准的受管 Codex 提供的可信信号可修复，才能进入阶段 1。若缺少身份信号，停止新增入口与后台自动化接入，说明具体缺失字段/事件；仅允许上述受管适配补丁，不换成持久子终端、不另起服务绕过。若现状全部通过，后续仅做必要入口与文档，不为了“实现功能”制造代码。

### 阶段 1：最小终端兼容修复（只针对阶段 0 已证实的问题）

- [ ] 在 Terminal 领域内区分“持久主线程身份”“当前显示会话”“各线程运行事实”。原生切换不重写持久恢复目标；原生 `/new`、resume、更换 Agent 等真正主会话变更仍可更新主身份。
- [ ] 如需新增观测数据，写入 shared 合同，再接 hook bridge / Backend；不能在前端或通知层各自猜测父子关系。
- [ ] 子事件在修改主 thread、完成 revision、监督和通知之前完成角色归属。主任务仍运行时，子 Stop 不能把它投影为空闲；子完成不能触发主任务续接或主任务完成通知。
- [ ] 修复经过复现的浮动输入问题，复用现有输入锁、草稿控制器和附件交付流程。身份未知时保留草稿、不自动清空、不跨上下文发送；原生输入与已知主会话功能不得被一刀切禁用。
- [ ] 关闭子会话后清理其观测；普通后台迟到事件不得重建已关闭子状态。CLI 进程/launch 变化时旧代观测失效。Backend 不拥有原生子 thread 的独立终止权，不另发 SIGINT 杀主任务。

**退出标准：** 原生交互保持一致；主任务状态与恢复身份不受子 hook 污染；普通新会话、普通 Fork 和既有监督仍通过相关回归。

### 阶段 2：终端入口及交互验证

- [ ] 复用现有 `TerminalSurface`、xterm 和 WS 输出，保持项目、终端标签、tmux、工作区管理不变。首次只支持已验证的本地 Codex 能力范围。
- [ ] `/side` 与专用切换按键进入原生 TUI，不能把 `/side` 当普通业务 prompt 或通用后台任务。保留原生错误、审批和多轮回答，不新增消息存储。
- [ ] 如落地原型中的点击入口，通过现有目标核对及输入锁执行原生命令；发送前同时核对 panel、launch、当前上下文和草稿状态。不能用 Ctrl+U 清主草稿后强行启动；前提未知时聚焦终端，由用户使用原生入口。
- [x] Ctrl+C 只交给当前聚焦的原生终端，不增加全局关闭逻辑；已定位 xterm 缺失 Ctrl+/ 的旧式编码并补齐 `0x1f`，真实 Beta 键盘切换与关闭通过，未覆盖原生自定义键含义。旧 HTTP raw 注入失败与桌面 WS/PTY 输入不是同一路径，不能继续用其判定桌面按键失败；真实输入帧与焦点验证见实施证据。
- [ ] 窄窗、切终端、切连接、重连验证只使用真实页面；按终端已有资源归属处理宿主导航，不因 React 卸载就冒充执行了 Codex 内部的“导航到其他 thread”。

**退出标准：** 不新增第二份终端/进程，不自动重发用户问题，输入与审批目标正确；若点击入口无法满足草稿前提，不将其算入完成项。

### 阶段 3：验收与文档交付

- [ ] 执行下述独立 YAML 用例，先复现再修复，每例保留事实证据；不以原型 25 项断言代替产品验收。
- [ ] 更新 `docs/architecture/terminal-state.md` 的真实主/子身份合同，若 hook 合同变化则更新对应公共合同文档；只写已实现事实。
- [ ] 交付运行中的原生命令/切换/关闭截图、兼容性矩阵和未支持项，区别源码、构建、启动和 UI 证明。本计划不授权更新 Stable、安装手机、提交或合并 PR。

## 6. 文件范围

下面是按职责定位的候选修改点，不要求全部改动；无已复现缺陷的文件保持不动。

| 文件或新增候选                                                                                                                         | 职责                                                     |
| -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `frontend/src/components/terminal/surface/surface.tsx`、`use-emulator.ts`                                                              | 现有终端宿主、焦点和按键传递；禁止平行实现聊天渲染器     |
| `frontend/src/components/terminal/input/use-floating-draft-controller.ts`、`frontend/src/features/terminal/input/floating-composer.ts` | 处理经证实的上下文切换草稿边界                           |
| `backend/src/ws/terminal-input-handler.ts`、`backend/src/terminal/runtime/input-admission.ts`                                          | 沿用输入锁、目标与投递归属，不另开裸写通道               |
| `packages/agent-bridge/hooks/runweave-hook-payload.cjs`、`runweave-hook-bridge.cjs`、`runweave-task-supervision.cjs`                   | 可信角色信息归一与下游传播；同步公共资产，不手改分发副本 |
| `backend/src/terminal/application/agent-hook-processor.ts`                                                                             | 主子事件分类必须早于主线程元数据与状态写入               |
| `backend/src/terminal/runtime/codex-conversation-context.ts`（仅有可信信号时新增）                                                     | panel + launch 范围内的观测归属及失效；不是新线程管理器  |
| `packages/shared/src/terminal/codex-conversation-context.ts`（需要跨运行时传播时新增）                                                 | 纯 DTO 与新增可选观测合同，导出明确子路径                |
| `backend/src/terminal/completion/event-service.ts`、`backend/src/task-supervision/target.ts`、`service.ts`                             | 消费统一归属，保证主完成、主监督不会接受旁聊             |
| `backend/src/terminal/runtime/launcher.ts`                                                                                             | 持久主线程恢复回归，必要时只修复恢复目标选择             |
| `docs/architecture/terminal-state.md`                                                                                                  | 实现后的当前合同                                         |

现有 `agent-fork.ts`、语音 RPC 客户端、会话阅读面板不承担新增旁聊运行时；不预设修改它们。若跨到 App Server，先读其 AGENTS，并说明是哪个既有事件投影造成缺陷，再限制修改范围。

## 7. 接口、数据与异常边界

### 接口策略

原生命令走已有终端输入协议：`{type:"input", data:string}`；输出继续使用现有 snapshot/output。**首期不设计 `/sidechat/create`、`/sidechat/send`、历史查询或独立 WebSocket。** 点击入口若需要领域动作，复用已有认证、目标校验和输入 admission；其“已投递”不等于“原生创建成功”。

只有阶段 0 证明有可靠来源且现有协议不足时，才引入以下最小观测形状；字段由适配器从真实数据归一，不能宣称 Codex 已原样提供：

```ts
type CodexConversationContext = {
  terminalSessionId: string;
  panelId: string;
  executorGeneration: string;
  primaryThreadId: string;
  sideThreadId: string | null;
  displayedThreadId: string | null; // 未知保留 null，不猜为 primary
  revision: number; // 同一 executorGeneration 内单调递增
};
```

该 DTO 是终端观测，不是存储原生 thread 的容器。主/子运行事件仍按原生 thread + turn 身份去重；角色不明不得改写已知主身份。没有观察来源时不创建此 DTO、不伪造 revision。

### 错误、并发与兼容

- 已投递但未确认：保留原生现场与用户草稿，停止自动重发；重连只恢复终端，不自动再执行 `/side`。
- 真实 `/new` / resume 与旁聊子事件必须能区分。禁止简单“固定首次 thread 永不更新”或“一律忽略新的 thread”。
- 快速切换时用 panel + launch + 观测 revision 拒绝旧代写入；父、子并发状态不以最后一个 Stop 覆盖整个 pane。
- 子会话生命周期仍由 Codex 管理，Runweave 不把原生 ephemeral 数据写入自己的历史库。无数据库迁移；若阶段 0 发现持久主身份必须新增字段，先补充其序列化与旧记录回退合同再实施，不能静默改变原字段语义。
- 旧客户端和不支持 `/side` 的 Codex 保持原有终端功能，不自动升级 CLI；UI 能力未知时不宣称已启用。不能只依据语义版本比较判断能力可用。
- 回滚移除新增入口/适配，保留用户普通 terminal、tmux、主会话及工作区；不做全局清理。对于已打开的原生旁聊，用户仍可在原生 TUI 切回和关闭。

## 8. 验证与交付标准

独立验收合同：[codex-side-chat.testplan.yaml](../../../testing/terminal/codex-side-chat.testplan.yaml)。覆盖核心交互、身份、并发、权限、草稿、完成、监督、恢复和兼容。它是待执行合同，格式通过不等于产品通过。

实现阶段按实际改动执行：

```bash
pnpm --filter @runweave/shared typecheck
pnpm --filter @runweave/backend typecheck
pnpm --filter @runweave/backend lint
pnpm --filter @runweave/frontend typecheck
pnpm --filter @runweave/frontend lint
pnpm architecture:check
# 仅修改 agent-bridge 公共资产时执行这两项
pnpm agents:build
pnpm toolkit:verify-hooks
pnpm docs:check
pnpm testplan:validate docs/testing/terminal/codex-side-chat.testplan.yaml
```

以上命令退出码应为 0；若失败须区分新增问题与基线问题，不能用没有 tracked spec 的 `test:e2e` 代替验收。禁止新增单元测试或 TDD。Dev Session 生命周期遵循专属 skill；Web 交互使用 `toolkit:playwright-cli`，测试计划执行使用 `toolkit:run-test-cases`。用例仅操作自有 fixture，真实通知出口使用隔离收件端，不对外发送消息。

**完成条件：** 阶段 0 有可信的路径决策，所选路径的 required 用例全部取得真实证据，生产代码只包含已证实需要的兼容接入。若原生侧缺少身份能力，只能交付明确的阶段 0 阻塞结论，不宣称旁聊已完成，也不把未经授权的替代架构写成既定方案。
