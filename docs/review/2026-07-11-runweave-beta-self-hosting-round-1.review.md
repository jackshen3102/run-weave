# Runweave Beta 自举通道代码复审（round 1）

## 结论

`case_12` 不通过。当前仍有 4 个未修复 P1；未发现 P0。

当前实现文件的修改时间早于上一份 code review outbox，code pane `%17` 也停留在首次交付状态，因此工作区中没有可识别的“上一轮评审后修复”增量。本次没有沿用旧 verdict，而是重新检查了当前 diff、运行链路和只读命令证据。

## P1 发现

### 1. Beta terminal 的 `rw` 地址已指向 Beta，但认证配置仍复用 Stable 全局 profile

Beta backend 在监听后会正确设置 `RUNWEAVE_BASE_URL` / `RUNWEAVE_BACKEND_PORT`，terminal launcher 也会传递它们；上一轮“地址回退 5001”的表述不准确。但 Beta 只设置了 `BROWSER_PROFILE_DIR`，没有设置独立 `RUNWEAVE_CONFIG_FILE` 或 `RUNWEAVE_ACCESS_TOKEN`。CLI 仍从 `~/.runweave/config.json` 读取 active profile 和 access token，因此 Beta terminal 会拿 Stable token 请求 Beta backend；重新登录又会改写全局 CLI profile。这样无法满足 Beta terminal 的 CLI 独立可用与不污染 Stable 的要求。

- 定位：`electron/src/main.ts:92`、`backend/src/index.ts:658`、`backend/src/terminal/runtime-launcher.ts:210`、`packages/runweave-cli/src/config/profile-store.ts:28`、`packages/runweave-cli/src/client/cli-base-url.ts:25`
- 实证：给 CLI 同时提供 Beta `BROWSER_PROFILE_DIR` 和 Beta `RUNWEAVE_BASE_URL` 时，地址为 Beta，但配置文件仍解析为 `~/.runweave/config.json`。
- 修复方向：给 Beta terminal 注入通道专属 CLI config/token；不得覆盖 Stable active profile。

### 2. 脏 worktree 没有“上次已部署内容”快照，后续组件选择持续失真

更新 state 只保存 `gitHead` 和 `gitDirty`。下一轮计算变更时仍无条件合并当前全部未提交、已暂存和未跟踪文件，因此上轮已经部署、但仍留在脏 worktree 中的 Electron/Beta 文件会继续触发完整 App。RWB-003 的 runtime-only 更新和 RWB-011 的连续多组件迭代无法成立。

- 定位：`scripts/runweave-update.mjs:236`、`scripts/runweave-update.mjs:695`、`scripts/runweave-beta.mjs:256`
- 实证：用 `hasPreviousState=true` 模拟已有部署基线，当前相同脏 worktree 仍解析为 `mode=app`，native files 仍包含 `electron/src/main.ts`、`electron/electron-builder.beta.yml`、`scripts/runweave-beta.mjs` 等。
- 修复方向：在 Beta state 保存可比较的 worktree 快照/内容摘要，并按上次部署快照到当前内容计算增量。

### 3. Beta terminal 环境会把正式 `runweave:update` 变成 Stable/Beta 混合更新

`runweave-update.mjs` 从环境继承 `RUNWEAVE_DESKTOP_CHANNEL` 和 `RUNWEAVE_APP_SERVER_HOME`，但 App 路径仍默认 `/Applications/Runweave.app`。Beta Electron 把这两个变量传给 backend 和 terminal；因此在 Beta terminal 直接执行正式命令会以 `channel=beta` 构建/更新 Stable App，同时把 App Server 目标指向 Beta home。正式更新入口不再具有稳定的 Stable 语义。

- 定位：`electron/src/main.ts:92`、`scripts/runweave-update.mjs:19`、`scripts/runweave-update.mjs:547`
- 实证：`RUNWEAVE_DESKTOP_CHANNEL=beta RUNWEAVE_APP_SERVER_HOME="$HOME/.runweave/app-server-beta" pnpm runweave:update --dry-run` 同时输出 `channel: beta`、`installed app: /Applications/Runweave.app`、`app-server home: ~/.runweave/app-server-beta`。
- 修复方向：正式入口必须显式固定 Stable 默认值；Beta wrapper 通过明确参数传递整套通道配置，禁止从 ambient terminal env 拼出混合目标。

### 4. 共享更新器提前切换 App Server，破坏 Stable 的原子失败语义

改动前，Desktop Runtime/App 成功后才更新 App Server；当前代码先更新 App Server，再构建/安装/重启 Desktop。Beta wrapper 能尝试回滚，但正式 `pnpm runweave:update` 没有外层恢复逻辑；若 Desktop 后续失败，Stable App Server 已切换而 update state 尚未写入，留下不可追溯的部分更新。

- 定位：`scripts/runweave-update.mjs:638`；对照 `git show HEAD:scripts/runweave-update.mjs` 的原顺序在 594-637 行。
- 修复方向：保持 Stable 原顺序，或给共享更新器提供覆盖 App Server、Runtime/App 和 state 的通道级事务/回滚，不能只依赖 Beta wrapper。

## 验证结果

- 通过：Electron、frontend、CLI、shared typecheck。
- 通过：`pnpm lint`。
- 通过：`pnpm runweave:update:test-cases`（15 cases）。
- 通过：`pnpm runweave:beta:verify`、两个更新脚本 `node --check`、`git diff --check`。
- 未计入本次 Beta finding：backend typecheck 当前被评审范围外、并发修改中的 Agent Team completion-recovery 代码阻塞；错误集中在 `backend/src/agent-team/service.ts`，Beta worker 的 changedFiles 不包含该文件。

## 残余说明

本轮是代码复审，没有执行 RWB-001～RWB-011 的真实 Desktop/Playwright 行为验收；该范围属于已分配的 `behavior_verify` worker。
