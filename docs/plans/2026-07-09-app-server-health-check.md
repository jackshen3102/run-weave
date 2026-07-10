# App Server 健康检查与不可用提示

> 状态：设计计划稿。目标是在「打开应用」和「打开终端」两个时机主动检查 App Server 是否存活，不可用时弹窗提示（仅提示，不自动启动、不阻断）。范围只做健康检查，不动 backend 直连、不做单写收敛。

## 背景

App Server 是本机全局 singleton（`~/.runweave/app-server/`），承担 Event Center / ThreadRef / 状态同步。它是独立进程，**不随系统或应用自动启动**（文档 `docs/architecture/app-server-event-center.md`：Electron 只发现、不安装/启动/重启；backend 只发现、不负责启动）。因此它真实存在「没起来 / 崩了 / stale lock / runtime 未激活」等不可用工况——这也是现有代码里已有不可用检查与弹窗的原因。

已核实的现状（`main` @ 2026-07-09）：

- 健康检查能力已存在：`electron/src/app-server-cli.ts` 的 `checkAppServerAvailability()` → 复用 `@runweave/shared/src/app-server-node` 的 `getAppServerStatus`（查 healthz + lock + pid + staleLock）与 `discoverAppServer`。
- 不可用弹窗已存在：`electron/src/main.ts:753-761` 的 `checkAppServerForPackagedBackend()`，弹「App Server 没有启动」，并用 `appServerUnavailableDialogShown` 去重。
- **触发时机不足**：当前只在 packaged backend 启动流程（`checkAppServerForPackagedBackend`，经 `startPackagedBackendRuntime` 的 `ensureAppServer`）触发。**dev 模式不走这条；「每次打开终端」完全没有检查。**
- IPC 桥模式已有：`electron/src/main.ts:863-888` 用 `ipcMain.handle("viewer:...")` 向渲染进程暴露能力，可复用。
- 终端创建入口：前端触发 → backend `backend/src/routes/terminal.ts:198` `POST /session`。

结论：能力齐全，缺的是**把已有检查挂到两个新时机**，并覆盖 dev。这是低风险增量。

## 目标

1. **打开应用时**：应用就绪后主动做一次 App Server 健康检查，dev 与 packaged 都覆盖；不可用则弹窗提示。
2. **打开终端时**：每次创建终端会话前做一次轻量健康探测；不可用则弹窗提示。
3. 弹窗**仅提示**（说明 App Server 不可用 + 不会自动启动），用户确认后应用照常运行，不阻断。
4. 复用现有去重，避免频繁弹窗打扰。

## 非目标

- 不自动安装 / 启动 / 重启 App Server（保持文档「Electron 只检查」原则）。
- 不删除 backend 直连、不做 app-server 单写（当前边界见 `docs/architecture/terminal-completion-hooks.md`）。
- 弹窗不带「重试 / 启动」等操作按钮（本次仅提示）。
- 不阻断进入终端或应用。
- 不新增单元测试文件（遵循仓库约束）。

## 核心设计

### 复用而非重造

健康检查统一走现有 `checkAppServerAvailability()`；弹窗统一走一个抽出的 `showAppServerUnavailableDialog()`（把 main.ts:753-761 的弹窗+去重逻辑抽成可复用函数），三个调用点共用同一份去重标志 `appServerUnavailableDialogShown`。

### 去重语义

- 一旦检测到可用，重置去重标志（现有行为，`main.ts:749`），下次不可用可再弹一次。
- 不可用时只弹一次，直到恢复。三个时机（现有 packaged 启动 + 新增开应用 + 新增开终端）共享同一标志，不各弹各的。

### 时机一：打开应用

- 在 app ready（`app.whenReady()` 后、窗口创建后）加一次独立健康检查，**不依赖 packaged backend 启动流程**，因此 dev 也覆盖。
- 复用 `checkAppServerAvailability` + `showAppServerUnavailableDialog`。

### 时机二：打开终端

- 弹窗是主进程能力（`dialog`），终端创建在渲染进程/前端触发，需经 IPC 桥。
- 新增 `ipcMain.handle("viewer:check-app-server")`：主进程做一次 `checkAppServerAvailability`，不可用则弹窗并返回状态。
- 前端在创建终端会话（调 `POST /session`）之前 `await window.<bridge>.checkAppServer()`；不可用不阻断，仅确保弹窗已触发。
- preload 暴露该方法，与现有 `viewer:*` 桥保持同一模式。

> 备选（更轻）：若不想改前端，可在 backend `POST /session` handler 侧返回一个「app-server 不可用」的标记，由 Electron 拦截。但这会把 app-server 检查耦合进 backend HTTP 层，且 dev 直连浏览器场景无主进程弹窗。**倾向 IPC 方案**：职责更清晰，弹窗始终在 Electron 主进程。

## 实施步骤（每步带验证）

### 步骤 1 · 抽出可复用弹窗函数

- 把 `main.ts:753-761` 的弹窗+去重抽成 `showAppServerUnavailableDialog()`；`checkAppServerForPackagedBackend` 改为调用它（行为不变）。
- → 验证：`pnpm --filter @runweave/electron typecheck` + `lint`；packaged 启动路径弹窗行为不回归。

### 步骤 2 · 打开应用时检查

- app ready 后加独立健康检查调用（dev + packaged）。
- → 验证：typecheck + lint；dev 下故意不启动 app-server，启动应用应弹窗一次；启动 app-server 后重开不弹。

### 步骤 3 · 打开终端时检查（IPC）

- 新增 `ipcMain.handle("viewer:check-app-server")` + preload 暴露 + 前端在创建终端前调用。
- → 验证：typecheck + lint；不启动 app-server 时开终端弹窗一次；恢复后开终端不弹。

### 步骤 4 · 真实行为核对（关键，非静态）

- packaged 与 dev 两种形态下，分别验证：开应用不可用弹窗、开终端不可用弹窗、恢复后不再弹、可用时全程无弹窗。
- → 验证：按 AGENTS.md，桌面弹窗与应用启动用 `$computer-use` 操作/取证；页面级（开终端交互）用 `$playwright-cli`。记录命令与关键证据；未执行须写明「未执行 + 阻塞原因」。

### 步骤 5 · 文档保鲜

- 在 `docs/architecture/app-server-event-center.md` 的「CLI 与 Electron 诊断」段补：Electron 在开应用/开终端两个时机做健康检查并在不可用时提示（仅提示，不自动启动）。
- → 验证：文档与代码一致；不改代码。

## 验收标准

- [ ] dev + packaged 下，打开应用时若 app-server 不可用，弹窗提示一次。
- [ ] 打开终端时若 app-server 不可用，弹窗提示一次；不阻断进入终端。
- [ ] app-server 可用时，两个时机全程无弹窗。
- [ ] 不可用→恢复→再次不可用，能再次提示（去重标志正确重置）。
- [ ] 现有 packaged 启动弹窗行为不回归。
- [ ] `pnpm typecheck`、`pnpm lint` 通过；步骤 4 的桌面/页面证据齐全。

## 风险与回退

- **风险：弹窗打扰**（多时机各弹）→ 三时机共享同一去重标志，保证「一次不可用只提示一次」。
- **风险：健康检查阻塞启动/开终端** → 检查是短超时探测，且不阻断主流程（不可用也放行）。
- **风险：dev 浏览器场景无主进程** → dev 若在纯浏览器（非 Electron）打开，无 `dialog`；此场景本就无桌面弹窗能力，属预期，不在本计划覆盖（可在文档标注）。
- **回退**：纯增量，移除新增的两个检查调用点即回到现状。

## 关联

- 单写与 backend 直连收敛：当前边界见 `docs/architecture/terminal-completion-hooks.md`。本健康检查是「若未来单写、app-server 成为单点」时的必要健康保障前置，但本计划本身不依赖单写、可独立落地。
