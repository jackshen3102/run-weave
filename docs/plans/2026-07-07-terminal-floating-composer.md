# Terminal Floating Composer 落地计划

## 目标

在真实 Web Terminal 中落地 `docs/prototypes/terminal-floating-composer/` 验证过的浮动输入能力：当用户在支持的 TUI Agent 界面中向上滚动查看历史内容时，显示一个紧凑的浮动 Composer，允许继续粘贴、编辑和发送输入；回到底部后恢复原 TUI 输入体验，并保持两种输入入口的草稿内容同步。

本计划只覆盖 Web desktop terminal。Ionic App、mobile terminal、Electron 原生 BrowserView、后端 CLI 控制面不在本次实现范围内。

配套验收用例：`docs/testing/terminal-floating-composer-test-cases.md`。

## 原型资产

- 原型目录：`docs/prototypes/terminal-floating-composer/`
- 原型启动命令：`python3 -m http.server 6188 --directory docs/prototypes/terminal-floating-composer`
- 最终截图：`docs/prototypes/terminal-floating-composer/prototype-preview.png`
- 真实产品落点：`frontend/src/components/terminal/terminal-surface.tsx`、`frontend/src/components/terminal/terminal-surface-layout.tsx`、`frontend/src/components/terminal/use-terminal-emulator.ts`

## 必须遵循原型的交互与 UI

1. **只显示一个输入入口**
   - 底部 TUI 可见且在底部时，不显示浮动 Composer。
   - 离底达到阈值且满足 TUI gate 时，显示浮动 Composer；此时不要再引导用户操作底部 TUI 输入行。

2. **浮动 Composer 样式**
   - 使用紧凑底部输入栏，不使用大块表单卡片。
   - 输入区占主要宽度，右侧只保留发送 icon 按钮。
   - 发送按钮使用 `lucide-react` 的 `Send` icon，不使用 `Send` 文字按钮。
   - Composer 内不展示 `away from bottom`、内部状态标签、调试状态或额外按钮。

3. **回到底部按钮**
   - 按钮位于 Composer 上方水平居中。
   - 回到底部按钮与 Composer 同步显示、同步隐藏。
   - 非 TUI 场景继续使用现有右下角 `Scroll terminal to bottom` 行为，不受本能力影响。

4. **触发与隐藏**
   - 阈值采用真实 xterm bottom offset：`baseY - viewportY`。
   - 初始建议阈值为 `8` 行。
   - 需要 hysteresis，避免 8 行附近来回滚动造成 Composer 闪烁；建议显示阈值 `>= 8`，隐藏阈值 `<= 2`。
   - 滚动中不得整页重渲染；只在跨显示/隐藏阈值时更新浮层显隐。

5. **草稿双向同步**
   - 底部 TUI 输入时维护同一个 Web 侧 `draft`。
   - 离底显示浮动 Composer 时，Composer 初始值必须等于当前 `draft`。
   - 在 Composer 中编辑后，回到底部时必须把最新 `draft` 同步回真实 TUI 输入行。
   - 发送 icon 发送的内容必须是当前最新 `draft`。

## 原型中只是 demo 的内容

以下内容只用于原型演示，不进入产品实现：

- `Bottom / Scrolled / Tmux` 分段控制器。
- `Seed text` 按钮。
- `Runtime state` 指标面板。
- 事件流面板。
- 用可编辑 DOM input 模拟真实 TUI 输入行。
- 用本地 mock state 模拟 `bottomOffsetRows`、`tmuxScrollbackActive`、terminal 输出和发送结果。

真实实现必须从 xterm、terminal session state、terminal metadata 和真实 input/output 流获取状态。

## 新增硬需求：只在 TUI Agent 界面中出现

浮动 Composer 只在支持的 TUI Agent 界面中出现，例如 Codex、Trae / Trae CLI / Traex、以及可通过 `activeCommand` 明确识别的 Claude CLI 这类全屏或类全屏 TUI。普通 shell、普通命令输出、非 supported TUI 的 scrollback 保持当前体验。

首期 gate 规则：

1. `clientMode === "desktop"`。
2. `terminalRef.current?.buffer.active.type === "alternate"`，确认当前是 TUI/alternate screen。
3. 当前 session 的 Agent 语义命中 supported agent：
   - `terminalState.agent` 属于 `codex | trae | traex | traecli`，且状态为 `agent_starting | agent_idle | agent_running`；或
   - `activeCommand` basename 属于 `codex | trae | traex | traecli | claude`。
4. session status 是 running，terminal connection 正常。
5. 当前没有打开 terminal search toolbar，避免两个输入焦点竞争。

不满足任一条件时：

- 不显示浮动 Composer。
- 继续保留现有右下角 Scroll to bottom 按钮逻辑。
- 不启用 draft mirror / replay 逻辑。

`TerminalAgentKind` 当前不包含 `claude`，所以 Claude CLI 首期只能走 `activeCommand` 命中；如果实际 session 无法稳定提供 Claude 的 active command，本次不补协议字段，改为二期先补状态来源和验收。后续如果要支持 opencode、vim、less 等其它 TUI，应先补 Agent/TUI allowlist 和真实行为验证，不在本次顺手扩展。

## 当前代码事实

- `TerminalSurface` 已维护：
  - `terminalAtBottom`
  - `hasNewOutputBelow`
  - `tmuxScrollbackActive`
  - `terminalRef`
  - `sendTerminalInput`
  - `handleScrollToBottom`
- `packages/common/src/terminal/terminal-scroll.ts` 已提供 `getTerminalBottomState(...)`，但当前 `TerminalSurface` 只接收 boolean bottom state，没有保存 `bottomOffsetRows`。
- `TerminalSurfaceLayout` 当前右下角只渲染现有 `ArrowDownToLine` scroll button。
- `useTerminalEmulator` 当前把 `terminal.onData(data)` 直接转发给 `sendTerminalInput(data)`，没有维护当前输入草稿。
- `useTerminalEmulator` 可通过 `terminal.buffer.active.type` 判断是否 alternate screen；App 端 `app/src/lib/app-terminal-touch-behavior.ts` 已用这个事实处理 TUI 触摸滚动。
- `TerminalWorkspaceShell` 持有 `terminalStateBySessionId`，但当前传给 `TerminalSurface` 的 props 不包含 `terminalState`。
- `TerminalSessionListItem` 已包含 `activeCommand` 和可选 `terminalState`；`TerminalAgentKind` 当前为 `codex | trae | traex | traecli`，completion/hook source 中已有 Claude 来源，但还不是 `TerminalState.agent`。
- `TerminalClientMessage` 只有 raw input、resize、signal、request-status；本方案首期不新增 WebSocket 消息类型。

## 设计方案

### 1. 新增前端 helper

新增文件：

- `frontend/src/features/terminal/floating-composer.ts`

职责：

- 判断 supported agent command。
- 判断当前是否可显示 floating composer。
- 维护 draft reducer 需要的输入分类。
- 生成 TUI draft replay 序列。

建议导出：

```ts
export const TERMINAL_FLOATING_COMPOSER_SHOW_ROWS = 8;
export const TERMINAL_FLOATING_COMPOSER_HIDE_ROWS = 2;

export function isSupportedFloatingComposerAgent(params: {
  activeCommand: string | null;
  terminalState?: TerminalState;
}): boolean;

export function shouldEnableFloatingComposer(params: {
  clientMode: ClientMode;
  activeCommand: string | null;
  terminalState?: TerminalState;
  bufferType: "normal" | "alternate" | undefined;
  searchOpen: boolean;
  sessionRunning: boolean;
}): boolean;

export function applyTerminalDraftInput(
  draft: string,
  data: string,
): { draft: string; supported: boolean };

export function buildReplaceTuiDraftInput(draft: string): string;
```

`buildReplaceTuiDraftInput(draft)` 首期使用保守序列：

- `\x15`，即 Ctrl+U，清空当前 TUI 输入行；
- `draft` 原文。

发送时使用：

- 若 Composer draft 和 last synced TUI draft 不一致，先发送 `buildReplaceTuiDraftInput(draft)`；
- 再发送 `\r` 或沿用现有 Enter 发送路径。

风险控制：

- 只对 supported Agent TUI 启用。
- 若某个 TUI 验证不支持 Ctrl+U 清行，必须从 allowlist 移除或增加该 TUI 专用 replay adapter。
- 不对普通 shell 使用 Ctrl+U replay。

### 2. 扩展 `TerminalSurface` props

修改 `frontend/src/components/terminal/terminal-surface.tsx`：

新增 props：

```ts
activeCommand?: string | null;
terminalState?: TerminalState;
sessionStatus?: "running" | "exited";
```

从 `TerminalWorkspaceShell` 传入：

- `activeCommand={session.activeCommand}`
- `terminalState={terminalStateBySessionId[session.terminalSessionId] ?? session.terminalState}`
- `sessionStatus={session.status}`

### 3. 扩展 bottom state

当前 `handleBottomStateChange(isAtBottom)` 只接收 boolean。需要改为接收完整 bottom state：

```ts
type TerminalBottomState = {
  isAtBottom: boolean;
  bottomOffsetRows: number;
};
```

`useTerminalEmulator` 内部已有 terminal 实例，应使用 `getTerminalBottomState(terminal)` 发出完整状态。

兼容要求：

- `terminalAtBottom` 仍保留。
- 新增 `bottomOffsetRows` state。
- `hasNewOutputBelow` 清理逻辑仍以 `isAtBottom` 为准。

### 4. Draft mirror

在 `TerminalSurface` 中新增状态：

```ts
const [floatingDraft, setFloatingDraft] = useState("");
const lastSyncedTuiDraftRef = useRef("");
const floatingDraftDirtyRef = useRef(false);
const draftMirrorSupportedRef = useRef(true);
```

在 `useTerminalEmulator` 的 `terminal.onData(data)` 路径中，在转发前通知 `TerminalSurface`：

```ts
onUserInputData?.(data);
sendTerminalInput(data);
```

`TerminalSurface` 用 `applyTerminalDraftInput(...)` 更新 `floatingDraft`：

- 普通可打印字符：append。
- Backspace：删除最后一个 code point。
- Ctrl+U：清空。
- Enter：清空 mirror draft，并视为已发送。
- Shift+Enter 发送 `\n` 时 append newline。
- 无法识别或会导致高风险误同步的 escape sequence：`supported=false`，本次 TUI session 暂停 floating composer，直到用户回到底部或 session metadata 变化。

注意：

- draft mirror 只在 `shouldEnableFloatingComposer(...) === true` 时工作。
- 不要记录 `isTerminalAutoResponse(data)`。
- IME duplicate guard 保持现有逻辑，不要绕过 `sendTerminalInput`。

### 5. Floating Composer 显示状态

新增 derived state：

```ts
const floatingComposerEligible = shouldEnableFloatingComposer(...);
const floatingComposerVisible =
  active &&
  floatingComposerEligible &&
  !terminalAtBottom &&
  bottomOffsetRows >= show/hide threshold &&
  draftMirrorSupportedRef.current;
```

实现 hysteresis：

- 当前不可见时，`bottomOffsetRows >= 8` 才显示。
- 当前可见时，`bottomOffsetRows > 2` 保持显示。
- `terminalAtBottom=true` 时立即隐藏。

如果 `searchOpen=true`、`clientMode="mobile"`、session exited、buffer 不在 alternate screen、agent 不在 allowlist，则立即隐藏 Composer。

### 6. Floating Composer UI

在 `TerminalSurfaceLayout` 中新增 props：

```ts
floatingComposerVisible: boolean;
floatingComposerDraft: string;
onFloatingComposerDraftChange: (value: string) => void;
onFloatingComposerSend: () => void;
onFloatingComposerScrollToBottom: () => void;
```

UI 要求：

- 保持原型最终样式：底部紧凑输入栏、右侧 `Send` icon、上方居中的回到底部按钮。
- 使用 `lucide-react` 的 `Send` 和现有 `ArrowDownToLine`。
- 不展示状态文案，不展示 debug panel。
- 回到底部按钮与 Composer 同步显示隐藏。
- Composer textarea `Enter` 发送，`Shift+Enter` 换行。
- `Escape` 不发送；建议只 blur composer 并 focus terminal，避免意外丢 draft。

非 TUI 时现有右下角 scroll button 保持当前样式和位置。

### 7. Composer -> TUI replay

新增流程：

1. 用户在 Composer 中修改 draft：
   - 更新 `floatingDraft`；
   - 标记 `floatingDraftDirtyRef.current = true`。
2. 用户点击回到底部：
   - 如果 dirty，发送 `buildReplaceTuiDraftInput(floatingDraft)`；
   - 更新 `lastSyncedTuiDraftRef.current = floatingDraft`；
   - dirty=false；
   - 调用现有 `handleScrollToBottom()`。
3. 用户点击发送 icon 或按 Enter：
   - 如果 dirty，先发送 replace 序列；
   - 再发送 Enter；
   - 清空 draft；
   - dirty=false；
   - 调用现有回到底部逻辑。

失败降级：

- 如果 WebSocket 未连接或 `sendInput` 不可用，Composer 保留 draft，不清空，显示现有错误区域；不得伪装发送成功。
- 如果检测到 unsupported input sequence，隐藏 Composer 并保留现有 terminal 行为；不发送 replay。

### 8. 普通 shell 保持不变

普通 shell 行为必须保持：

- 向上滚动时不显示 Floating Composer。
- 现有右下角 Scroll to bottom 按钮继续按 `!terminalAtBottom || hasNewOutputBelow || tmuxScrollbackActive` 显示。
- xterm onData 仍直接发送 raw data，不启用 draft mirror/replay。

## 文件范围

### 新增

- `frontend/src/features/terminal/floating-composer.ts`
  - TUI gate、draft reducer、replay sequence。

### 修改

- `frontend/src/components/terminal/terminal-surface.tsx`
  - 接收 terminal state / active command。
  - 保存 `bottomOffsetRows`。
  - 保存 floating draft、dirty、mirror support。
  - 实现显示 gate、send、scroll-to-bottom replay。

- `frontend/src/components/terminal/terminal-surface-layout.tsx`
  - 渲染 floating composer。
  - 使用 `Send` icon。
  - 将 TUI 场景的 scroll-to-bottom button 移到 composer 上方居中。
  - 保留非 TUI 场景现有右下角 scroll button。

- `frontend/src/components/terminal/use-terminal-emulator.ts`
  - bottom state callback 改为完整 `TerminalBottomState`。
  - 暴露 user input data callback 给 `TerminalSurface`。
  - 提供 buffer type / alternate screen 变化的低频通知，或在 scroll/render 时由 `TerminalSurface` 读取 `terminalRef.current?.buffer.active.type`。

- `frontend/src/components/terminal/terminal-workspace-shell.tsx`
  - 将 `activeCommand`、`terminalState`、`session.status` 传给 `TerminalSurface`。

- `docs/testing/terminal-floating-composer-test-cases.md`
  - 本计划配套用例。

### 不修改

- 不新增后端 API。
- 不改 `TerminalClientMessage` / `TerminalServerMessage`。
- 不改 terminal session storage。
- 不改 App terminal。
- 不新增单元测试文件。

## 验收标准

1. 普通 shell 向上滚动时，不显示 floating composer，现有右下角 scroll button 行为保持不变。
2. Codex、Trae-family 或 `activeCommand` 可识别的 Claude CLI TUI 处于 alternate screen 且离底超过阈值时，显示 floating composer。
3. Composer 内只包含 textarea 和发送 icon，不包含状态文案或 demo 控件。
4. 回到底部按钮位于 Composer 上方居中，并与 Composer 同步显示隐藏。
5. 用户在底部 TUI 输入的 draft，滚动离底后出现在 Composer 中。
6. 用户在 Composer 中编辑 draft，回到底部后真实 TUI 输入行显示最新内容。
7. 用户在 Composer 中按 Enter 或点击发送 icon，只发送最新 draft 一次，不重复、不丢字。
8. `Shift+Enter` 在 Composer 中换行，不发送。
9. 打开 terminal search 时不显示 Composer。
10. unsupported input sequence 不导致误回写；降级为隐藏 Composer 并保留 xterm 原始输入行为。

## 验证方式

命令门禁：

```bash
pnpm --filter ./frontend typecheck
pnpm --filter ./frontend lint
git diff --check
```

浏览器验收必须使用 `$playwright-cli`，按 `docs/testing/terminal-floating-composer-test-cases.md` 执行。静态检查不能替代浏览器行为验证。

## 风险与处理

### R1：真实 TUI 当前输入行不可直接读取

风险：xterm/readline/TUI 没有通用 API 暴露当前编辑行。

处理：首期不尝试从 TUI 读取内部状态；只 mirror Runweave Web 发出的用户输入。外部 tmux attach、CLI send、程序自动补全导致的输入行变化不承诺同步。

### R2：Ctrl+U replay 不是所有 TUI 都支持

风险：某些 TUI 不支持 Ctrl+U 清行，或清行语义不同。

处理：只在 allowlist TUI 中启用；每个 supported TUI 必须有 Playwright 验收。验证失败则从 allowlist 移除，不做泛化。

### R3：draft reducer 无法覆盖所有编辑键

风险：复杂光标移动、历史选择、补全、组合键可能让 mirror draft 和 TUI 实际行不一致。

处理：首期 reducer 只支持明确安全的输入：可打印字符、Backspace、Ctrl+U、Enter、Shift+Enter、多行 paste。遇到方向键、历史导航、未知 escape sequence 时暂停 floating composer，避免误同步。

### R4：滚动性能回归

风险：滚动时 React state 高频更新导致卡顿。

处理：只在跨阈值时更新显隐；bottom offset 可存 ref 或低频 state，不在每个 wheel tick 重渲染 layout。

### R5：搜索栏、移动端、图片粘贴冲突

风险：多个输入 surface 同时抢焦点。

处理：searchOpen、mobile mode、图片 paste 流程优先；Composer 不在这些场景显示。图片粘贴仍走现有 xterm helper textarea 路径。

## 实施顺序

1. 新增 `floating-composer.ts` helper，覆盖 gate、draft reducer、replay input。
2. 修改 `useTerminalEmulator`，把完整 bottom state 和 user input data 暴露给 `TerminalSurface`。
3. 修改 `TerminalWorkspaceShell` 和 `TerminalSurface` props，接入 `terminalState`、`activeCommand`、`sessionStatus`。
4. 在 `TerminalSurface` 中实现 eligible / visible / draft / dirty / replay 状态机。
5. 修改 `TerminalSurfaceLayout` 渲染 TUI floating composer，并保留非 TUI scroll button。
6. 运行 typecheck/lint/diff-check。
7. 按 `docs/testing/terminal-floating-composer-test-cases.md` 用 `$playwright-cli` 验收真实 Web Terminal。
