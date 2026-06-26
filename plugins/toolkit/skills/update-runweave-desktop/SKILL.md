---
name: update-runweave-desktop
description: 仅当用户显式指定此 skill 时使用；在当前项目内更新本地 Runweave macOS 桌面客户端。用于区分 runtime 热更新和完整 Electron App 更新，并通过 computer-use skill 操作或验证桌面 App UI，最终必须进入终端页面完成确认。
---

# 更新 Runweave 桌面端

## 概览

此 skill 只在用户手动指定时执行。默认调用方已经位于当前项目根目录；不要定位 checkout、切换目录、更新源码或要求用户提供项目路径。使用仓库统一的本地更新器判断本地 Runweave 桌面客户端需要 runtime 热更新，还是完整替换 Electron App；实际更新路径只走 `pnpm runweave:update`，桌面 App UI 操作使用 `computer-use` skill。

## 必需技能

- 读取或操作 Runweave 桌面 UI 前，先加载 `computer-use`。
- 如果需要验证浏览器页面，遵守仓库规则使用 `playwright-cli`；不要用 Computer Use 做浏览器验证。

## 工作流

1. 更新前检查已安装和本地状态：
   - 如果存在 `~/Library/Application Support/RunweaveLocalUpdate/state.json`，读取上次本地更新状态。
   - 从 `/Applications/Runweave.app/Contents/Info.plist` 检查已安装 App 的路径和版本。
   - 检查正在运行的 Runweave 进程，确保当前活跃 App 来自 `/Applications/Runweave.app`，而不是挂载的 `/Volumes/...` App。

2. 先用统一命令规划：
   - 运行 `pnpm runweave:update --dry-run`。
   - 从输出中读取 `selected mode`、`reason` 和 `native-sensitive changes`。
   - backend、frontend 和 shared runtime 变更通常应选择 `runtime`。
   - Electron shell/native 文件、App resources、builder 配置、本地更新脚本、缺少历史状态，或源码 shell 版本更新时，应选择 `app`。

3. 只通过统一更新器执行：
   - 使用：`pnpm runweave:update`。
   - 只有在用户明确要求，或 dry-run 原因证明 auto 模式错误时，才强制指定模式：`--mode runtime` 或 `--mode app`。
   - `--no-restart` 只用于 runtime 更新；App 更新必须退出并重新打开桌面端。

4. 使用 `computer-use` 检查桌面 App：
   - 当选择 App 更新时，确认 App 已重新启动。
   - 启动或重启 `/Applications/Runweave.app` 时，不要从当前 Codex/Runweave 终端直接普通 `open`，因为终端环境可能带有 `ELECTRON_RUN_AS_NODE`、`FRONTEND_DIST_DIR`、`RUNWEAVE_RUNTIME_RELEASE_ID`、`BROWSER_VIEWER_NODE_PTY_DIR` 等打包/runtime 变量，导致 Electron 以 Node 模式启动后立即退出，或加载旧 runtime。优先使用干净环境启动：
     `env -i HOME="$HOME" USER="$USER" LOGNAME="$LOGNAME" PATH="/usr/bin:/bin:/usr/sbin:/sbin" TMPDIR="${TMPDIR:-/tmp}" /usr/bin/open -n /Applications/Runweave.app`
   - 如果干净环境 `open` 后仍需模拟真实用户启动，可先正常退出 Runweave，再用 Finder 打开：`osascript -e 'tell application "Finder" to open POSIX file "/Applications/Runweave.app"'`。
   - runtime 更新重启后，确认桌面端可见状态符合预期。
   - 对 Computer Use policy 要求的高风险 UI 动作，在动作发生前请求确认。

5. 最后必须进入终端页面完成确认：
   - 如果本轮是 runtime 热更新路径：重启桌面端后，使用 `computer-use` 进入终端页面。
   - 如果本轮是完整 App 更新/重装路径：重新安装或替换本地 App 后，打开桌面端并使用 `computer-use` 进入终端页面。
   - 不要只以 App 进程启动、窗口出现或版本号变化作为完成条件；必须确认已经到达终端页面。
   - 如果 `computer-use` 超时或 Runweave 进程存在但窗口不可见，先检查：
     - `pgrep -afil '^/Applications/Runweave\.app|Runweave\.app/Contents/MacOS/Runweave'`，确认主进程和 packaged backend 来自 `/Applications/Runweave.app`。
     - `ps eww -p <Runweave 主进程 pid>`，确认没有继承 `ELECTRON_RUN_AS_NODE` 或旧 runtime 环境。
     - `osascript`/System Events 的窗口数，例如 `tell process "Runweave" to get count of windows`；如果 `windows=0`，不能把“进程存在”当作 UI 验证通过。
   - 如果主窗口不可见但 CDP 代理可用，可用 `playwright-cli` 或 Node/Playwright 连接 `http://127.0.0.1:9224`，读取 `/terminal/` target 的 URL、title、DOM 作为降级诊断证据；但只要 viewport 为 `0x0` 或桌面窗口不可见，报告为“终端页面 target 已加载，桌面可见确认未完成”，不要声称完整 UI 验收通过。

## 禁止使用

- 不要指导 agent 把这些底层命令作为常规桌面端更新流程：
  - `pnpm publish:electron:local-updates`
  - `pnpm serve:electron:local-updates`
  - `pnpm electron:local-update`
- 不要要求用户指定 checkout、repo 路径或工作目录；此 skill 默认就在当前项目内执行。
- 不要拉取、切换或更新源码分支；此 skill 只负责用当前项目内容更新本地桌面客户端。
- 除非统一更新器失败且用户批准修复路径，否则不要手动删除、替换或编辑 `/Applications/Runweave.app`。
- 执行桌面端更新时，不要编辑更新脚本、Electron 配置或 App 代码；除非用户明确要求修复更新器本身。

## 验证

- 如果改动了 skill 或更新器代码，运行 `pnpm runweave:update:test-cases`。
- 如果是实际桌面端更新请求，报告 dry-run 计划、实际执行模式、最终安装的 App 路径和版本、最终启动方式、是否遇到污染环境或无窗口问题、是否已进入终端页面，以及桌面 UI 验证是否使用了 `computer-use`。
