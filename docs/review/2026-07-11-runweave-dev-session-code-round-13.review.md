# Runweave Dev Session Round 13 代码复审

## 结论

`case_24` 通过。本轮未发现仍未修复的 P0/P1。Round 12 暴露的 Beta App Server runtime 安装阻断已按根因修复：实例 control CLI bundle 现在从 `packages/runweave-cli` 目录执行，使相对入口 `src/index.ts` 落到真实 CLI package；输出仍写入实例专属 `control/cli/index.js`。

## 复审依据

- **Round 11 修复已被真实路径验证。** Round 12 日志显示 electron-builder 已读取 `electron/package.json`，完成 macOS app 打包和安装，说明此前 `app.asar/package.json` 缺失已闭环。证据：`~/Library/Application Support/Runweave Beta/instances/dvs12-000-beta/user-data/update/logs/update-2026-07-11T11-56-17-907Z.log:111-132`。
- **新失败点与修复对象一致。** 同一日志随后在 CLI bundle 阶段报 `Could not resolve "src/index.ts"`；当时 `packages/runweave-cli/scripts/bundle.mjs` 从 repo root 执行，而入口明确是 package-relative 的 `src/index.ts`。证据：同一日志 `:133-167`。
- **CLI package cwd 已对齐。** `scripts/install-app-server-runtime.mjs:41-52` 仅在实例 CLI 输出启用时，把 bundle 子进程 cwd 设为 `packages/runweave-cli`；`packages/runweave-cli/scripts/bundle.mjs:3-10` 因而能解析正确入口。
- **实例输出与既有语义保持。** bundle 子进程仍通过 `RUNWEAVE_CLI_BUNDLE_OUTFILE` 写入绝对的实例 control CLI 路径；App Server bundle、默认 CLI build 和随后 `app-server install` 未传 `options.cwd`，继续使用 repo root。
- **静态门禁通过。** 本轮独立执行 `node --check`、目标脚本 ESLint、`git diff --check -- . ':(exclude)docs/review'`、`pnpm typecheck`、`pnpm lint`、`pnpm dev:session:verify`，均以 0 退出；Dev Session verify 的 10 项检查全部通过。

## Findings

### P0/P1

无。

### 已修复

- **P1 resolved — 实例 control CLI bundle 从 repo root 执行导致 `src/index.ts` 无法解析。** bundle 子进程已使用 CLI package cwd，并保留实例专属输出。定位：`scripts/install-app-server-runtime.mjs:41-52,77-85`。
- **P1 resolved — 实例化 builder files 覆盖导致 app.asar 缺少 package.json。** Round 12 的真实打包和安装已确认 Round 11 修复生效。证据：Round 12 update log `:111-132`。

## 残余验证风险

本轮未重新执行 Beta full-app；因此实例 control CLI 的真实 bundle、App Server runtime install/restart 和后续 Beta readiness 仍应由下一轮 behavior_verify 继续确认。这是行为验收边界，不是当前代码复审发现的 P0/P1。
