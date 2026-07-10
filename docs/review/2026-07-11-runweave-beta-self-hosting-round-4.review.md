# Runweave Beta 自举通道代码复审（round 4）

## 结论

`case_12` 通过。round 3 暴露的两个行为阻断根因已修复，本轮未发现未修复的 P0/P1。

本结论是代码评审结论，不替代 RWB-001 的真实桌面与 Playwright 重跑；本机 `beta:status` 仍记录上一轮失败状态，后续应由 `behavior_verify` 基于新构建重新验收。

## Round 4 已解决的 P1

### 1. Beta 首次安装不再早于 App Server 启动

共享 updater 仅在显式 Beta target 且 App Server 需要更新时延迟 Desktop 启动。完整 App 会先安装但不打开，Runtime 更新会先安装但不重启；App Server 安装并重启成功后，才启动或重启 Beta Desktop。Stable 仍保持 Desktop 成功后再更新 App Server 的原失败边界。

- 定位：`scripts/runweave-update.mjs:583`、`scripts/runweave-update.mjs:740`、`scripts/runweave-update.mjs:790`、`scripts/runweave-update.mjs:796`
- 结果：首次安装时 Beta backend 不会在 Beta App Server 尚未存在时启动并弹出缺失警告；App Server 失败时也不会留下已启动的新 Beta Desktop。

### 2. Beta status 改用可连接的 Electron 主窗口 CDP

Beta Electron 在 ready 前启用只监听 `127.0.0.1:9335` 的主窗口 remote debugging，desktop status 不再把 Terminal Browser scoped proxy 当作验收端点。status 同时要求监听 PID 属于当前 Beta Desktop 且 `/json/list` 至少存在一个带 websocket URL 的 page target。

- 定位：`electron/src/main.ts:91`、`electron/src/main.ts:96`、`electron/src/main.ts:478`、`scripts/runweave-beta.mjs:162`、`scripts/runweave-beta.mjs:191`、`scripts/runweave-beta.mjs:252`
- 结果：避免把无 page target 的 Terminal Browser proxy 判为 Beta 主窗口 CDP，也避免误连其他进程或 Stable。

## Round 2 P1 回归复核

- Beta CLI 仍使用独立 config 和自动认证，新 terminal 显式继承 Beta config/channel。
- dirty worktree 的内容快照过滤仍在，17 条 planner cases 通过。
- Beta terminal 环境下执行正式 updater 仍固定 Stable App/runtime/App Server/state。
- Stable App Server 更新顺序仍未被 round 4 的 Beta 延迟逻辑改变。

## Remaining P2

### 1. 既有 tmux pane 在 backend 动态端口变化后仍保留旧 CLI 地址

tmux env 仅在新 session 创建时写入；backend 重启复用既有 tmux session 时不会刷新 shell 环境。CLI 又优先采用 `RUNWEAVE_BASE_URL`，因此端口变化时旧 env 会覆盖独立 profile 中的新地址。正常复用同一端口和新建 terminal 不受影响。

- 定位：`backend/src/terminal/runtime-launcher.ts:203`、`packages/runweave-cli/src/config/profile-store.ts:148`

### 2. Beta 主窗口 CDP 固定使用 9335，端口冲突时没有动态降级

当前机器 9335 未被占用，且 status 会用 PID ownership 防止误判；但如果其他进程先占用 9335，Beta 仍会启动而 CDP 无法达到健康，最终等待 45 秒并回滚。更稳妥的长期方案是启动前选择空闲端口并把实际 endpoint 写入 status。

- 定位：`electron/src/main.ts:91`、`scripts/runweave-beta.mjs:162`

## 验证

- 通过：Electron、frontend、backend、CLI、shared typecheck。
- 通过：`pnpm lint`。
- 通过：`pnpm runweave:update:test-cases`（17 cases）。
- 通过：`pnpm runweave:beta:verify`。
- 通过：两个 updater 脚本 `node --check` 与 `git diff --check`。
- 通过：Beta terminal 环境下 Stable dry-run 仍全部指向 Stable。
- 通过：已生成 Electron bundle 包含 Beta 主窗口 remote-debugging 配置；本机 9335 当前无监听冲突。

未执行：新的完整 Beta 安装、Computer Use 与 Playwright 行为验收；该范围由下一轮 `behavior_verify` 执行。
