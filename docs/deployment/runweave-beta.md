# Runweave Beta 开发与使用指南

Runweave Beta 是 macOS 本机开发通道。正式版 Runweave（Stable）继续承载终端和开发上下文；当前源码 worktree 通过 Beta 控制命令构建并部署到本机 Beta 实例，作为被开发、重启、验证和回滚的目标。

Beta 以 `instanceId` 区分本机实例。默认实例是 `default`；需要并行验证不同 worktree 或不同 revision 时，为每个目标显式传入 `--instance <id>`。合法 ID 只允许 1 到 32 位小写字母、数字和连字符，不能以连字符开头或结尾。

`dev-session --profile beta` 使用独立的固定池策略：只会分配 `pool-01` 至 `pool-05`，不再按 Session 创建新的 App 或实例目录。`--dry-run` 只返回非权威容量快照；真实 start 才获取 lease，stop 完成进程身份校验、mutable reset、release retention 和 metadata 落盘后才释放。本文其余 `runweave:beta:*` 命令仍是低层显式实例入口，可继续操作既有 legacy instance。

池槽位的 Desktop Runtime 与 update state 位于实例根目录的 `runtime/` 和 `warm-state/`，不在会被整体替换的 `user-data/` 中。每槽 Desktop Runtime、App Server Runtime 只保留 current + previous；legacy 资源只由 `legacy-inventory` 盘点，必须通过单实例 `legacy-cleanup` 进入 quarantine，并用 operation id 显式 restore 或二次确认 purge。

当前没有单独的 `dev:beta` 热开发命令。推荐模型是：

```text
Stable Runweave 中修改代码
        ↓
选择或创建 Beta 实例
        ↓
预览该实例的更新计划
        ↓
构建并更新 Beta
        ↓
在 Beta 中验证真实行为
        ↓
继续下一轮修改
```

## 适用范围与前置条件

- 当前实现仅面向 macOS 本机开发，不是对外分发的 Beta 发布渠道。
- 在目标源码 worktree 中执行本文命令；更新状态会记录该 worktree 的路径和源码 revision。
- 推荐保持 `/Applications/Runweave.app` 正常运行，并在 Stable terminal 中执行 Beta 更新，以免被测 Beta 重启时中断开发控制面。
- 仓库固定使用 `pnpm@10.6.2`。首次构建前执行 `corepack enable && pnpm install`，并确认当前 worktree 能正常执行项目构建命令。
- 需要页面级验收时，先用 `command -v playwright-cli` 确认 CLI 命令可用，并使用 `$toolkit:playwright-cli` skill 执行验收。

## 快速开始

### 1. 选择实例

单实例日常开发可以省略 `--instance`，等价于 `--instance default`。多实例或跨 revision 验证必须显式传入实例名：

```bash
pnpm runweave:beta:status --instance agent-a --json
```

实例拥有独立的 App、userData、runtime、更新状态、App Server home 和 CDP 状态。不要用端口或最近启动时间推断目标实例。

### 五槽位池状态

`dev-session --profile beta` 已收敛到固定 5 个全局槽位：`pool-01` 至 `pool-05`。低层
`runweave:beta:*` 命令仍按显式 `instanceId` 操作既有 legacy instance，不能用来推断
`dev-session` 的池化所有权。

池化实现必须同时满足：

- dry-run 只输出 `policy`、`capacity`、`requestedSlotId` 和非权威 capacity snapshot，
  不创建 session、manifest、lease 或目录，也不承诺 `assignedSlotId`。
- 真实 start 获取单槽 lease 后，才把 `assignedSlotId + leaseNonce` 写入 manifest；
  lease 是唯一所有权真相，metadata 只用于 LRU 与诊断。
- stop/reset 必须在停止 slot-owned 进程、整体替换 mutable `user-data`、清理 dedicated
  App Server state、写入 manifest 与 metadata 后，最后释放 lease。
- shared Backend/App Server 只记录引用，永远不被 slot janitor 停止或删除；Stable 与 legacy
  instance 不属于自动池清理范围。
- 每个槽位的 Desktop Runtime 与 App Server Runtime 最多保留 current + previous；磁盘不足时
  只能清理所有权可证明的 pool 垃圾，仍不足则 fail closed。

验收合同见 [Runweave Beta 槽位池测试用例](../testing/beta-slot-pool-test-cases.md)。需要验证
`dev-session --profile beta` 时，以该合同和 `dev:status` / `dev:open` 返回的 slot、lease、
manifest、CDP 身份为准。

### 2. 预览更新计划

```bash
pnpm runweave:beta:update --instance agent-a --dry-run
```

`--dry-run` 只读取源码、安装版本和已有状态，不构建、不安装、不退出进程，也不写更新状态。输出中的以下字段决定本次动作：

```text
selected mode: runtime | app
selected app-server action: update | skip
reason: ...
```

### 3. 构建并部署 Beta

```bash
pnpm runweave:beta:update --instance agent-a
```

首次部署没有历史基线时，会构建并安装完整 Beta App 和 Beta App Server。成功后更新器会等待 Beta Desktop、backend、CDP 以及需要更新的 App Server 达到健康状态，再输出完整 status。

Beta App 安装在实例化路径：

```text
/Applications/Runweave Beta <instanceId>.app
```

更新器正常情况下会自动启动或重启 Beta。需要手工打开时执行：

```bash
open "/Applications/Runweave Beta agent-a.app"
```

### 4. 检查运行状态

```bash
pnpm runweave:beta:status --instance agent-a --json
```

重点检查：

```text
desktop.healthy
backend.healthy
appServer.healthy
cdp.healthy
cdp.desktop.healthy
cdp.terminalBrowser.healthy
source.gitHead
source.dirty
update.lastAction
update.lastAppServerAction
lastFailure
```

`status --json` 使用允许字段列表，不输出登录凭据、App Server 凭据或请求认证信息。

## 日常开发流程

每轮修改完成后执行：

```bash
pnpm runweave:beta:update --dry-run
pnpm runweave:beta:update
pnpm runweave:beta:status --json
```

多实例时所有命令都带同一个 `--instance <id>`：

```bash
pnpm runweave:beta:update --instance agent-a --dry-run
pnpm runweave:beta:update --instance agent-a
pnpm runweave:beta:status --instance agent-a --json
```

更新器会记录成功部署时 dirty 和 untracked 文件的内容摘要。仍未提交但内容未变化的文件在下一轮视为已经部署；只有提交差异、文件新增、修改、删除或权限变化才重新进入组件选择。

### 自动更新策略

默认 `auto` 是推荐模式：

| 源码变化                        | 更新动作                                |
| ------------------------------- | --------------------------------------- |
| frontend/backend 等运行时代码   | 构建新的 Desktop Runtime，并重启 Beta   |
| Electron shell、打包或原生资源  | 重新打包并安装完整 Beta App             |
| App Server 相关路径             | 独立构建并切换 Beta App Server          |
| 首次部署或缺少历史状态          | 完整 Beta App，并初始化 Beta App Server |
| 已部署且内容未变化的 dirty 文件 | 不重复触发对应组件更新                  |

完整 App 的敏感路径列表以 `scripts/runweave-update-core.mjs` 中的 `APP_SENSITIVE_PATH_PREFIXES` 为准，App Server 路径以 `APP_SERVER_SENSITIVE_PATH_PREFIXES` 为准；跨目录改动以 `--dry-run` 的实际选择和原因作为权威判断。

### 强制更新模式

只有在排查自动判断或验证特定组件时才建议强制模式：

```bash
# 强制只构建 Desktop Runtime
pnpm runweave:beta:update --mode=runtime

# 强制重新打包完整 Beta App
pnpm runweave:beta:update --mode=app

# 强制更新或跳过 Beta App Server
pnpm runweave:beta:update --app-server=update
pnpm runweave:beta:update --app-server=skip
```

Runtime 更新可以选择安装后不重启：

```bash
pnpm runweave:beta:update \
  --mode=runtime \
  --app-server=skip \
  --no-restart
```

`--no-restart` 不能用于完整 App 更新，也不能与 App Server 更新同时使用。不要用强制 Runtime 模式绕过 Electron shell 或构建配置变化，否则 Beta 运行的壳层可能与源码不一致。

## 在 Beta 中使用 Runweave

Beta 页面顶部会显示以下构建标识，窗口标题也包含源码 revision：

```text
BETA · <version> · <source revision>
```

在 Beta 中打开项目并创建 terminal 后，terminal 会自动获得 Beta backend 地址、独立 CLI profile 和 Beta App Server 环境。可以用只读命令确认连接目标：

```bash
rw health --json
```

Beta terminal 的输出应满足 `reachable=true`、`authenticated=true`、`profile=beta`，且 `baseUrl` 与 `pnpm runweave:beta:status --json` 返回的 `backend.baseUrl` 一致。Stable terminal 应连接 Stable backend，Beta terminal 应连接 Beta backend。

### Beta 登录账号

Beta 是仅监听本机的开发通道，使用固定登录凭据：

```text
账号：admin
密码：admin
```

固定弱密码只允许在显式 Beta Desktop 通道中使用。Stable 和其他 packaged backend 仍会拒绝 `admin/admin`。

### 更新命令的通道语义

以下正式更新命令始终指向 Stable，即使它从 Beta terminal 中执行：

```bash
pnpm runweave:update
```

更新 Beta 必须显式执行：

```bash
pnpm runweave:beta:update
```

这是保护边界，不是环境继承错误。正式更新器会清除 Beta-scoped 环境，并固定使用 Stable App、Runtime、App Server 和更新状态。

## 固定隔离边界

| 资源                  | Beta 路径或身份                                                                |
| --------------------- | ------------------------------------------------------------------------------ |
| Desktop App           | `/Applications/Runweave Beta <instanceId>.app`                                 |
| bundle id             | `com.runweave.desktop.beta.<instanceId>`                                       |
| Electron userData     | `~/Library/Application Support/Runweave Beta/instances/<instanceId>/user-data` |
| backend profile       | `<userData>/browser-profile`                                                   |
| CLI profile           | `<userData>/cli/config.json`                                                   |
| Desktop Runtime       | `<userData>/runtime`                                                           |
| 更新状态              | `<userData>/update/state.json`                                                 |
| App Server            | `~/.runweave/app-server-beta/<instanceId>`                                     |
| App Server cloud sync | `~/.runweave/app-server-beta/<instanceId>/cloud-sync`                          |
| Desktop CDP           | `status.cdp.desktop.endpoint`，动态 loopback endpoint                          |
| Terminal Browser CDP  | `status.cdp.terminalBrowser.endpoint`，动态 loopback endpoint                  |

Beta 构建不会安装全局 completion hook，不显示或启用正式版自动更新入口。Beta backend 启动后会在独立 CLI profile 中 refresh/login，并把动态 backend URL 和该 profile 路径注入新 terminal；不会读取或覆盖 `~/.runweave/config.json`。

## 验证

### 静态与结构门禁

```bash
pnpm runweave:beta:verify
pnpm runweave:update:test-cases
pnpm --filter @runweave/electron typecheck
pnpm --filter @runweave/frontend typecheck
pnpm lint
git diff --check
```

`runweave:beta:verify` 检查 Stable/Beta 写路径是否重叠、Beta builder identity 是否存在，以及 status 是否包含敏感字段；它不能代替真实行为验收。

### 页面与 CDP 验证

先执行 `pnpm runweave:beta:status --instance <id> --json`，按验收目标复制实际 endpoint，再使用 `$toolkit:playwright-cli` 连接目标页面：

```bash
playwright-cli -s=runweave-beta-agent-a-desktop attach --cdp="<status.cdp.desktop.endpoint>"
playwright-cli -s=runweave-beta eval \
  "JSON.stringify({title: document.title, channel: document.documentElement.dataset.runweaveChannel, revision: document.documentElement.dataset.runweaveSourceRevision})"
playwright-cli -s=runweave-beta detach
```

预期 `channel` 为 `beta`，标题和页面 revision 与 status 中的 `source.gitHead` 对应。dirty 或 untracked 内容不会进入页面 revision；是否部署了脏工作区必须同时检查 `source.dirty` 和更新状态中的 worktree snapshot。桌面并存、退出、恢复和窗口身份使用 `$computer-use` 验证。

Terminal Browser 验收使用 `status.cdp.terminalBrowser.endpoint`。Desktop CDP 和 Terminal Browser CDP 是不同 surface；不要用一个 endpoint 代替另一个，也不要使用全局 `PLAYWRIGHT_MCP_CDP_ENDPOINT` 或 Playwright 默认配置猜测目标。

完整回归按 [Runweave Beta 自举开发通道测试用例](../testing/platform/runweave-beta-self-hosting-test-cases.md) 执行。静态命令、status 或代码阅读不能代替该文档要求的真实桌面与页面行为证据。

## 回滚

最近一次更新有问题时执行：

```bash
pnpm runweave:beta:rollback --instance default
```

多实例回滚必须带实例：

```bash
pnpm runweave:beta:rollback --instance agent-a
```

回滚会恢复最近一次更新前记录的 Beta App、Runtime 和 App Server 指针，并等待 Beta Desktop、backend、CDP 以及原本存在的 App Server 恢复健康。没有上一可用版本时命令返回非零状态。

更新失败或更新后 45 秒内未达到健康状态时，Beta 更新器会先尝试自动恢复更新前基线，再记录失败摘要。自动恢复失败时不要继续反复更新，先根据 status 和日志定位组件。

## 日志与常见问题

更新日志位于：

```text
~/Library/Application Support/Runweave Beta/instances/<instanceId>/user-data/update/logs/
```

失败摘要和对应日志路径同时出现在：

```bash
pnpm runweave:beta:status --instance <id> --json
```

### `dry-run` 意外选择完整 App

查看输出中的 `native-sensitive changes` 和 `reason`。Electron 主进程、打包配置、资源或更新脚本变化会触发完整 App；首次部署和源码 shell 版本高于已安装版本也会触发完整 App。

### Beta 已打开，但 status 报告不健康

依次核对 `desktop`、`backend`、`appServer`、`cdp` 四个对象。不要只按进程名判断：status 还会验证 Beta App 路径、PID、profile、健康接口以及 CDP 监听进程归属。

### 无法回滚

只有成功更新后保存了上一可用基线，`rollback` 才能恢复。首次安装前或上一基线已经不存在时，命令会明确返回 `No previous Beta release is available for rollback`。

### Beta 与 Stable 看起来相同

优先检查窗口标题和页面顶部的 `BETA` 标识，再用 `status --json` 中的 App 路径、userData、backend profile、Desktop CDP 和 Terminal Browser CDP endpoint 交叉确认。不要只凭 Dock 图标或端口猜测通道。
