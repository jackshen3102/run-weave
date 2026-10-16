# 终端旁聊交互原型

历史原型，更新于 2026-10-15，Runweave 源码基线 `00336bea`。本版替代此前的持久旁聊方案，只对齐已核实的 **Codex CLI `rust-v0.160.1` `/side`**。尚无证据证明 Codex 桌面端内部采用完全相同的实现；不将 CLI 源码当作桌面端复刻依据。

本页描述历史静态原型与行为方案；当前产品接入已在隔离 Beta 完成，见 [受管版本验收记录](implementation-evidence/managed-acceptance.md)。原型本身不连接产品。本版用 HTML 近似终端文本布局，未嵌入 xterm、连接 PTY 或启动 Codex；不是实际 Codex 运行截图或逐像素复刻。本轮不涉及 Diff。

## 运行与查看

```bash
python3 -m http.server 6198 --bind 127.0.0.1 --directory docs/prototypes/terminal-side-chat
```

打开 <http://127.0.0.1:6198/>。需要 HTTP 服务加载 JSON。

[当前画面截图](./prototype-preview.png)。默认从主会话开始；`?scenario=conversation` 展示一段预设旁聊。页面不保存旁聊，刷新重置演示数据；这只是原型生命周期，不代表真实产品刷新页面就必须销毁服务端线程。

## 操作

1. 点击终端输入区，输入 `/side 问题` 并按 Enter；也可只输入 `/side`，再输入问题。`/btw` 是别名。
2. 在终端输入区按 `Ctrl+/`，在主会话与旁聊之间切换；临时旁聊和未发送草稿保留。
3. 旁聊输入为空时按 `Ctrl+C` 关闭旁聊；再次执行 `/side` 创建新的临时旁聊。
4. Runweave 顶部终端标签切换只改变查看对象，原终端中的旁聊仍保留。

没有独立创建、切换、关闭或发送按钮。Enter 提交，Shift+Enter 换行；快捷键只在终端输入获得焦点时生效。真实 Codex 用户自定义按键以实际配置为准。HTML 使用浏览器规范化键盘事件；早期 HTTP raw 探针与桌面键盘路径不同；后续已修复 xterm 的 Ctrl+/ 编码并完成真实 Beta 键盘切换和关闭验证，见受管版本验收记录。

## 行为方案与证据

以固定版本源码为依据，避免把新增设计称作 Codex 行为：

- [side.rs](https://github.com/openai/codex/blob/rust-v0.160.1/codex-rs/tui/src/app/side.rs)：旁聊状态、边界指令、创建、切换、关闭。
- [app_server_session.rs](https://github.com/openai/codex/blob/rust-v0.160.1/codex-rs/tui/src/app_server_session.rs#L877)：`fork_side_thread` 的实际请求路径。
- [input.rs](https://github.com/openai/codex/blob/rust-v0.160.1/codex-rs/tui/src/app/input.rs#L531)、[keymap.rs](https://github.com/openai/codex/blob/rust-v0.160.1/codex-rs/tui/src/keymap.rs)：关闭与切换快捷键。
- [官方命令文档](https://learn.chatgpt.com/docs/developer-commands#start-a-side-chat-with-side)：`/side`、`/btw`、内联问题、审查模式限制。

| 核心行为   | 本版采用的行为                                                                                                         | 依据                                                                                                                                                                                     |
| ---------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 创建       | `/side` 或 `/btw` 立即创建临时 fork；可附带问题。不是首次发送才 fork                                                   | `handle_start_side`、官方命令文档                                                                                                                                                        |
| 上下文     | fork 继承父会话历史；界面从旁聊边界开始，不重复展示历史。父会话之后的消息不持续同步到子上下文                          | `install_side_thread_snapshot`；[运行中 fork 测试](https://github.com/openai/codex/blob/rust-v0.160.1/codex-rs/app-server/tests/suite/v2/thread_fork.rs#L1789)，只读源码，未执行上游测试 |
| 独立任务   | 继承历史仅供参考，不能继续旧任务、旧工具调用或审批；只响应边界之后的新指令                                             | `SIDE_BOUNDARY_PROMPT`、`SIDE_DEVELOPER_INSTRUCTIONS`                                                                                                                                    |
| 权限       | 继承当前配置与权限。默认回答和非修改性探索；用户在旁聊中明确要求修改时，可在现有权限范围内做最小修改。禁止使用子 Agent | `side_fork_config`、边界指令、`ForkPermissionMode::InheritSaved`。这是指令约束，不是强制只读沙箱                                                                                         |
| 单个旁聊   | 不提供历史列表、重命名或嵌套旁聊。从主会话再次执行 `/side` 会清理旧旁聊再创建新的                                      | `SIDE_RENAME_BLOCK_MESSAGE`、`side_start_block_message`、`handle_start_side`                                                                                                             |
| 切换       | `Ctrl+/` 在主会话与旁聊之间切换，保留当前临时旁聊及草稿，运行中的回答继续                                              | `toggle_side_conversation`，直接调用 `select_agent_thread`，不调用 discard                                                                                                               |
| 关闭       | 旁聊输入为空且没有弹层时，`Ctrl+C` 返回父会话并丢弃旁聊；关闭时打断子任务并取消订阅，不打断父任务                      | `maybe_return_from_side`、`select_agent_thread_and_discard_side`、`discard_side_thread_in_background`                                                                                    |
| 导航       | Codex 内部导航到其他 thread 时丢弃；专用切换除外。此原型不模拟该内部导航，宿主终端标签不触发丢弃                       | `side_thread_to_discard_after_switch`                                                                                                                                                    |
| 父会话状态 | 旁聊里显示主任务状态变化，包括需要输入、需要审批、失败、中断、关闭和完成                                               | `SideParentStatus`、`SideParentStatusChange`、`sync_side_thread_ui`                                                                                                                      |
| 创建失败   | 回到原界面，保留内联问题供用户修改或重新提交；没有自定义的历史恢复流程                                                 | `restore_side_user_message`、`side_start_error_message`                                                                                                                                  |
| 不可用条件 | 会话尚未开始、审查模式、旁聊内部不创建新的旁聊；真实实现还需遵守权限配置更新期间的阻挡                                 | 官方文档、`handle_start_side`                                                                                                                                                            |

界面保留 Runweave 的项目、worktree 与终端标签外壳，内容区采用等宽终端正文、行首标记、终端输入和原生状态提示。原型不再呈现自建聊天卡片、单独的发送框或操作按钮。底部 `Side from main thread`、父状态与切换/关闭提示依据 `sync_side_thread_ui`；输入提示文案及短对话中输入区跟随正文的位置已按真实 0.160.1 终端校正；字体和间距是 HTML 近似，不作为 Codex 精确外观依据。

主要流程：主任务运行 → `/side 问题` → 独立回答 → 切回主会话再切回旁聊，或关闭并丢弃。旁聊回答不回填、不自动发送到主会话。

本版删除：多个旁聊与历史选择、持久化恢复、强制只读、快照时间卡片、新进展计数、放入主草稿、关闭后仍保留记录、自定义创建结果核对流程。不得据旧版截图或验证记录恢复这些设计。

## 实现机制与本项目差距

后续实施进展见 [源码 Beta 验证与按键修复](./implementation-evidence/README.md)：已修复 Ctrl+/ 传递，主子身份现采用已获授权的独立受管 Codex 适配，正在进行真实验收。

[已批准的历史实施计划](implementation-evidence/approved-plan.md) 已执行；当前合同与结果见受管版本验收记录。以下调用链解释 Codex 的内部机制，以及自行托管聊天时会遇到的缺口，不再表示 Runweave 必须另建旁聊运行时。当前原型只展示终端内行为；早期未适配版本的管理兼容性缺口见 [历史原生验证记录](./native-verification.md)；后续受管适配已补齐对应身份和输入合同。

对齐上游的调用顺序：

1. 复制父会话配置、模型、推理强度和服务档位，设置 `ephemeral=true`，追加旁聊 developer instructions。继承权限，不另造只读策略。
2. 调用 `fork_side_thread` 对应的 `thread/fork`：`last_turn_id=None`、`before_turn_id=None`、`ForkPresentation::SideConversation`、`ForkPermissionMode::InheritSaved`、`ForkConfigSource::Session`。上游传入 `ForkGoalContinuation::StartIfIdle`，本方案不自行添加清除目标或延迟目标策略。
3. 从 fork 回执取得子 thread ID，保存父子关系，初始化子会话显示状态；向子 thread 注入隐藏的 side boundary。初始化失败走清理与问题恢复。
4. 切到子会话，有内联问题时再提交新 turn；继承历史不作为活跃任务重新执行。
5. 维持父、子事件路由与父会话状态提示。专用切换只改变展示；关闭／Codex 内部其他 thread 导航则打断并取消订阅子会话、清理本地状态。真实清理失败仍需按上游区分同步失败保留与后台失败记录，不可伪造成功。

| 本项目现状                                                                                                                                                                                                          | 本版接入方向与待验证项                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| [终端输入](../../../frontend/src/components/terminal/surface/use-emulator.ts) 已通过现有 WS/PTY 链路传递按键                                                                                                        | 原生 `/side` 复用现有终端；核对命令、快捷键、输入锁与焦点，无需另建聊天发送接口       |
| [hook 处理](../../../backend/src/terminal/application/agent-hook-processor.ts) 维护终端 thread；[浮动草稿](../../../frontend/src/components/terminal/input/use-floating-draft-controller.ts) 按 terminal/panel 保存 | 必须真实验证父子身份、监督、通知、恢复与草稿隔离；HTML 的独立状态不能证明这些链路成立 |
| [普通 Fork](../../../backend/src/terminal/application/agent-fork.ts) 创建持久 thread 与新终端                                                                                                                       | 保留原有语义；不改为空闲保护之外的 ephemeral 旁聊运行时                               |

Codex 自己承担 fork、子线程、审批、回答与清理，Runweave 继续承担原终端管理。未验证项以实施计划为准，不能从原型推断“主子身份已接通”。

## 原型辅助分类

| 辅助项                             | 用途与限制                                                         |
| ---------------------------------- | ------------------------------------------------------------------ |
| JSON 样例与计时器                  | 固定文本逐段输出，不理解任意问题，不执行模型、文件操作、工具或审批 |
| `?scenario=conversation`           | 预置一段旁聊便于查看与截图；默认入口无旁聊                         |
| `?scenario=create-error`           | 首次创建失败，之后可由用户重新提交；无自动重试                     |
| `?scenario=not-started` / `review` | 演示不可创建状态；并非完整新会话或审查功能                         |
| 父会话事件                         | 定时展示需要审批、完成，仅验证提示；不会实际审批或完成主任务       |
| 页面内内存状态                     | 演示单个 ephemeral 生命周期；无浏览器存储、后台服务或跨设备恢复    |

各宿主终端分别保留页面内的模拟状态，后台回复计时器仍继续；这不是新建可管理旁聊列表。

未模拟完整 CLI 编辑器、忙碌中 steer/排队、弹层、审批处理、失败清理的网络重试。生成中保留输入但暂禁发送仅是本原型覆盖边界，不据此规定真实 Codex 的忙碌输入行为。Ctrl+C 只复现旁聊空输入、无选中文本时的关闭路径；其他组合不代表完整 CLI 快捷键规则。

## 验证记录

通过仓库固定版本 `pnpm exec playwright cli` 的独立 Chrome 重新通过 26 项交互检查，并补充通过 4 项布局检查（主/子输入提示、输入区跟随正文、多行输入可见）：

- 无独立操作按钮，主会话终端标题，旁聊不重复展示父历史。
- 主子草稿隔离与切换保留，非空输入不关闭，非终端焦点不抢占关闭键。
- 宿主终端草稿隔离，切换宿主标签后原旁聊保留。
- 独立回答，切回主会话期间继续回答，底部父状态更新。
- 空输入关闭不改主草稿，`/btw` 内联问题，关闭后旧回复不污染新旁聊。
- 禁止嵌套，主会话重新 `/side` 替换旧旁聊，创建失败保留问题并可重新创建。
- 审查模式和未开始会话的限制，输入 HTML 不执行，1024 / 390 宽度无横向溢出及窄窗键盘切回。

控制台 0 errors / 0 warnings；截图为 1440 × 960 独立 Chrome 中的 HTML 原型，已实际查看。`node --check app.js` 和 `pnpm docs:check` 通过。未新增单元测试或修改产品代码。

旧版 25 项断言包含已移除的按钮和不同导航假设，不再作为本版依据。本版检查仅证明 HTML 模拟交互，不证明原生 Codex、PTY、hook 身份、监督、权限或恢复兼容；真实原生验证另见 [证据记录](./native-verification.md)，不可与 HTML 检查混算为产品通过。
