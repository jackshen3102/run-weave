# 本地 Runtime 更新改造计划

## 背景

当前 mac 客户端把 Electron shell、前端产物和后端产物打在一起：

- Electron 生产模式固定加载 `browser-viewer://app/index.html`，协议根目录来自 `electron/src/main.ts` 里的 `RENDERER_DIST`。
- 内置后端由 `electron/src/backend-runtime.ts` 启动，入口固定为 `process.resourcesPath/app.asar/dist/backend/index.cjs`。
- `electron/electron-builder.yml` 把 `../frontend/dist` 放到 `Resources/frontend/dist`，把 `node-pty` 原生模块放到 `Resources/backend/node_modules/node-pty`。
- 后端已经支持通过 `FRONTEND_DIST_DIR` 托管外部前端产物，`backend/src/index.ts` 会在目录存在时 `express.static(frontendDistDir)`。
- Electron 已经有 `viewer:restart-packaged-backend` IPC，但当前重启只会重新启动打包在 `app.asar` 里的旧后端代码。

因此，现状支持完整客户端更新，但不支持“只更新前端/后端代码后重启后端服务”。

## 目标

把客户端拆成两层：

1. **稳定 Electron shell**：窗口、菜单、tray、preload、CDP proxy、后端进程管理、runtime 选择与回滚。
2. **可替换 runtime 包**：前端 `dist`、后端 `index.cjs`、manifest 和校验信息。

改造完成后，日常更新流程不需要重新执行 `pnpm dist:electron:mac`，而是：

1. 构建新的 runtime 包。
2. 安装到本机应用数据目录。
3. 触发 Electron 重载 runtime：重启后端、刷新窗口，必要时自动回滚。

## 非目标

- 第一阶段不做远程自动下载、灰度发布或云端更新通道。
- 第一阶段不替换现有 `electron-updater` 完整客户端更新能力。
- 不支持 Windows/Linux 打包更新流程，默认只面向本机 mac 使用。
- 不做前端 Vitest/unit test，不新增前端 `*.test.tsx`。
- 不把业务后端改成长期独立 daemon。后端仍由 Electron shell 管理生命周期。
- 不支持运行时热替换单个 JS chunk。每次更新以一个完整 runtime release 为单位。

## 推荐方案

使用 `app.getPath("userData")/runtime` 作为默认 runtime 根目录。mac 上默认会落在：

```text
~/Library/Application Support/@browser-viewer/electron/runtime
```

目录结构：

```text
runtime/
  current.json
  releases/
    2026.05.05-001/
      manifest.json
      frontend/dist/index.html
      frontend/dist/assets/...
      backend/index.cjs
    2026.05.05-002/
      manifest.json
      frontend/dist/index.html
      frontend/dist/assets/...
      backend/index.cjs
```

`current.json` 示例：

```json
{
  "releaseId": "2026.05.05-002",
  "activatedAt": "2026-05-05T10:00:00.000Z"
}
```

`manifest.json` 示例：

```json
{
  "schemaVersion": 1,
  "releaseId": "2026.05.05-002",
  "createdAt": "2026-05-05T10:00:00.000Z",
  "frontend": {
    "distDir": "frontend/dist",
    "index": "frontend/dist/index.html"
  },
  "backend": {
    "entry": "backend/index.cjs"
  },
  "files": [
    {
      "path": "backend/index.cjs",
      "sha256": "<hex>"
    }
  ]
}
```

Electron 启动时解析 active runtime：

1. 如果 `runtime/current.json` 指向的 release 有效，使用外部 runtime。
2. 如果外部 runtime 不存在、manifest 无效或关键文件缺失，回退到打包内置 runtime。
3. 后端启动失败或 `/health` 超时，标记该 release 启动失败，回退到上一个有效 release 或内置 runtime。

## 文件范围

### Electron 主进程

- `electron/src/runtime-release.ts`
  - 新增 runtime 根目录解析、manifest 读取、文件存在性校验、active release 选择。
  - 输出结构包含：
    - `source: "external" | "bundled"`
    - `releaseId: string`
    - `frontendDistDir: string`
    - `backendEntry: string`
    - `nodePtyDir: string`
    - `runtimeRoot: string | null`
- `electron/src/backend-runtime.ts`
  - 将 `resolvePackagedBackendPaths()` 改为接收 runtime release。
  - `startPackagedBackend()` 每次启动前重新解析 active runtime。
  - 向后端注入：
    - `FRONTEND_DIST_DIR`
    - `RUNWEAVE_RUNTIME_RELEASE_ID`
    - `BROWSER_VIEWER_NODE_PTY_DIR`
  - 保留打包内置 `node-pty` 作为默认原生模块来源。
- `electron/src/main.ts`
  - 将 `RENDERER_DIST` 从常量改为可更新的 active frontend dist。
  - `registerCustomProtocol()` 通过函数读取当前 frontend dist，而不是捕获启动时常量。
  - 新增主进程重载流程：重新解析 runtime，重启后端，reload 所有主窗口。
  - 复用现有 `viewer:restart-packaged-backend` 的串行保护，避免重复重启。
- `electron/src/preload.ts`
  - 暴露窄 IPC：`reloadRuntime()` 或扩展现有 `restartPackagedBackend()` 的返回状态。
  - 不暴露任意文件系统写入能力。
- `electron/src/application-menu.ts` 或 `electron/src/tray.ts`
  - 增加“Reload Local Runtime”操作，方便本地 mac 使用。
  - 菜单行为：触发 runtime 重载，成功后刷新窗口，失败后展示错误。
- `packages/shared/src/runtime-monitor.ts`
  - 可选扩展 `PackagedBackendConnectionState`，增加 `runtimeSource` 和 `runtimeReleaseId`，用于前端展示和调试。

### 后端

- `backend/src/index.ts`
  - `/health` 返回可选 `runtimeReleaseId`：
    - 默认仍返回 `{ "status": "ok" }`。
    - 当 `RUNWEAVE_RUNTIME_RELEASE_ID` 存在时返回 `{ "status": "ok", "runtimeReleaseId": "..." }`。
  - 不改变现有 API、WebSocket 和认证语义。
- `backend/src/server/frontend-dist.ts`
  - 保持 `FRONTEND_DIST_DIR` 优先级。
  - 如有必要，补充测试覆盖外部 runtime dist 路径。

### 构建与安装脚本

- `scripts/build-runtime-package.mjs`
  - 构建前端：`pnpm --filter ./frontend build`。
  - 构建后端 bundle：复用 `electron/scripts/bundle.mjs` 当前产出的 `electron/dist/backend/index.cjs`，或拆出专用 backend bundle 脚本。
  - 生成 staging 目录：
    - `.runtime-artifacts/<releaseId>/frontend/dist`
    - `.runtime-artifacts/<releaseId>/backend/index.cjs`
    - `.runtime-artifacts/<releaseId>/manifest.json`
  - 计算关键文件 sha256。
  - 输出 zip：`.runtime-artifacts/runweave-runtime-<releaseId>.zip`。
- `scripts/install-runtime-package.mjs`
  - 输入 runtime zip 或 staging 目录。
  - 解压到临时目录。
  - 校验 manifest、路径逃逸和 sha256。
  - 原子移动到 `runtime/releases/<releaseId>`。
  - 原子写入 `runtime/current.json`。
  - 支持 `--runtime-home <path>` 便于测试；默认写入 mac 应用数据目录对应路径。
- `package.json`
  - 新增脚本：
    - `runtime:build`
    - `runtime:install`
    - `runtime:pack-and-install`

## 实施阶段

### 阶段 1：runtime 解析与打包内置 fallback

目标：在不改变用户行为的前提下，引入 runtime release 抽象。

内容：

- 新增 `electron/src/runtime-release.ts`。
- 当前没有外部 runtime 时，解析结果必须等价于现有打包资源：
  - 前端：`process.resourcesPath/frontend/dist`
  - 后端：`process.resourcesPath/app.asar/dist/backend/index.cjs`
  - `node-pty`：`process.resourcesPath/backend/node_modules/node-pty`
- 补充 Electron 单测：
  - 无 `current.json` 时回退内置 runtime。
  - `current.json` 指向不存在 release 时回退内置 runtime。
  - manifest 缺少 `frontend/dist/index.html` 或 `backend/index.cjs` 时回退内置 runtime。
  - manifest 中相对路径包含 `../` 时拒绝。

验证：

```bash
pnpm --filter ./electron exec tsx --test src/runtime-release.test.ts src/backend-runtime.test.ts
pnpm --filter ./electron typecheck
```

### 阶段 2：后端启动改为使用 active runtime

目标：重启后端时能启动外部 runtime 的后端代码。

内容：

- 修改 `electron/src/backend-runtime.ts`，让 `startPackagedBackend()` 使用 active runtime 的 `backendEntry` 和 `frontendDistDir`。
- 保留动态端口选择和 `/health` 轮询。
- 后端环境中加入 `RUNWEAVE_RUNTIME_RELEASE_ID`。
- 修改 `backend/src/index.ts` 的 `/health`，便于确认当前后端版本。
- 更新 `electron/src/backend-runtime.test.ts`。

验证：

```bash
pnpm --filter ./electron exec tsx --test src/backend-runtime.test.ts
pnpm --filter ./backend test
pnpm typecheck
```

手工验证：

1. 准备一个外部 runtime，其后端 `/health` 返回 `runtimeReleaseId: "manual-a"`。
2. 启动打包后的 app。
3. 通过连接页或菜单触发后端重启。
4. 请求当前本地后端 `/health`，确认返回 `manual-a`。

### 阶段 3：前端协议根目录改为 active runtime

目标：外部 runtime 的前端 `dist` 能被 Electron 生产窗口加载。

内容：

- 修改 `electron/src/main.ts`：
  - active frontend dist 由 runtime resolver 提供。
  - `browser-viewer://app/*` 每次请求都使用当前 active frontend dist。
  - runtime 重载成功后，对主窗口执行 `webContents.reloadIgnoringCache()`。
- 保持 `resolveProtocolFilePath()` 的路径逃逸防护。
- 如果 runtime 重载失败，窗口继续使用上一版或内置前端，不展示半更新状态。

验证：

```bash
pnpm --filter ./electron exec tsx --test src/protocol-path.test.ts src/backend-runtime.test.ts src/runtime-release.test.ts
pnpm --filter ./electron typecheck
```

手工验证：

1. 打包一次固定 Electron shell：`pnpm dist:electron:mac`。
2. 安装 runtime `manual-a`，启动 app，确认页面来自 `manual-a`。
3. 安装 runtime `manual-b`，点击“Reload Local Runtime”。
4. 确认页面刷新后来自 `manual-b`，后端 `/health` 也返回 `manual-b`。

### 阶段 4：runtime 包构建与安装脚本

目标：提供稳定的本地更新命令，避免手动拷贝目录。

内容：

- 新增 `scripts/build-runtime-package.mjs`。
- 新增 `scripts/install-runtime-package.mjs`。
- 在 `package.json` 增加脚本：

```json
{
  "runtime:build": "node ./scripts/build-runtime-package.mjs",
  "runtime:install": "node ./scripts/install-runtime-package.mjs",
  "runtime:pack-and-install": "pnpm runtime:build && node ./scripts/install-runtime-package.mjs --latest"
}
```

- 安装脚本必须防止 zip slip：
  - 解压后的每个文件最终路径必须位于临时目录内。
  - manifest 中所有路径必须是相对路径。
  - 拒绝绝对路径、空路径、`..` 路径段。
- 安装脚本必须原子更新：
  - 先写 `releases/<releaseId>.tmp`。
  - 校验通过后 rename 为 `releases/<releaseId>`。
  - 最后写入 `current.json.tmp` 并 rename 为 `current.json`。

验证：

```bash
pnpm runtime:build
node ./scripts/install-runtime-package.mjs --latest --runtime-home /tmp/runweave-runtime-test
node ./scripts/install-runtime-package.mjs .runtime-artifacts/runweave-runtime-<releaseId>.zip --runtime-home /tmp/runweave-runtime-test
```

预期：

- `/tmp/runweave-runtime-test/current.json` 指向新 release。
- `releases/<releaseId>/frontend/dist/index.html` 存在。
- `releases/<releaseId>/backend/index.cjs` 存在。
- manifest sha256 校验失败时安装命令退出非 0，且不更新 `current.json`。

### 阶段 5：重载、失败回滚与用户可见状态

目标：让本地更新失败时不会把客户端卡死在坏版本。

内容：

- Electron 维护最近一次成功 runtime：
  - 当前 release 启动成功后记录为 last known good。
  - 当前 release 后端启动失败时自动尝试 last known good。
  - last known good 也失败时回退内置 bundled runtime。
- `PackagedBackendConnectionState` 状态中展示 runtime 来源和 releaseId。
- 菜单或 tray 的“Reload Local Runtime”失败时展示 dialog：
  - 当前 releaseId。
  - 失败原因。
  - 是否已回滚。
- 保留现有连接页的 reconnect 行为，不让用户必须重启整个 app。

验证：

```bash
pnpm --filter ./electron test
pnpm typecheck
pnpm lint
```

手工验证：

1. 安装正常 runtime `manual-good`，重载成功。
2. 安装坏 runtime `manual-bad`，例如缺失 `backend/index.cjs`。
3. 点击“Reload Local Runtime”。
4. 预期 app 提示失败，并继续使用 `manual-good` 或内置 runtime。
5. 终端、浏览器 sidecar、连接管理仍可正常打开。

## 验证矩阵

### 自动化验证

每个阶段完成后至少运行：

```bash
pnpm typecheck
pnpm lint
pnpm --filter ./electron test
```

涉及后端 `/health` 或环境变量时运行：

```bash
pnpm --filter ./backend test
```

涉及前端正式行为时只跑 E2E，不新增前端单测：

```bash
pnpm --filter ./frontend e2e
```

### 打包验证

完整集成完成后运行：

```bash
pnpm dist:electron:mac
pnpm runtime:build
pnpm runtime:install -- --latest
```

然后启动打包 app，手工检查：

- 没有外部 runtime 时能正常使用内置版本。
- 有外部 runtime 时优先加载外部前端和外部后端。
- 安装新 runtime 后，不重打 app，只点击重载即可切换到新版本。
- 坏 runtime 不会导致 app 无法启动。

## 风险与处理

- **前后端版本不一致**：runtime 包必须同时包含前端和后端，禁止只替换其中一半。安装脚本只接受完整 manifest。
- **原生模块 ABI 风险**：`node-pty` 暂时继续使用 Electron 打包内的 `Resources/backend/node_modules/node-pty`，runtime 包不携带新的原生模块。若后续升级 Electron 或 `node-pty`，仍需完整客户端打包。
- **缓存风险**：前端重载使用 `reloadIgnoringCache()`；Electron 自定义协议继续从文件系统读取 active dist。Electron 环境下不依赖 PWA service worker 更新。
- **路径逃逸风险**：runtime manifest 和 zip 解压都必须拒绝绝对路径、`..` 路径和空路径。
- **半更新风险**：安装过程先写临时目录，校验成功后再原子切换 `current.json`。
- **坏版本启动失败**：后端 `/health` 未通过时自动回滚到 last known good 或内置 runtime。
- **完整客户端能力变化**：Electron shell、preload API、菜单、CDP proxy、原生模块、权限能力变化仍需要重新打包客户端；runtime 更新只覆盖前端和后端业务代码。

## 验收标准

- 首次改造后，未安装外部 runtime 的打包 app 行为与当前一致。
- 安装外部 runtime 后，app 启动时优先使用外部前端和外部后端。
- 不重新执行 `pnpm dist:electron:mac`，只通过 runtime 包即可更新前端和后端。
- 点击“Reload Local Runtime”后，后端进程被重启，窗口加载新前端。
- `/health` 能确认当前后端 runtime releaseId。
- 坏 runtime 不会使客户端无法启动，能自动回滚。
- `pnpm typecheck`、`pnpm lint`、Electron 测试、后端测试通过；涉及前端行为时 Playwright E2E 通过。
