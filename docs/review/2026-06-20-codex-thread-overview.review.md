# Codex Thread Overview 代码评审

- 评审对象：当前 live worktree diff，以及未跟踪的 `.tmp/`、`backend/src/terminal/codex-thread-snapshot.ts`。
- 评审类型：代码评审，只读；未修改被评审源码、配置、测试或文档。
- 结论：当前不建议进入 `human_verify`。至少需要先处理 P1 问题，P2 建议合入前修正或明确迁移策略。

## 发现

- **P1 严重：未跟踪 `.tmp` 文件包含完整 Codex thread 内容，存在误提交与信息泄露风险**。`.tmp/codex-thread-019ede62-36e3-7671-a182-9e42d217551a.json:7` 含用户原始问题摘要，`:15` 暴露本机 Codex session 路径，`:22-25` 暴露 git sha、branch 和 origin URL；`git check-ignore` 对该文件无匹配，`git status` 显示 `?? .tmp/`。修复方向：不要把 thread dump 留在仓库未跟踪区；删除本地临时文件或把明确的本地 dump 目录加入忽略规则，并确保不随本次 MR 提交。

- **P1 严重：App 首页 overview 会被 Codex app-server 读取阻塞，最坏可卡 20 秒**。`backend/src/routes/app-home-overview.ts:206-209` 对每个 session 在响应 `/api/app/home/overview` 前 `await readCodexThreadOverviewSnapshot`，而 `backend/src/routes/app-home-overview.ts:163-164` 会同步等待 `readCodexThreadSnapshot`；该 RPC 走 `backend/src/voice/codex-app-server-client.ts:93-97` 的 20 秒超时。只要有一个带 `threadId` 的 Codex session 且 app-server 启动慢、无响应或方法异常，App 首页就不能快速返回，影响首屏和刷新。修复方向：overview 只读缓存的 `session.preview` / `terminalState`，把 thread refresh 放后台并设置更短的非阻塞超时；或者对单个 session 失败/超时做快速降级，不能让第三方/本地 app-server RPC 成为首页硬依赖。

- **P2 一般：`threadId` / `preview` 生命周期没有跟随会话复用清理，旧 Codex 摘要会污染后续非 Codex 行**。`backend/src/routes/terminal-state.ts:156-178` 只在 Codex hook 带新 `threadId` 时写入并在新 SessionStart 时清空 preview；但 `backend/src/terminal/manager.ts:389-417` 的 `updateSessionLaunch` 和 `:468-491` 的 preview 写入逻辑没有在命令切到 shell、fallback 或其它 agent 时清理旧 `threadId/preview`。同时 `backend/src/routes/app-home-overview.ts:57-65` 对没有 snapshot 的 session 直接复用 `session.preview`，`app/src/components/TerminalRow.tsx:24` 会展示到首页副标题。修复方向：把 `threadId/preview` 归属到当前 Codex launch/thread 生命周期；在 launch 变更为非 Codex、activeCommand 退出 Codex、tmux 丢失回 shell时清理，或至少在 overview 展示前校验当前 session 仍属于同一个 Codex thread。

- **P2 一般：Feishu 配置路径从 `~/.browser-viewer` 切到 `~/.runweave` 没有迁移或 fallback，会让已有通知静默失效**。`electron/resources/hooks/feishu_stop_notify.sh:5-6` 默认只读 `~/.runweave/feishu_notify.env` 和写 `~/.runweave/feishu_notify.log`；`electron/src/hooks/hook-installer.ts:588-606` 只负责复制脚本到新 hooks 目录，没有迁移旧 `~/.browser-viewer/feishu_notify.env`，文档也直接改成新路径。已有用户的 webhook 配置如果仍在旧路径，脚本会按既有行为静默退出，表现为升级后飞书不再通知。修复方向：提供一次性迁移、旧路径 fallback，或在 release/文档中明确要求用户移动 env；更稳妥是脚本优先读新路径、缺失时兼容旧路径并记录迁移提示。

## 验证摘要

- `git diff --check`：通过。
- `pnpm --filter @runweave/shared --filter @runweave/backend --filter @runweave/electron --filter @runweave/app typecheck`：通过。
- 未执行浏览器验证；本次是代码评审，没有进行浏览器操作。
- 未运行 `pnpm lint`，残余风险是 lint 规则可能仍会发现格式或静态规则问题。
