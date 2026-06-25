# Browser 注释交互逆向记录

时间：2026-06-25

## 结论

- `computer-use` 不能直接操作 `Codex.app`，工具返回：`Computer Use is not allowed to use the app 'com.openai.codex' for safety reasons.`
- 已使用 `computer-use` 覆盖 Runweave Browser 注释的可操作链路，并保存文字记录。
- 本次源码改动聚焦两点：缩小新建评论输入框；新建输入框改为按点击坐标定位，并在视口边界自动 clamp / 上翻。

## 覆盖场景

- 进入 Browser 注释模式：工具栏从 `Add browser comments` 切换为 `Stop browser comments`，提交按钮处于 disabled。
- 点击页面内容后出现评论输入框：包含选项按钮、文本输入框、发送按钮。
- 输入文字后发送按钮启用。
- 打开选项菜单：菜单包含 `发送 ↵` 和 `添加 ⌘↵`。
- 使用添加动作保存为 marker：页面出现编号 `1`，工具栏评论计数变为 `1`。
- 点击 marker 进入编辑态：展示删除、取消、保存入口。
- 编辑态取消：marker 保留。
- 右下角边界点击：输入框在空间不足时上翻，未溢出窗口。
- `Escape`：收起未保存的新建输入框，保留已有 marker。
- 退出注释模式：点击 `Stop browser comments`，未点击 `Submit browser comments`，避免测试内容发送给 agent。

## 记录形态

本记录保留 `computer-use` 覆盖到的交互状态和源码映射，不提交二进制截图。

## 源码映射

- 主要文件：`electron/src/terminal-browser-annotation.ts`
- 输入框尺寸：`560px / 64px` 缩到 `420px / 52px`，输入高度从 `40px` 缩到 `32px`，发送按钮从 `44px` 缩到 `36px`。
- 新建评论定位：从目标 DOM 元素矩形定位，改成使用点击点 `{ clientX, clientY }` 定位。
- 边界处理：新增左侧 clamp，并在下方空间不足时把输入框放到点击点上方。

## 验证

- `pnpm --filter @runweave/electron typecheck`
- `pnpm --filter @runweave/electron lint`
- `git diff --check -- electron/src/terminal-browser-annotation.ts`
- `playwright-cli run-code --filename=.playwright-cli/runweave-annotation-layout-check.js`
- `computer-use` 实机覆盖上述交互链路并保存文字记录。
