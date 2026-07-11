# Runweave Dev Session Round 15 代码复审

## 结论

`case_24` 通过。本轮未发现仍未修复的 P0/P1。Round 14 暴露的 Beta packaged main identity drift 已按根因修复：electron-builder 的 appDir 现在指向实例 staging `buildRoot/electron`，其中精简后的 package.json 与带实例编译身份的 `dist/main.cjs` 同根，源码共享 `electron/dist` 不再是实例打包输入。

## 复审依据

- **运行产物差异已直接确认。** 已安装 dvs14 App 的 `app.asar/dist/main.cjs` 不包含 `dvs14-000-beta` 和 `processSignature`，而实例 buildRoot 的 `electron/dist/main.cjs` 同时包含二者；这与 status 缺少 executable/processSignature、统一健康检查 fail closed 完全一致。
- **根因位于 electron-builder appDir。** Round 14 的配置虽增加绝对 FileSet，但 builder 仍以源码 `electron` 为 appDir，并根据其 package.json main 自动收集共享 `dist/main.cjs`。Round 15 将 `directories.app` 显式设为 `buildRoot/electron`，消除了自动收集的第二来源。
- **package.json 与 main 同源。** `scripts/electron-dist-retry.mjs:133-158` 在 staging appDir 内生成实例 bundle，并从源码 package.json 派生运行清单；清单保留 `type=module`、`main=dist/main.cjs`，移除已由 esbuild bundle 覆盖的 dependencies/devDependencies。
- **electron-builder 契约成立。** 本仓库锁定的 app-builder-lib 25.1.8 会以 `path.resolve(projectDir, directories.app)` 解析绝对 appDir，并从该目录读取 two-package package.json；主 FileMatcher 也以该 appDir 为默认源。绝对 afterPack 路径由 `require.resolve`/动态 import 解析，不依赖 staging cwd。
- **资源与输出隔离保持。** resources、frontend extraResources、node-pty 和 release 仍分别指向明确的源码资源或当前实例 buildRoot；非 isolated 打包路径未改变。
- **静态门禁通过。** 本轮独立执行目标脚本语法检查、ESLint、diff check、`pnpm typecheck`、`pnpm lint` 和 `pnpm dev:session:verify`，均以 0 退出；Dev Session verify 的 10 项检查全部通过。

## Findings

### P0/P1

无。

### 已修复

- **P1 resolved — builder 源码 appDir 自动收集共享 electron/dist，覆盖实例 main bundle。** 实例 staging appDir 现同时拥有 package.json 与实例 dist，builder 的 main 解析和文件匹配均不再触达共享 dist。定位：`scripts/electron-dist-retry.mjs:133-182`。
- **P1 resolved — 实例 control CLI bundle cwd 错误。** Round 14 已真实完成 Beta App Server runtime 安装，确认 Round 13 修复生效。证据：`~/Library/Application Support/Runweave Beta/instances/dvs14-000-beta/user-data/update/logs/update-2026-07-11T12-09-21-455Z.log:133-144`。

## 残余验证风险

本轮未重新执行 Beta full-app；下一轮 behavior_verify 仍需用全新实例确认 packaged `main.cjs` 包含 compiled instance identity，desktop status 写出 executable/startedAt/processSignature，且 Desktop/Backend/CDP readiness 与安全 cleanup 恢复。这是行为验收边界，不是当前代码复审发现的 P0/P1。
