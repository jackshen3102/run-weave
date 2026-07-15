# Electron 本地自动更新

本文记录个人 macOS 环境中通过本地 update feed 更新 Runweave Electron 客户端的运行方式。它不是项目默认发布流程，也不把更新时间写入项目代码；定时触发由本机 `launchd` 负责，项目只提供可被外部任务调用的更新能力。

## 目标

- 每天由外部调度器重新打包 macOS 客户端。
- 将更新产物发布到本机 HTTP feed。
- 用新打包出的 `.app` 替换 `/Applications/Runweave.app`，然后重新打开客户端。
- 浏览器或终端窗口不需要保持打开；本地 feed server 由后台任务常驻。

## 项目能力

本文所有命令和路径均属于正式（Stable）通道。开发中的独立 Beta 通道使用 `pnpm runweave:beta:update`，不会替换或重启 `/Applications/Runweave.app`；详见 [Runweave Beta 本机自举通道](./runweave-beta.md)。

即使从 Beta terminal 执行 `pnpm runweave:update`，正式入口也会忽略 Beta-scoped runtime、App Server、CLI 和更新状态环境，继续使用 Stable 默认路径。

项目侧推荐使用一个统一入口：

```bash
pnpm runweave:update
```

该命令可以从任意 worktree 执行。默认 `auto` 模式会读取上一次本地更新状态：

- 若只涉及前端、后端 bundle 或共享 runtime 合约，构建并安装 runtime 包，然后重启客户端加载新 runtime。
- 若涉及 Electron 主进程、preload、菜单/托盘/updater、resources、builder 配置或本地更新脚本，重新打包 `.app`，替换 `/Applications/Runweave.app`，再重新打开。
- 首次没有本地更新状态时，为避免漏掉 Electron shell 变更，默认选择完整 app 更新。

可选参数：

```bash
pnpm runweave:update --mode runtime
pnpm runweave:update --mode app
pnpm runweave:update --repo /Users/bytedance/Code/browser-hub/feature
pnpm runweave:update --dry-run
pnpm runweave:update --verify-desktop
```

`--verify-desktop` 会在升级后用干净环境启动安装态 App，写入 `~/Library/Application Support/RunweaveLocalUpdate/desktop-verification.json`，并在 App 路径、PID、版本、窗口可见性与 Electron 主 renderer CDP target 完成握手后输出 `desktop verification ready` JSON。页面验收必须显式附着该 JSON 的 `endpoint`；不要把默认端口或 Terminal Browser 的 `9224` proxy 当作主窗口入口。该参数不能与 `--no-restart` 组合。

完整 app 更新会优先使用 `RUNWEAVE_CODESIGN_IDENTITY` 环境变量。未显式配置时，会读取 `backend/.env` 中的 `RUNWEAVE_CODESIGN_IDENTITY`；若该配置为空或身份已不可用，会自动选择本机钥匙串里的第一个可用 codesigning identity，并写回 `backend/.env`。找不到可用身份时才回退到 ad-hoc。若要减少 macOS TCC 在 Desktop/Documents 等受保护目录上的重复授权，可以显式固定签名身份：

```bash
RUNWEAVE_CODESIGN_IDENTITY="Apple Development: ..." pnpm runweave:update --mode app
```

测试用例见 `docs/testing/runweave-local-client-update-test-cases.md`。

项目侧仍保留三个底层命令：

```bash
pnpm publish:electron:local-updates
pnpm serve:electron:local-updates
pnpm electron:local-update
```

职责分别是：

- `publish:electron:local-updates`：打包 local-updates 版本，并把 `latest-mac.yml`、`.zip`、`.dmg`、`.blockmap` 复制到 `.local-updates/updates/mac/`。
- `serve:electron:local-updates`：从当前工作目录的 `.local-updates` 启动本地静态服务，默认监听 `http://127.0.0.1:5500/`。
- `electron:local-update`：执行一次“发布本地更新产物 → 检查 feed 是否可访问 → 退出 Runweave → 用新构建的 `electron/release/mac-arm64/Runweave.app` 替换 `/Applications/Runweave.app` → 重新打开并验证进程已启动”。

客户端更新 feed 默认地址：

```text
http://127.0.0.1:5500/updates/mac/latest-mac.yml
```

本地 feed server 必须在客户端检查和下载更新时可访问；浏览器页面是否打开不影响服务状态。

## 可选 launchd 任务

如需让本机后台自动更新，可安装两个用户级 LaunchAgent：

| Label                               | 作用                                                 |
| ----------------------------------- | ---------------------------------------------------- |
| `com.runweave.local-updates.server` | 登录后启动并常驻 `pnpm serve:electron:local-updates` |
| `com.runweave.daily-local-update`   | 每天 22:00 执行 `pnpm electron:local-update`         |

plist 位置：

```text
~/Library/LaunchAgents/com.runweave.local-updates.server.plist
~/Library/LaunchAgents/com.runweave.daily-local-update.plist
```

日志位置：

```text
~/Library/Logs/RunweaveLocalUpdate/server.out.log
~/Library/Logs/RunweaveLocalUpdate/server.err.log
~/Library/Logs/RunweaveLocalUpdate/update.out.log
~/Library/Logs/RunweaveLocalUpdate/update.err.log
```

本机任务固定在仓库目录 `/Users/jackshen/code/run-weave` 下运行。若仓库迁移、Node/pnpm 路径变化，需同步更新 plist 中的 `WorkingDirectory`、`PATH` 和命令路径。

当前如果不需要自动更新，可以不安装这些 plist；`pnpm electron:local-update` 仍可手动执行。

## 验证

确认本地 feed server 正在运行：

```bash
launchctl print gui/$(id -u)/com.runweave.local-updates.server
lsof -nP -iTCP:5500 -sTCP:LISTEN
```

确认 feed 可访问：

```bash
curl -fsS http://127.0.0.1:5500/updates/mac/latest-mac.yml
```

确认 server 使用的是当前仓库目录：

```bash
lsof -nP -iTCP:5500 -sTCP:LISTEN
lsof -p <server-pid> | grep ' cwd '
```

期望 cwd 为：

```text
/Users/jackshen/code/run-weave
```

确认 Runweave 从 `/Applications` 运行：

```bash
ps -axo pid,ppid,stat,lstart,command | grep '[R]unweave'
```

期望主进程路径类似：

```text
/Applications/Runweave.app/Contents/MacOS/Runweave
```

如果路径是 `/Volumes/Runweave .../Runweave.app`，说明仍在运行 DMG 挂载卷里的客户端。先退出旧进程并从 `/Applications` 打开：

```bash
osascript -e 'tell application "Runweave" to quit'
open /Applications/Runweave.app
```

## 常见问题

### `latest-mac.yml` 返回 404

通常是 `serve:electron:local-updates` 在错误的工作目录中启动。该服务只读取其启动目录下的 `.local-updates`。

检查：

```bash
lsof -nP -iTCP:5500 -sTCP:LISTEN
lsof -p <server-pid> | grep ' cwd '
```

如果 cwd 不是 `/Users/jackshen/code/run-weave`，停止错误进程并重启 LaunchAgent：

```bash
kill <server-pid>
launchctl kickstart -k gui/$(id -u)/com.runweave.local-updates.server
```

### 仍然运行旧版本

macOS 会优先激活同一 bundle id 的既有实例。Runweave 主窗口关闭时会隐藏到后台，不等同于退出。确认没有旧版 DMG 进程残留：

```bash
ps -axo pid,ppid,stat,lstart,command | grep '[R]unweave'
```

如仍在 `/Volumes/Runweave ...` 下运行，退出后再从 `/Applications` 打开。

### feed 版本比客户端版本新但未更新

当前本机定时任务不再依赖客户端自更新完成安装，而是由 `pnpm electron:local-update` 直接替换 `/Applications/Runweave.app`。如果 feed 版本比客户端版本新但客户端没有更新，优先检查 daily update 日志和 `/Applications/Runweave.app` 是否被替换。

当前客户端版本：

```bash
plutil -p /Applications/Runweave.app/Contents/Info.plist | grep CFBundleShortVersionString
```

feed 版本：

```bash
curl -fsS http://127.0.0.1:5500/updates/mac/latest-mac.yml | grep '^version:'
```

daily update 日志：

```bash
tail -n 200 ~/Library/Logs/RunweaveLocalUpdate/update.out.log
tail -n 200 ~/Library/Logs/RunweaveLocalUpdate/update.err.log
```

## 卸载本机定时任务

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.runweave.local-updates.server.plist
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.runweave.daily-local-update.plist
rm ~/Library/LaunchAgents/com.runweave.local-updates.server.plist
rm ~/Library/LaunchAgents/com.runweave.daily-local-update.plist
```

如需清理日志：

```bash
rm -rf ~/Library/Logs/RunweaveLocalUpdate
```
