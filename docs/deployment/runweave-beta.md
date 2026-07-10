# Runweave Beta 本机自举通道

Runweave Beta 是本机开发通道。正式版 Runweave 继续承载终端和开发上下文；Beta 使用独立 App、Electron userData、backend profile、Desktop Runtime、App Server 和更新状态，可被单独更新、重启与回滚。

## 命令

从目标源码 worktree 执行：

```bash
pnpm runweave:beta:update
pnpm runweave:beta:update --dry-run
pnpm runweave:beta:status --json
pnpm runweave:beta:rollback
pnpm runweave:beta:verify
```

`update` 复用正式版更新器的三组件判断：frontend/backend 运行时代码进入 Desktop Runtime，Electron shell 或构建配置触发完整 App，App Server 相关路径单独触发 App Server 更新。首次部署没有基线时会安装完整 Beta App 和 Beta App Server。

每次成功更新会记录当前 dirty/untracked 文件的内容摘要。下一次执行时，仍未提交但内容未变化的文件视为已经部署；只有提交差异、内容新增、修改、删除或权限变化才重新进入组件选择。

`--dry-run` 只读取源码、安装版本和已有状态，不构建、不安装、不退出进程、不写更新状态。

`status --json` 返回 Beta source、Desktop、backend、App Server、CDP、上一版本和最近失败摘要；输出使用允许字段列表，不包含登录凭据、App Server 凭据或请求认证信息。

`rollback` 恢复最近一次更新前记录的 Beta App、Runtime 和 App Server 指针，并等待 Beta Desktop、backend、CDP 以及已有 App Server 恢复健康。没有上一可用版本时返回非零状态。

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

正式版的 `pnpm runweave:update`、全局 hook 和 CLI 默认路径保持不变。在 Beta terminal 中直接执行正式更新命令时，更新器会清除 Beta-scoped 环境并固定使用 Stable App、runtime、App Server 和 state；只有 `pnpm runweave:beta:update` 会设置显式 Beta target。

## 验证

配置与结构门禁：

```bash
pnpm runweave:beta:verify
pnpm runweave:update:test-cases
pnpm --filter @runweave/electron typecheck
pnpm --filter @runweave/frontend typecheck
pnpm lint
git diff --check
```

这些命令不能代替真实行为验收。完整验收按 `docs/testing/runweave-beta-self-hosting-test-cases.md` 执行：桌面并存、退出与恢复使用 `$computer-use`，Beta 页面、构建标识与 CDP 使用 `$playwright-cli`。

更新日志位于 `~/Library/Application Support/Runweave Beta/update/logs/`。失败摘要和对应日志路径会出现在 Beta status 中。
