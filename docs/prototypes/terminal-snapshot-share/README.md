# 终端快照分享原型

> 极简交互方案已于 2026-09-18 获用户认可，作为历史设计产物保留。Backend 与 Web 实现已加入，真实链路验收仍需单独取证；本目录仍是静态原型。
>
> 当前合同见[终端快照分享](../../cli/terminal-snapshot-share.md)，行为验收见[验收计划](../../testing/terminal/snapshot-share.testplan.yaml)。

## 打开

当前 worktree 的 Terminal 顶部 `…` → `Open Prototypes` →「终端快照分享 · Runweave」。也可在仓库根目录启动：

```bash
python3 -m http.server 6199 --bind 127.0.0.1 --directory docs/prototypes/terminal-snapshot-share
```

- [终端入口](./index.html)：选中 Pi 或 Shell 分屏，`…` →「分享终端快照」，直接复制链接；成功通知可打开快照。
- [Pi 快照](./snapshot.html) / [Shell 快照](./snapshot-shell.html)。
- [行范围示例](./snapshot.html#L25-L28)。
- [过期状态](./expired.html)。

## 当前方案：Agent 优先的极简 HTML

- 标题仅放在 `<title>`，正文区不重复标题。
- 页面只有完整正文和轻量行号；没有品牌栏、时间信息、卡片、搜索框、状态栏或复制按钮。
- 搜索、文本选择、复制、复制地址都使用浏览器原生能力；不实现自定义搜索或剪贴板交互。
- 点击行号选择单行，Shift 点击选择范围。淡黄色高亮，当前地址更新为 `#L25-L28`；复制浏览器地址即可引用。
- 文本拖选保持浏览器原生行为，不自动改动 URL。行范围高亮不裁剪正文，不限制其他行访问。
- 长行在窄屏自然折行，但逻辑行号不变。
- `snapshot.html` 和 `snapshot-shell.html` 初始响应就有全部文本与行号；不需要执行 JS 或请求额外接口。`snapshot.js` 仅负责行范围高亮及定位，`snapshot.css` 只负责基础可读性。
- 过期页只有标题和一句过期说明，没有历史正文。

上一版的复杂分享查看器（品牌头部、时间、内嵌搜索、复制工具栏、底部状态）已放弃。终端内的创建入口与反馈不变。

## 结合当前代码的落点

- `frontend/src/components/terminal/workspace/header.tsx`：原型保留现有 `More actions`，分享项位于 `Copy terminal output…` 附近；该文件已有感知当前 Panel 的输出读取路径。
- `frontend/src/components/terminal/workspace/worktree-rail.tsx`、`session/session-tab-strip.tsx`：终端原型沿用 worktree 侧栏与紧凑 session 标签；后一个路径相对于 `frontend/src/components/terminal/`。
- `frontend/src/components/terminal/markdown/line-reference.tsx`：参考行范围引用语义，不引入 Monaco 或现有复杂代码查看器。
- `backend/src/terminal/runtime/launcher.ts`、`backend/src/terminal/tmux/pane-service.ts`：后续捕获能力的考察点，本原型不调用真实捕获。
- `packages/shared/src/terminal/limits.ts`：历史有保留上限，不承诺恢复已清理内容或每一帧 TUI。

## 模拟范围与非目标

- `mock-state.json` 为工作区样例；两份 HTML 预置对应文本。更新样例时需同步 HTML。
- 产品核心：分享当前分屏的不可变快照、24 小时有效期、只读 HTML、行范围引用。
- 原型辅助：固定样例 URL、400ms 创建等待、`index.html?state=error` 创建失败、`index.html?clipboard=fail` 剪贴板失败。这些参数不出现在产品界面。
- 未实现随机 token、持久化、Backend 鉴权、真实到期、可达性或敏感数据治理。静态服务器仍能访问样例；`expired.html` 不证明服务端执行了到期限制。
- 未提供实时输出、终端输入、跨 Backend 托管、提前撤销、独立 Agent 文本 API。

## 验证记录

2026-09-18，通过仓库固定的 `pnpm exec playwright cli` 附着当前 Terminal Browser 的 `profile-1` 验证；未启动完整 Dev Session。

- 极简版：点击第 25 行、Shift 点击第 28 行，得到 `#L25-L28` 与 4 行高亮，刷新后恢复。
- 标题为「快照分享方案 · Pi」，正文 45 行；按钮、输入框、header、footer、h1 数量均为 0。
- 阻止 `snapshot.js` 加载后，仍能读取全部 45 行正文；390px 窄屏的文档宽度为 390px，高亮保持 4 行。
- `node --check`（两个 JS 文件）及 `pnpm docs:check` 通过。
- [桌面截图](./snapshot.png)与[窄屏截图](./mobile.png)已更新；[终端入口截图](./workspace.png)沿用未改动的入口设计。
- 本轮不再验证已删除的自定义搜索和复制按钮；浏览器原生查找面板不属于页面自定义功能。
- 仍需产品实现后验证真实捕获、真实到期、安全边界和大文本性能。截图出现过 CDP 超时，刷新后成功获取，不将失败当作通过。
