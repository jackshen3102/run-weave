# Runweave Beta 自举通道代码复审（round 2）

## 结论

`case_12` 通过。round 1 的 4 个 P1 均已修复，本轮未发现未修复的 P0/P1。

当前仍有 1 个不阻断的 P2：Beta backend 若在重启后更换动态端口，已经存在的 tmux shell 不会刷新旧 `RUNWEAVE_BASE_URL`；新建 terminal 不受影响。该问题不阻断本轮 code review，但建议在真实连续更新验收中覆盖端口变化场景。

## 已解决的 P1

### 1. Beta CLI 配置与认证已独立

Beta 在 backend 启动前固定 `RUNWEAVE_CONFIG_FILE` 到 Beta userData，并清除 ambient access token；backend 就绪后使用 Beta packaged credentials 自动 refresh/login，原子写入权限为 `0600` 的独立 profile。tmux 与 direct PTY 新建路径均显式传递 Beta config 和 channel。

- 定位：`electron/src/main.ts:92`、`electron/src/main.ts:572`、`electron/src/main.ts:628`、`electron/src/main.ts:1007`、`backend/src/terminal/runtime-launcher.ts:221`
- 实证：CLI 解析结果为 Beta config 路径和动态 Beta backend URL。

### 2. dirty worktree 已建立部署内容快照

更新器会为 dirty/staged/untracked 候选文件记录类型、权限和 SHA-256 内容摘要，并在成功后写入 `worktreeSnapshot`。下一轮只把新增、修改、删除或权限变化的文件交给组件 planner。

- 定位：`scripts/runweave-update.mjs:271`、`scripts/runweave-update.mjs:307`、`scripts/runweave-update.mjs:325`、`scripts/runweave-update.mjs:685`、`scripts/runweave-update.mjs:819`、`scripts/runweave-update-core.mjs:117`
- 实证：相同快照返回空变更，内容变化后文件重新进入 planner；17 条 planner cases 全部通过。

### 3. 正式更新入口已固定 Stable 边界

共享 updater 默认固定 `stable`；只有 Beta wrapper 设置私有 `RUNWEAVE_UPDATE_TARGET=beta` 并传入完整 Beta 路径。来自 Beta terminal 的正式命令会清理 Beta-scoped App、runtime、App Server、CLI 和 state 环境。

- 定位：`scripts/runweave-update.mjs:21`、`scripts/runweave-update.mjs:37`、`scripts/runweave-update.mjs:635`、`scripts/runweave-beta.mjs:283`
- 实证：注入完整 Beta terminal 环境执行正式 dry-run，仍输出 Stable channel、Stable App/runtime/App Server/state。

### 4. Stable App Server 更新顺序已恢复

共享 updater 先完成 Desktop Runtime/App，再执行 App Server update，恢复原有 Stable 失败边界。Beta App Server 切换后由 wrapper 只重启 Beta，再等待 Desktop/backend/CDP/App Server 健康。

- 定位：`scripts/runweave-update.mjs:737`、`scripts/runweave-update.mjs:783`、`scripts/runweave-beta.mjs:569`

## Remaining P2

### 已存在的 tmux pane 在 backend 动态端口变化后保留旧 CLI 地址

tmux 环境只在 `!hasSession` 创建新 session 时写入；backend 重启复用既有 tmux session 时不会更新 shell 进程环境。CLI 又优先采用 `RUNWEAVE_BASE_URL`，因此旧 env 会覆盖已刷新 profile 中的新地址。正常重启复用相同端口时不触发，新建 terminal 也不受影响。

- 定位：`backend/src/terminal/runtime-launcher.ts:203`、`packages/runweave-cli/src/config/profile-store.ts:148`
- 修复方向：不要让可变 backend URL 固化在长期存活的 shell env，或提供能够在 backend 端口切换后刷新既有 pane 路由的机制。

## 验证

- 通过：Electron、frontend、backend、CLI、shared typecheck。
- 通过：`pnpm lint`。
- 通过：`pnpm runweave:update:test-cases`（17 cases）。
- 通过：`pnpm runweave:beta:verify`。
- 通过：两个 updater 脚本 `node --check` 与 `git diff --check`。
- 通过：Beta CLI 配置解析、dirty snapshot 过滤、Beta terminal 环境下 Stable dry-run 三项定向语义检查。
- 说明：整文件 Prettier check 会命中 `backend/src/terminal/runtime-launcher.ts` 中未被本轮修改的既有格式差异（99、321 行附近）；本轮新增的 4 行不在 formatter diff 中，因此未作为本次 finding。

本轮未执行 RWB-001～RWB-011 的 Desktop/Playwright 行为验收，该范围仍由 `behavior_verify` worker 负责。
