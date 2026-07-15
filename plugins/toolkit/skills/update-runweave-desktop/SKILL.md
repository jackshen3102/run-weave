---
name: update-runweave-desktop
description: 仅当用户显式指定此 skill 时使用；在当前项目内更新本地 Runweave macOS 桌面客户端。用于区分 runtime 热更新、完整 Electron App 更新和 App Server 更新，并通过更新器返回的 desktop CDP 与 Playwright 验证真实桌面 UI，最终必须进入终端页面完成确认。
---

# 更新 Runweave 桌面端

## 概览

此 skill 只在用户手动指定时执行。默认调用方已经位于当前项目根目录；不要定位 checkout、切换目录、更新源码或要求用户提供项目路径。使用仓库统一的本地更新器判断本地 Runweave 桌面客户端需要 runtime 热更新、完整替换 Electron App，还是安装并重启 App Server；实际更新路径只走 `pnpm runweave:update`，桌面 App UI 通过更新器显式提供的 desktop CDP 使用 Playwright 验证。

## 必需技能

- 读取或操作 Runweave 桌面 renderer 前，先加载 `playwright-cli`。
- Computer Use 不是常规升级或验收依赖。只有遇到 Gatekeeper、TCC、Finder、Dock、原生菜单或 macOS 系统弹窗等 CDP 不可见表面时，才作为可选兜底；未使用不影响正常完成。

## 工作流

1. 更新前检查已安装和本地状态：
   - 如果存在 `~/Library/Application Support/RunweaveLocalUpdate/state.json`，读取上次本地更新状态。
   - 从 `/Applications/Runweave.app/Contents/Info.plist` 检查已安装 App 的路径和版本。
   - 检查正在运行的 Runweave 进程，确保当前活跃 App 来自 `/Applications/Runweave.app`，而不是挂载的 `/Volumes/...` App。

2. 先用统一命令规划：
   - 运行 `pnpm runweave:update --dry-run`。
   - 从输出中读取 `selected mode`、`reason`、`selected app-server action`、`app-server reason`、`app-server home` 和 `native-sensitive changes`。
   - backend、frontend 和 shared runtime 变更通常应选择 `runtime`。
   - Electron shell/native 文件、App resources、builder 配置、本地更新脚本、缺少历史状态，或源码 shell 版本更新时，应选择 `app`。
   - `app-server/`、CLI app-server 命令、shared app-server 协议、app-server 安装或验证脚本变更时，应选择 `selected app-server action: update`。

3. 只通过统一更新器执行：
   - 使用：`pnpm runweave:update --verify-desktop`。
   - `--verify-desktop` 会让更新器用去除 Electron/runtime 污染变量的环境启动安装态 App，分配独立 desktop CDP endpoint，写入 `RunweaveLocalUpdate/desktop-verification.json`，并等待 App 路径、PID、版本、窗口可见性和主 renderer target 完成身份握手。
   - 只有在用户明确要求，或 dry-run 原因证明 auto 模式错误时，才强制指定模式：`--mode runtime` 或 `--mode app`。
   - 只有在用户明确要求，或 dry-run 的 app-server 判断明显错误时，才强制指定 App Server 动作：`--app-server=update` 或 `--app-server=skip`。
   - 测试 App Server 更新必须显式使用隔离 home，例如 `--app-server-home=$HOME/.runweave/app-server-test`；正式更新默认使用 `~/.runweave/app-server`。
   - `--no-restart` 只用于不更新 App Server 且不做桌面验收的 runtime 更新；不能与 `--verify-desktop` 组合。App 更新必须退出并重新打开桌面端，App Server 更新必须执行 `rw app-server restart`。
   - `--no-restart` 和 `selected app-server action: update` 不能组合；如果只想更新桌面 runtime，用 `--app-server=skip` 明确跳过 App Server。
   - 当 `selected app-server action` 为 `update` 时，统一更新器会安装当前源码构建出的 App Server runtime，并通过 `rw app-server restart` 切换全局 owner；不要绕过更新器手动运行底层安装脚本。

4. 显式附着更新器返回的 desktop CDP：
   - 从 `[runweave-update] desktop verification ready: {...}` 读取 `endpoint`、`statusPath`、`pid`、`appPath`、`appVersion`、`sourceRevision`、`pageUrl` 和 `window`。
   - 先读取 `statusPath`，确认 App 路径是 `/Applications/Runweave.app`，PID、CDP endpoint 与更新器输出一致，且 `window.visible: true`。
   - 使用本轮 PID 构造独立 Playwright session，并显式附着：
     `playwright-cli -s="runweave-update-<pid>-desktop" attach --cdp="<endpoint>"`
   - 不得使用 `playwright-cli open`、默认端口、`9224` Terminal Browser proxy、环境变量、最近实例或既有 Playwright session 代替更新器返回的主窗口 endpoint。

5. 最后必须进入终端页面完成确认：
   - 附着后读取 page/tab 列表，选择与 `pageUrl` 一致的 Electron 主 renderer；不得新建或关闭桌面 page。
   - 使用页面 DOM 进入或恢复一个终端页面；如果已经在 `/terminal/`，不要额外改变用户状态。
   - 至少断言主 renderer URL 属于 Runweave 安装态页面、`document.visibilityState === "visible"`、viewport 宽高均大于 0、终端工作区与输入区域可见且可交互。
   - 验收后只执行 `playwright-cli -s="runweave-update-<pid>-desktop" detach`，不得关闭 App 或用户页面。
   - 不要只以 App 进程启动、窗口出现或版本号变化作为完成条件；必须确认已经到达终端页面。
   - 如果更新器未输出 ready 身份或窗口不可见，先检查：
     - `pgrep -afil '^/Applications/Runweave\.app|Runweave\.app/Contents/MacOS/Runweave'`，确认主进程和 packaged backend 来自 `/Applications/Runweave.app`。
     - `ps eww -p <Runweave 主进程 pid>`，确认没有继承 `ELECTRON_RUN_AS_NODE` 或旧 runtime 环境。
     - `desktop-verification.json` 中的 App、window 与 CDP 身份；任何字段不一致都不能把结果算作通过。
   - desktop attach 失败或出现 CDP 无法处理的 macOS 原生交互时停止验收并报告具体阻塞；不要降级到 `9224`、独立浏览器或纯进程检查。

## 禁止使用

- 不要指导 agent 把这些底层命令作为常规桌面端更新流程：
  - `pnpm publish:electron:local-updates`
  - `pnpm serve:electron:local-updates`
  - `pnpm electron:local-update`
  - `pnpm app-server:install`
  - `rw app-server install`
  - `rw app-server restart`
- 不要要求用户指定 checkout、repo 路径或工作目录；此 skill 默认就在当前项目内执行。
- 不要拉取、切换或更新源码分支；此 skill 只负责用当前项目内容更新本地桌面客户端。
- 除非统一更新器失败且用户批准修复路径，否则不要手动删除、替换或编辑 `/Applications/Runweave.app`。
- 执行桌面端更新时，不要编辑更新脚本、Electron 配置或 App 代码；除非用户明确要求修复更新器本身。

## 验证

- 如果改动了 skill 或更新器代码，运行 `pnpm runweave:update:test-cases`。
- 如果是实际桌面端更新请求，报告 dry-run 计划、实际执行模式、App Server action/home/release、最终安装的 App 路径和版本、desktop verification status/CDP/PID/page、Playwright attach/detach、是否遇到污染环境或无窗口问题，以及是否已进入终端页面。若因原生系统表面使用了 Computer Use，单独说明原因；常规路径不要求使用。
