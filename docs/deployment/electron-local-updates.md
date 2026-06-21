# Electron 本地自动更新

本文记录个人 macOS 环境中通过本地 update feed 更新 Runweave Electron 客户端的运行方式。它不是项目默认发布流程，也不把更新时间写入项目代码；定时触发由本机 `launchd` 负责，项目只提供可被外部任务调用的更新能力。

## 目标

- 每天由外部调度器重新打包 macOS 客户端。
- 将更新产物发布到本机 HTTP feed。
- 用新打包出的 `.app` 替换 `/Applications/Runweave.app`，然后重新打开客户端。
- 浏览器或终端窗口不需要保持打开；本地 feed server 由后台任务常驻。

## 项目能力

项目侧保留三个命令：

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

## 本机 launchd 任务

当前本机使用两个用户级 LaunchAgent：

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
