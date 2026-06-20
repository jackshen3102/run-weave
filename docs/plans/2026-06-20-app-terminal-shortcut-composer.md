# App 终端两行输入框与快捷键面板计划

## 背景

App 终端当前的底部输入区由 `app/src/components/TerminalCommandComposer.tsx` 实现，布局是单行：

- 图片按钮
- 语音按钮
- `IonTextarea` 输入框
- 发送/停止按钮

仓库里已经有 `app/src/components/TerminalShortcutBar.tsx`，包含 `Ctrl-C`、`Tab`、`Esc`、`↑`、`↓` 的原始控制序列按钮，但当前没有挂到 `AppTerminalPage` 的底部输入区里，也缺少本次确认场景需要的 `Enter`。

终端原始输入通道已经存在：`app/src/hooks/use-app-terminal-connection.ts` 返回 `sendInput(data)`，用于 `TerminalRenderer` 的 `onInput`，可直接发送方向键、回车、控制键等字节序列。文本命令提交则由 `app/src/hooks/use-app-terminal-actions.ts` 的 `handleSendCommand` 走 `sendTerminalInput`，并按 `line` / `codex_slash_command` 处理。

设计草图：

- `docs/plans/assets/2026-06-20-app-terminal-shortcut-bar-sketch.svg`

## 目标

把 App 终端底部输入区改成两行传统输入框形态，并支持可展开快捷键面板：

1. 默认态：
   - 第一行是完整输入框，不放任何按钮。
   - 第二行是操作区，包含图片、语音、快捷键入口、发送/停止。
2. 展开态：
   - 快捷键条显示在输入框上方。
   - 输入框仍独占一行。
   - 操作区仍在输入框下方。
3. 快捷键按钮发送原始终端输入：
   - `Ctrl-C` -> `\x03`
   - `Tab` -> `\t`
   - `Esc` -> `\x1b`
   - `↑` -> `\x1b[A`
   - `↓` -> `\x1b[B`
   - `Enter` -> `\r`

## 非目标

- 不新增后端接口。
- 不改 Web 端终端输入体验。
- 不引入单元测试、Vitest、Node test 或 coverage 体系。
- 不做自动识别“终端正在等待确认”的智能检测。
- 不把快捷键抽到 `packages/common`，除非同一个变更里确认 Web 与 App 都有真实调用方。
- 不改变图片上传、语音转写、slash command、停止命令的业务逻辑。

## 当前代码差异

### `TerminalCommandComposer`

文件：`app/src/components/TerminalCommandComposer.tsx`

当前问题：

- 输入框和操作按钮在同一行，手机空间紧张。
- 组件只接收 `onSendInput(data)`，这个 prop 实际用于文本命令提交，不适合直接发送 `↑/↓/Enter` 这类原始控制键。
- 组件内没有快捷键展开状态。

目标变化：

- 增加 `shortcutOpen` 状态。
- 增加一个独立 prop，例如 `onSendShortcutInput: (data: string) => void`，只用于原始控制序列。
- JSX 改成三段顺序：
  - 展开时的 `TerminalShortcutBar`
  - 输入框行
  - 操作按钮行

### `TerminalShortcutBar`

文件：`app/src/components/TerminalShortcutBar.tsx`

当前问题：

- 已有快捷键列表但缺 `Enter`。
- 当前使用 `IonButton`，高密度 terminal composer 操作区更适合使用原生 `<button type="button">` 配合 CSS 控制尺寸与触摸态。
- 没有 disabled 态，也没有和 composer 展开状态联动。

目标变化：

- 增加 `Enter`。
- 接收 `disabled?: boolean`。
- 用原生 button 渲染快捷键项。
- 保持数据层简单：组件只负责把 `shortcut.data` 传给 `onSendInput`。

### `AppTerminalPage`

文件：`app/src/pages/AppTerminalPage.tsx`

当前状态：

- `useAppTerminalConnection` 已经返回原始 `sendInput`。
- `useAppTerminalActions` 返回 `handleSendCommand`，用于命令提交。
- `TerminalCommandComposer` 当前只接入 `handleSendCommand`。

目标变化：

- 给 `TerminalCommandComposer` 新增传参：
  - `onSendInput={handleSendCommand}` 保持文本命令提交。
  - `onSendShortcutInput={(data) => { sendInput(data); }}` 发送快捷键原始输入。

### CSS

文件：`app/src/main.css`

当前状态：

- `.terminal-composer__input-row` 是单行 grid。
- `.terminal-shortcut-bar` 已有基础样式，但当前是五列按钮样式，未覆盖新增 `Enter` 与两行布局。

目标变化：

- 新增或调整：
  - `.terminal-composer__shortcut-row`
  - `.terminal-composer__input-row`
  - `.terminal-composer__actions-row`
  - `.terminal-composer__shortcut-toggle`
- 输入框一行宽度稳定，按钮不挤占输入框。
- 展开态快捷键条在输入框上方，横向排列；小屏不足时允许横向滚动或压缩为稳定宽度按钮，不造成文字重叠。

## 实施步骤

### 1. 接入快捷键条

修改 `app/src/components/TerminalShortcutBar.tsx`：

- 增加 `Enter` 快捷键。
- 增加 `disabled` prop。
- 改用原生 button。
- 保持 `aria-label="Terminal shortcuts"`。

验收：

- `Ctrl-C`、`Tab`、`Esc`、`↑`、`↓`、`Enter` 都在组件中可见。
- 点击按钮时调用 `onSendInput(shortcut.data)`。

### 2. 重构 composer 为两行布局

修改 `app/src/components/TerminalCommandComposer.tsx`：

- import `TerminalShortcutBar`。
- 增加 `shortcutOpen` state。
- 增加 prop：

```ts
onSendShortcutInput: (data: string) => void;
```

- 展开态结构：

```tsx
{shortcutOpen ? (
  <TerminalShortcutBar
    disabled={disabled}
    onSendInput={onSendShortcutInput}
  />
) : null}
<div className="terminal-composer__input-row">...</div>
<div className="terminal-composer__actions-row">...</div>
```

- 输入框行只放 `IonTextarea`。
- 操作行放：
  - 图片按钮
  - 语音按钮
  - 快捷键 toggle
  - 发送/停止按钮

约束：

- 不从 `react` 引入 `useCallback`。
- 需要稳定事件时继续使用现有模式或 `ahooks` 的 `useMemoizedFn`。
- 图片、语音、发送、停止现有逻辑不改。

验收：

- 默认态输入框独占一行。
- 点击快捷键入口后，快捷键条显示在输入框上方。
- 再次点击快捷键入口后收起。

### 3. 区分文本命令与原始控制键输入

修改 `app/src/pages/AppTerminalPage.tsx`：

- `TerminalCommandComposer` 保留：

```tsx
onSendInput = { handleSendCommand };
```

- 新增：

```tsx
onSendShortcutInput={(data) => {
  sendInput(data);
}}
```

约束：

- 快捷键不得走 `handleSendCommand`，否则方向键/回车会被当作命令文本提交。
- 普通文本命令不得改为直接走 websocket 原始输入，否则会绕过 `line` / `codex_slash_command` 的现有行为。

验收：

- 文本输入点击发送仍按现有命令提交路径工作。
- 快捷键点击只调用原始 `sendInput` 路径。

### 4. 更新样式

修改 `app/src/main.css`：

- `.terminal-composer` 维持底部容器与安全区现有行为。
- `.terminal-composer__input-row` 改为只承载输入框。
- 新增 `.terminal-composer__actions-row`，按参考图风格组织底部操作行。
- `.terminal-shortcut-bar` 放在输入框上方，优先使用一行横向排列。
- 按钮尺寸稳定，避免文字撑开布局。

建议视觉规则：

- 输入框使用圆角胶囊形态，宽度占满一行。
- 操作区按钮尺寸保持 40-44px 触摸目标。
- “快捷键”入口可以使用文字 + 下拉箭头，展开态切换为上收箭头。
- 发送/停止按钮保留现有主操作强调。

验收：

- 竖屏手机宽度下，输入框不被按钮挤压。
- 快捷键条、输入框、操作行不重叠。
- 展开态不会遮挡底部 `TerminalDetailTabBar`。

## 验证方式

### 静态检查

执行：

```bash
pnpm --filter @runweave/app typecheck
pnpm lint
```

预期：

- TypeScript 无新增错误。
- Lint 无新增错误。

如果 `pnpm lint` 因仓库既有问题失败，需要记录失败文件；只修复本次改动引入的问题，不顺手改无关文件。

### 浏览器/App 行为验证

涉及浏览器操作验证时，必须使用 `$playwright-cli`，不得使用其它浏览器自动化方案。

建议验证路径：

1. 打开 App 终端详情页。
2. 确认默认态：
   - 输入框独占一行。
   - 操作按钮在下一行。
   - 快捷键条不可见。
3. 点击快捷键入口。
4. 确认展开态：
   - 快捷键条在输入框上方。
   - 输入框仍独占一行。
   - 操作按钮仍在输入框下方。
5. 在等待确认的终端场景中点击：
   - `↑`
   - `↓`
   - `Enter`
6. 确认终端选择项能移动并确认。

失败判断：

- 快捷键走了文本命令提交路径。
- 输入框与按钮重叠。
- 输入框不再能正常提交普通命令。
- 展开态导致底部 tab 被遮挡或布局跳动过大。

## 风险点

- `Enter` 的原始序列应使用 `\r`。如果实际终端运行时对回车处理不一致，优先用 Playwright 在真实终端里验证，而不是改后端协议。
- 输入框改为两行后会增加底部高度，可能压缩终端可视区域；需要确保展开/收起时 renderer resize 正常触发。
- 快捷键按钮如果误走 `handleSendCommand`，会破坏方向键与确认流，这是本需求的核心回归风险。
- `TerminalShortcutBar` 未来可能被 Web 复用，但本次不提前迁移到 `packages/common`。

## 验收标准

- 计划草图对应的默认态和展开态都在 App 终端页实现。
- 默认态：输入框一整行，操作按钮一整行。
- 展开态：快捷键条位于输入框上方。
- `Ctrl-C`、`Tab`、`Esc`、`↑`、`↓`、`Enter` 可点击并发送原始控制序列。
- 普通文本命令、图片、语音、停止命令保持原行为。
- 通过 `pnpm --filter @runweave/app typecheck`。
- 浏览器/App 行为验证使用 `$playwright-cli` 完成并记录结果。
