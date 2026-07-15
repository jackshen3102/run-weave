# Terminal IME 输入测试用例

本文档验证 Web Terminal 在真实 Codex TUI 与普通 shell 中处理输入法 composition 时，只把用户最终提交的文本发送到 terminal WebSocket。验证必须使用 `$toolkit:playwright-cli` 操作真实页面并记录浏览器发出的 `TerminalClientMessage(type="input")`；macOS 输入法端到端用例还必须使用 `$computer-use` 产生真实键盘与候选提交事件。`typecheck` / `lint` 不能替代行为证据。

## 范围

覆盖：

- Desktop 与窄窗口 `clientMode=mobile` 两条 Web Terminal 输入路径。
- 中文输入法的拼音预编辑、候选提交、浏览器重复 commit 事件。
- 快速连续提交相同候选、不同候选和普通 ASCII 输入。
- Codex TUI 与普通 shell 的原始 xterm 输入。

不覆盖：

- Ionic App 的 `@runweave/terminal-renderer`，它不使用本文件对应的 `TerminalSurface` 输入实现。
- 操作系统候选词的排序正确性；IME-009 只使用当前 macOS 拼音输入法实际返回的首选候选验证端到端输入链路。
- terminal WebSocket 断线重连与 pending input 队列；该行为由连接层单独验收，与 composition 去重无关。
- 鉴权与越权；本次没有新增接口或权限边界。

## 前提事实

- Web Terminal 的 xterm 实例位于 `frontend/src/components/terminal/use-terminal-emulator.ts`。
- Desktop 原始输入由 `terminal.onData(data)` 进入 `sendTerminalInput(data)`。
- Mobile 兼容路径监听 xterm helper textarea 的 `beforeinput`，只应在 xterm 没有产生对应 `onData` 时补发已提交输入。
- 输入法预编辑阶段的 `InputEvent.inputType="insertCompositionText"`、`isComposing=true` 不代表用户已提交文本，不能写入 terminal WebSocket。
- 一次 composition 在部分浏览器中会同时出现 `compositionend` 与随后 `insertText`，两者只能形成一个 terminal input。
- 两次独立的 `compositionstart → compositionend` 即使文本相同且间隔小于 250ms，也代表两次合法输入，不能被时间窗口误吞。
- 仓库不新增 Playwright spec 或单元测试文件；协议边界通过 `$toolkit:playwright-cli run-code` 在真实 Codex/shell 页面派发浏览器原生 composition/input 事件，操作系统边界通过 `$computer-use` 在 macOS 拼音输入源下逐键输入，两者都由 Playwright 捕获 WebSocket input frame。

## 输入等价类与时序边界

| 维度               | 等价类 / 边界                               | 预期                                      |
| ------------------ | ------------------------------------------- | ----------------------------------------- |
| Client mode        | desktop / mobile                            | 两者 composition 语义一致                 |
| 输入阶段           | preedit / commit / 普通输入                 | preedit 为 0 帧；commit 与普通输入各 1 次 |
| 更新间隔           | 同 tick / 40ms（大于 mobile fallback 20ms） | 两种时序都不能泄漏 preedit                |
| 候选内容           | ASCII 拼音 / CJK 最终文本                   | 拼音不发送；最终文本发送                  |
| 连续 composition   | 相同文本 / 不同文本；间隔 80ms              | 每个独立 composition 各发送一次           |
| 浏览器 commit 形态 | compositionend + insertText                 | 合并为一次，不双写                        |

40ms 的预编辑间隔是必测边界。把全部事件同步派发后再等待，会让 20ms mobile fallback 因后续 xterm `onData` 而取消，无法复现真实用户逐键输入。

## 必跑命令

任一失败即停止：

```bash
pnpm --filter ./frontend typecheck
pnpm --filter ./frontend lint
git diff --check
```

浏览器环境：

```bash
pnpm dev
```

## 用例

### IME-001 Desktop 拼音预编辑只在候选提交后发送最终文本

Given：

- 打开真实 Codex TUI terminal，URL 使用 `clientMode=desktop`。
- 已捕获该页面 terminal WebSocket 的 input frame。

When：

- 在 `.xterm-helper-textarea` 依次派发 `compositionstart`。
- 以 40ms 间隔派发累计的 `j → ji → jia → jian → jianyi`，每步包含 `compositionupdate` 与 `insertCompositionText(isComposing=true)`。
- 最后派发候选提交 `compositionend("建议")` 与 `insertText("建议")`。

Then：

- commit 前 input frame 为 `[]`。
- commit 后 input frame 精确为 `["建议"]`。

失败判断：

- 任一拼音预编辑片段进入 WebSocket。
- `建议` 缺失或出现两次。

### IME-002 Mobile 拼音预编辑只在候选提交后发送最终文本

Given：

- 打开真实 Codex TUI terminal，URL 使用 `clientMode=mobile`。
- 其它前置与 IME-001 相同。

When：

- 执行 IME-001 相同的 40ms 预编辑与候选提交序列。

Then：

- commit 前 input frame 为 `[]`。
- commit 后 input frame 精确为 `["建议"]`。

失败判断：

- 出现 `j + ji + jia + jian + jianyi` 累计双写。
- Mobile fallback 与 xterm commit 同时发送最终文本。

### IME-003 单次 composition 的重复 commit 事件只发送一次

Given：

- Desktop 和 Mobile 各准备一个真实 terminal 页面。

When：

- 派发一次 `compositionstart/update/end("中文")`。
- 紧接着派发浏览器 `beforeinput/input(inputType="insertText", data="中文")`。

Then：

- 两种 client mode 的 input frame 都精确为 `["中文"]`。

失败判断：

- 收到 `["中文", "中文"]` 或 0 帧。

### IME-004 快速连续提交相同候选不得误吞第二次输入

Given：

- 真实 terminal 页面已捕获 input frame。

When：

- 完整提交一次 composition `"中"`。
- 等待 80ms，再从新的 `compositionstart` 完整提交第二次 `"中"`。

Then：

- input frame 精确为 `["中", "中"]`。

失败判断：

- 只有一个 `"中"`，说明基于内容与时间窗口的去重误吞合法 composition。
- 出现三个及以上 `"中"`。

### IME-005 快速连续提交不同候选各发送一次

Given：

- 与 IME-004 相同。

When：

- 依次完整提交 `"中文"` 与 `"建议"`，间隔 80ms。

Then：

- input frame 精确为 `["中文", "建议"]`。

失败判断：

- 任一候选缺失、乱序或重复。

### IME-006 Mobile 普通 ASCII beforeinput fallback 仍发送一次

Given：

- 打开 `clientMode=mobile` 的普通 shell terminal。
- 本次操作不派发 xterm `onData` 对应键盘事件，只派发 textarea `beforeinput/input`。

When：

- 派发 `inputType="insertText"`、`data="abc"`、`isComposing=false`。
- 等待 40ms。

Then：

- input frame 精确为 `["abc"]`。

失败判断：

- 修复 composition 泄漏时连普通 mobile fallback 一并禁用。
- `abc` 被发送两次。

### IME-007 Desktop 普通键盘输入不受 composition 去重影响

Given：

- 打开 `clientMode=desktop` 的普通 shell terminal。

When：

- 使用 `$toolkit:playwright-cli` 聚焦 `Terminal emulator` 并输入 `ime_ascii_probe`，不按 Enter。

Then：

- WebSocket input frame 按顺序拼接后精确等于 `ime_ascii_probe`。
- terminal 可见输入行只出现一份 `ime_ascii_probe`。

失败判断：

- 字符缺失、重复或顺序变化。

### IME-008 新 composition 必须重置上一轮去重状态

Given：

- 已完成一次 `"中"` composition，且浏览器刚产生过同轮重复 commit 事件。

When：

- 在 250ms 内派发新的 `compositionstart`，提交相同的 `"中"`。

Then：

- 新一轮 `"中"` 仍发送一次；两轮合计 `["中", "中"]`。

失败判断：

- 新 `compositionstart` 后仍沿用上一轮已消费标记。

### IME-009 macOS 拼音输入法在真实 Codex TUI 中端到端只提交候选

Given：

- 使用 Runweave Electron 桌面端中的真实 Web Terminal 页面，自动窄窗口宽度为 700px，不传 `clientMode` 覆盖参数。
- terminal 内运行真实 Codex TUI。
- macOS 已启用 ABC 与简体拼音输入源；使用 `$computer-use` 切换到简体拼音并聚焦 xterm 输入框。
- 使用 `$toolkit:playwright-cli` 捕获 composition 事件和 terminal WebSocket input frame。

When：

- 通过真实键盘逐键输入 `j → i → a → n → y → i`，不使用脚本派发 DOM 事件。
- 在候选栏出现后按空格提交首选候选 `建议`。

Then：

- 提交前可观察到累计的 `insertCompositionText(isComposing=true)`，但 input frame 精确为 `[]`。
- 提交后 input frame 精确为 `["建议"]`。
- Codex 当前输入行只显示一份 `建议`，且 composition view 已退出 active 状态。
- 验证结束后恢复原输入源并删除临时 project/session。

失败判断：

- 拼音预编辑的任一片段进入 WebSocket。
- `建议` 未发送或发送多次。
- 只执行合成 DOM 事件，没有真实 macOS 输入法与候选栏证据。

## 覆盖矩阵

| 风险                             | 覆盖用例                  |
| -------------------------------- | ------------------------- |
| Desktop composition 主路径       | IME-001、IME-003、IME-007 |
| Mobile 20ms fallback 预编辑泄漏  | IME-002、IME-006          |
| 单轮浏览器重复 commit            | IME-003                   |
| 跨 composition 误去重            | IME-004、IME-005、IME-008 |
| 真实逐键时序而非同步假事件       | IME-001、IME-002          |
| 普通输入兼容                     | IME-006、IME-007          |
| macOS 拼音输入源真实键盘与候选栏 | IME-009                   |

## 验收通过标准

- 必跑命令全部通过。
- IME-001 至 IME-009 全部在真实 Web Terminal 页面通过。
- IME-001 至 IME-005 至少有一轮以真实 Codex TUI 为承载页面。
- IME-009 必须使用真实 macOS 拼音输入源，不能用合成 composition 事件替代。
- 任何预编辑拼音片段进入 WebSocket、单轮最终文本重复、或独立 composition 被吞，都判定整体失败。
