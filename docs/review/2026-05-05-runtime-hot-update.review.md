# Runweave 本地 Runtime 更新评审

评审模式：`review-only` 强力模式。

评审范围：当前工作区未提交变更，重点覆盖 Electron runtime 选择/回滚、外部 runtime 包构建安装脚本、后端 health、前端连接状态和共享协议扩展。

检查命令摘要：

- `git status --short --branch`
- `git diff --stat`
- `git diff -- backend/src/index.ts electron/src/backend-runtime.ts electron/src/main.ts electron/src/preload.ts electron/src/protocol-path.ts electron/src/packaged-backend-state.ts electron/src/application-menu.ts electron/src/tray.ts`
- 阅读未跟踪文件：`backend/src/server/health.ts`、`electron/src/runtime-release.ts`、`scripts/build-runtime-package.mjs`、`scripts/install-runtime-package.mjs`、`docs/plans/2026-05-05-runtime-hot-update.md`

未运行测试：本次是 review-only，不做源码修改；结论基于 diff 和代码阅读验证。

## 架构 / 策略发现

### P1：可替换 runtime 缺少 shell/runtime 兼容性契约

当前决策：计划把客户端拆成稳定 Electron shell 和可替换 runtime 包，runtime manifest 只包含 `schemaVersion`、`releaseId`、前端 dist、后端入口和文件 hash。构建脚本生成的 manifest 也只有这些字段。

为什么它在系统层面可能是错的：前端 dist、后端 bundle、`@browser-viewer/shared` 协议、preload 暴露的 IPC、Electron 主进程能力并不是独立演进的。当前校验只证明路径和文件存在，不证明这个 runtime 能和当前已安装 shell 一起工作。一个由新代码构建的 runtime 可以调用旧 shell 不存在的 `window.electronAPI`、依赖旧 shell 没注入的环境变量，或发送旧主进程不认识的共享协议字段；后端 `/health` 只要返回 200 就会被视为可用，并可能被记录为 last-known-good。

证据：

- `docs/plans/2026-05-05-runtime-hot-update.md:17` 定义两层架构，`runtime` 成为可替换边界。
- `scripts/build-runtime-package.mjs:104` 生成 manifest，但没有 shell/runtime API 版本、最低 shell 版本或共享协议版本。
- `scripts/install-runtime-package.mjs:165` 只校验 schema、路径和 sha256。
- `electron/src/runtime-release.ts:136` 只校验 manifest 路径合法性，`electron/src/runtime-release.ts:187` 只检查文件存在。
- `electron/src/preload.ts:11` 是 renderer 能力边界，`electron/src/preload.ts:40` 已新增 shell API，说明 runtime 前端与 shell API 可能漂移。

更好的候选方案：

- 候选 A：保留本地 runtime 更新，但 manifest 必须加入 `runtimeApiVersion`、`minimumShellVersion`、`sharedProtocolVersion`，安装脚本和 Electron resolver 双重拒绝不兼容 release。交付速度中等，复杂度低到中，能保留当前目标。
- 候选 B：将 runtime 包限定为“只允许兼容 API 内的前端/后端业务变更”；任何 preload、main、shared 协议、原生依赖、打包资源变化仍走现有 `electron-updater` / 完整 mac 客户端更新。交付速度最快，运维风险最低，但热更新覆盖面较小。
- 不推荐：继续只靠 `schemaVersion: 1` 和 `/health 200` 判定 release 可用。这会把版本兼容问题延迟到用户运行时。

推荐方案：当前阶段采用候选 A，并明确候选 B 作为发布规则：跨 shell 边界的变更不能通过 runtime 包投放。

迁移/过渡风险：需要给现有本地 runtime 包补齐 manifest 字段；旧包可按“不兼容”处理并回退 bundled。短期会让一些已生成 runtime 包不能安装，但这是比加载错版本更可控的失败模式。

## 代码 / 实现发现

### P2：畸形 manifest 的 `files` 字段会绕过“无效 manifest 回退”并抛异常

为什么这是风险：计划要求外部 runtime 不存在、manifest 无效或关键文件缺失时回退内置 runtime。但 `validateManifestPaths()` 直接对 `manifest.files` 做 `for...of`，如果本地 runtime 的 `manifest.json` 被损坏为 `{ "files": {} }` 这类非数组值，会抛 `TypeError`，而不是返回 `null` 触发 fallback。这个路径发生在 Electron 启动解析 active runtime 时，会把“坏 runtime 回退”变成主进程启动风险。

证据：

- `docs/plans/2026-05-05-runtime-hot-update.md:95` 到 `docs/plans/2026-05-05-runtime-hot-update.md:99` 明确无效 release 应 fallback。
- `electron/src/runtime-release.ts:152` 只判断 truthy，随后 `electron/src/runtime-release.ts:153` 直接迭代 `manifest.files`。
- `electron/src/runtime-release.ts:175` 读取 JSON 后没有外层异常隔离，`electron/src/runtime-release.ts:176` 调用校验失败路径只处理返回 false。

可执行修复方向：把 `files` 视为不可信输入，要求 `undefined` 或 `Array.isArray(files)`，否则 manifest invalid；同时在 `resolveExternalRuntimeRelease()` 外层兜底捕获 manifest 校验异常，并补一条 “files 非数组时回退 bundled” 的 Electron 单测。

### P2：runtime resolver 不校验 manifest 中的 sha256，已安装 release 后续损坏无法被回滚

为什么这是风险：构建脚本已经把每个文件的 sha256 写进 manifest，安装脚本也会校验一次；但 Electron 运行时选择 release 时只检查 `index.html`、`backend/index.cjs` 和 manifest files 是否存在，不复核 hash。安装后文件损坏、被手动替换、目录输入绕过 zip 交付约束时，只要后端能启动并 `/health` 返回 200，就会被当成有效 release，甚至记录为 last-known-good。前端 chunk 损坏时后端 health 仍可能成功，窗口刷新后才暴露白屏或资源 404。

证据：

- `scripts/build-runtime-package.mjs:97` 到 `scripts/build-runtime-package.mjs:115` 生成文件列表和 sha256。
- `scripts/install-runtime-package.mjs:199` 到 `scripts/install-runtime-package.mjs:210` 只在安装时校验 sha256。
- `electron/src/runtime-release.ts:187` 到 `electron/src/runtime-release.ts:196` 运行时只做存在性检查。
- `electron/src/main.ts:408` 到 `electron/src/main.ts:420` 重载成功后直接刷新窗口。

可执行修复方向：在 Electron resolver 或启动前复核 manifest.files 的 sha256；至少对 `frontend/dist/index.html`、后端入口和所有 manifest files 做 hash 校验。若担心启动耗时，可先校验关键文件并异步校验完整文件集，但不能把“文件存在”当作完整性通过。

### P2：current release 无效时，last-known-good 的优先级低于 bundled

为什么这是风险：如果 `current.json` 指向的 release 缺失或 manifest 无效，`resolveActiveRuntimeRelease()` 直接返回 bundled。随后 `startPackagedBackend()` 的 candidates 以 bundled 开始，再追加 last-known-good。这意味着“当前 release 损坏但上一个外部 release 可用”时，会优先回退到内置旧版本，而不是最近一次验证过的外部版本。对本地 runtime 更新来说，这会造成不可预期的版本倒退，也削弱 last-known-good 的意义。

证据：

- `electron/src/runtime-release.ts:218` 到 `electron/src/runtime-release.ts:230` 在 current 无效时返回 bundled。
- `electron/src/backend-runtime.ts:230` 到 `electron/src/backend-runtime.ts:249` 用 active release 初始化 candidates，并在 active 为 bundled 时不会追加 bundled，但 last-known-good 已排在 bundled 后面。
- `docs/plans/2026-05-05-runtime-hot-update.md:99` 写的是启动失败回退到上一个有效 release 或内置 runtime。

可执行修复方向：让 active 解析结果区分“没有外部 current”和“外部 current 无效”；当 current 无效且 last-known-good 有效时，优先尝试 last-known-good，再尝试 bundled。状态消息里也应说明是 current release 无效，而不是笼统说 active runtime 启动失败。

### P3：runtime 状态字段进入 shared state，但前端系统连接模型丢弃了这些信息

为什么这是风险：共享状态新增了 `runtimeSource` 和 `runtimeReleaseId`，计划也说这些字段用于前端展示和调试。但 `buildLocalDevelopmentConnection()` 没有把它们映射到 `ConnectionConfig`，连接页只能看到通用 `statusMessage`，无法确认当前到底是 bundled、external，还是 rollback 后的 release。对一个本地热更新/回滚功能来说，这会降低现场排障能力。

证据：

- `packages/shared/src/runtime-monitor.ts:28` 到 `packages/shared/src/runtime-monitor.ts:32` 增加 runtime metadata。
- `electron/src/main.ts:368` 到 `electron/src/main.ts:373` 已把 metadata 写入 packaged backend state。
- `frontend/src/features/connection/system-connection.ts:20` 到 `frontend/src/features/connection/system-connection.ts:31` 构建连接模型时丢弃 metadata。
- `frontend/src/features/connection/use-connections.ts:22` 到 `frontend/src/features/connection/use-connections.ts:30` 初始状态只能填 null。

可执行修复方向：要么把 metadata 映射到 `ConnectionConfig` 并在系统连接 UI 中显示/调试可见，要么先不要扩展 shared state，避免产生“协议已支持但产品不可见”的半成品契约。

### P3：安装脚本解压 zip 后不清理临时目录

为什么这是风险：`install-runtime-package.mjs` 对 zip 输入会解压到系统临时目录，但安装完成后没有删除这个目录。频繁本地打包安装时会留下多份完整前端 dist 和后端 bundle，属于低级但持续累积的运维噪音。

证据：

- `scripts/install-runtime-package.mjs:137` 到 `scripts/install-runtime-package.mjs:143` 创建并返回临时解压目录。
- `scripts/install-runtime-package.mjs:256` 到 `scripts/install-runtime-package.mjs:259` 安装完成后没有 finally 清理。

可执行修复方向：让 `resolvePackageRoot()` 返回 `{ packageRoot, cleanup }`，主流程在 `finally` 中清理 zip 解压目录；目录输入不清理。

## 剩余风险 / 测试缺口

- 当前测试主要覆盖 happy path 和少量路径逃逸，缺少 manifest 结构畸形、sha256 损坏、current invalid + last-known-good valid、前端资源损坏但后端 health 正常的回归。
- 没看到打包后 mac app 的真实手工验证证据；本功能最终需要在固定 Electron shell 上安装两个 runtime release 并验证前端、后端 `/health.runtimeReleaseId`、回滚提示和窗口刷新。
- 前端测试策略应继续遵守 E2E-only，不应为前端 React hooks 补 Vitest 单测。
