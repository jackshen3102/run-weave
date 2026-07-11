# Runweave Dev Session Loop Round 11 代码复审

## 结论

`case_24` 通过。本轮未发现仍未修复的 P0/P1。Round 10 的 `dev:legacy` 入口缺失已以最小改动修复：`package.json` 中 `dev` 与 `dev:legacy` 都精确映射到 `node ./dev.mjs`，没有新增 wrapper、参数转换或第二套 fullstack 启动逻辑。

## 复审依据

- **Legacy 与原入口完全同源。** `package.json:8-9` 的两个 script 值字节级相同；端口选择、环境清洗、Backend/Frontend 启动和信号退出继续由同一个 `dev.mjs` 实现。
- **没有脚本递归。** `dev:legacy` 直接调用 Node entry，不会再调用 `pnpm dev` 或自身，不存在递归/生命周期钩子差异。
- **其他旧入口未改动。** `dev:electron` 仍指向 `electron-dev.mjs`，`app:dev` 仍指向 `app-dev.mjs`；本轮没有修改 `dev.mjs`、Electron/App runner 或前端页面。
- **迁移契约成立。** 当前 `dev` 尚未切换到 Planner 时，两者自然复现同一行为；未来 `dev` 切换到 Dev Session 时，`dev:legacy` 仍固定保留原 `dev.mjs` 逃生路径。
- **已有真实行为证据可复用。** Round 10 已以真实进程、Playwright 和 Computer Use 证明 `pnpm dev` 的 fullstack 页面与退出行为；新别名没有形成新的行为分支。

## Findings

### P0/P1

无。

### 已修复

- **P1 resolved — 阶段 5 所需 `dev:legacy` 迁移逃生入口不存在。** 新入口已注册并与原 `dev` 精确复用同一个 runner。
- **P1 resolved — stale Session status/stop 缺少 cleanup 与恢复指引。** Recovery 和 identity-safe cleanup 保持有效。
- **P1 resolved — Terminal Browser blank target 缺少 renderer/document。** 新 view 立即加载 `about:blank`，CDP 初始化链保持完整。

## 验证证据

- Script equality：`{"dev":"node ./dev.mjs","legacy":"node ./dev.mjs","equal":true}`。
- `pnpm run`：成功列出 `dev` 与 `dev:legacy`，两者命令均为 `node ./dev.mjs`。
- Round 10 `pnpm dev`：真实启动 Backend/Frontend，Playwright 读取 Runweave 登录页面，退出信号后返回 0。
- `pnpm dev:session:verify`：通过，21 项 checks 全部通过。
- `pnpm typecheck`：通过，9 个 workspace project 完成。
- `pnpm lint`、`git diff --check -- . ':(exclude)docs/review'`：通过。

## 残余验证边界

本轮为代码复审，没有再次启动 `pnpm dev:legacy` 的真实进程；由于它与已验收的 `dev` 是完全相同的 Node entry，后续 `behavior_verify` 可直接按 DVS-019 阶段 5 复验。该运行时复验不是当前未修复的 P0/P1。
