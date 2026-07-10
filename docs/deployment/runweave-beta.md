# Runweave Beta 开发与使用指南

Runweave Beta 是 macOS 本机开发通道。正式版 Runweave（Stable）继续承载终端和开发上下文；当前源码 worktree 通过一条更新命令构建并部署到独立的 Beta App，作为被开发、重启、验证和回滚的目标。

当前没有单独的 `dev:beta` 热开发命令。推荐模型是：

```text
Stable Runweave 中修改代码
        ↓
预览 Beta 更新计划
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
- 需要页面级验收时，先用 `command -v playwright-cli` 确认 `$playwright-cli` 已安装。

## 快速开始

### 1. 预览更新计划

```bash
pnpm runweave:beta:update --dry-run
```

`--dry-run` 只读取源码、安装版本和已有状态，不构建、不安装、不退出进程，也不写更新状态。输出中的以下字段决定本次动作：

```text
selected mode: runtime | app
selected app-server action: update | skip
reason: ...
```

### 2. 构建并部署 Beta

```bash
pnpm runweave:beta:update
```

首次部署没有历史基线时，会构建并安装完整 Beta App 和 Beta App Server。成功后更新器会等待 Beta Desktop、backend、CDP 以及需要更新的 App Server 达到健康状态，再输出完整 status。

Beta App 安装在：

```text
/Applications/Runweave Beta.app
```

更新器正常情况下会自动启动或重启 Beta。需要手工打开时执行：

```bash
open "/Applications/Runweave Beta.app"
```

### 3. 检查运行状态

```bash
pnpm runweave:beta:status --json
```

重点检查：

```text
desktop.healthy
backend.healthy
appServer.healthy
cdp.healthy
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

| 资源                  | Beta 路径或身份                                                 |
| --------------------- | --------------------------------------------------------------- |
| Desktop App           | `/Applications/Runweave Beta.app`                               |
| bundle id             | `com.runweave.desktop.beta`                                     |
| Electron userData     | `~/Library/Application Support/Runweave Beta`                   |
| backend profile       | `~/Library/Application Support/Runweave Beta/browser-profile`   |
| CLI profile           | `~/Library/Application Support/Runweave Beta/cli/config.json`   |
| Desktop Runtime       | `~/Library/Application Support/Runweave Beta/runtime`           |
| 更新状态              | `~/Library/Application Support/Runweave Beta/update/state.json` |
| App Server            | `~/.runweave/app-server-beta`                                   |
| App Server cloud sync | `~/.runweave/app-server-beta/cloud-sync`                        |

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

先执行 `pnpm runweave:beta:status --json`，复制 `cdp.endpoint` 的实际值，再使用 `$playwright-cli` 连接目标页面：

```bash
playwright-cli -s=runweave-beta attach --cdp="<status.cdp.endpoint>"
playwright-cli -s=runweave-beta eval \
  "JSON.stringify({title: document.title, channel: document.documentElement.dataset.runweaveChannel, revision: document.documentElement.dataset.runweaveSourceRevision})"
playwright-cli -s=runweave-beta detach
```

预期 `channel` 为 `beta`，标题和页面 revision 与 status 中的 `source.gitHead` 对应。dirty 或 untracked 内容不会进入页面 revision；是否部署了脏工作区必须同时检查 `source.dirty` 和更新状态中的 worktree snapshot。桌面并存、退出、恢复和窗口身份使用 `$computer-use` 验证。

完整回归按 [Runweave Beta 自举开发通道测试用例](../testing/runweave-beta-self-hosting-test-cases.md) 执行。静态命令、status 或代码阅读不能代替该文档要求的真实桌面与页面行为证据。

## 回滚

最近一次更新有问题时执行：

```bash
pnpm runweave:beta:rollback
```

回滚会恢复最近一次更新前记录的 Beta App、Runtime 和 App Server 指针，并等待 Beta Desktop、backend、CDP 以及原本存在的 App Server 恢复健康。没有上一可用版本时命令返回非零状态。

更新失败或更新后 45 秒内未达到健康状态时，Beta 更新器会先尝试自动恢复更新前基线，再记录失败摘要。自动恢复失败时不要继续反复更新，先根据 status 和日志定位组件。

## 日志与常见问题

更新日志位于：

```text
~/Library/Application Support/Runweave Beta/update/logs/
```

失败摘要和对应日志路径同时出现在：

```bash
pnpm runweave:beta:status --json
```

### `dry-run` 意外选择完整 App

查看输出中的 `native-sensitive changes` 和 `reason`。Electron 主进程、打包配置、资源或更新脚本变化会触发完整 App；首次部署和源码 shell 版本高于已安装版本也会触发完整 App。

### Beta 已打开，但 status 报告不健康

依次核对 `desktop`、`backend`、`appServer`、`cdp` 四个对象。不要只按进程名判断：status 还会验证 Beta App 路径、PID、profile、健康接口以及 CDP 监听进程归属。

### 无法回滚

只有成功更新后保存了上一可用基线，`rollback` 才能恢复。首次安装前或上一基线已经不存在时，命令会明确返回 `No previous Beta release is available for rollback`。

### Beta 与 Stable 看起来相同

优先检查窗口标题和页面顶部的 `BETA` 标识，再用 `status --json` 中的 App 路径、userData、backend profile 和 CDP endpoint 交叉确认。不要只凭 Dock 图标或端口猜测通道。
