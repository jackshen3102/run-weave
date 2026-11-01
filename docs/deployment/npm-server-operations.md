# NPM Server 发布与服务器升级

面向维护独立服务端的 Agent。命令行为以 [Server CLI](../cli/server-cli.md) 为准；
本文记录发行步骤和已部署机器的运维约定。先识别安装来源，再选择更新流程。
NPM 部署使用 `rw server update`；仍采用源码或独立 Backend 包的机器使用
[原部署流程](./backend-standalone.md)，不因更新而隐式迁移。

## 构建、发布、升级是三个阶段

1. **构建验证**：固定源码提交及版本，在目标平台构建并验证 tarball。
2. **发布 npm**：将验证过的同一份 tarball 上传 registry，核对版本、摘要和 dist-tag。
3. **升级机器**：目标机器下载已发布版本，由 `rw server update` 激活并验证运行。

`npm pack` 不要求 npm 登录。手动 `npm publish` 的浏览器身份验证属于发布认证，
不属于打包验证或产品网页验收。服务器安装公开包也不需要发布者身份。

### 自动发行入口

[server-release.yml](../../.github/workflows/server-release.yml) 负责完整发行：
四个平台构建与本地安装/自更新验证 → OIDC 发布六个包到 `next` → 四个平台从公共
registry 安装并验证原生运行时、服务和登录 → 提升到请求的 dist-tag。
只做构建的手动触发不会发布；没有通过全部安装验证时不提升 `latest`。

完整发行同时使用 Server 和 CLI 两个精确版本。修改
`packages/runweave-server/package.json`、`packages/runweave-cli/package.json`，
选择尚未发布的新版本，将改动合并到 `main` 后推送匹配 Server 版本的标签：

```bash
git fetch origin main
git tag server-vX.Y.Z origin/main
git push origin server-vX.Y.Z
```

标签必须与 Server package.json 的版本严格一致。该标签流程最终提升为 `latest`。
版本号仍由发布者按改动选择，CI 不会给每次普通提交自动递增版本或发包。
主包和四个平台包版本相同，CLI 版本独立；这条整套发行流程要求两个版本均更新，
不复用已经由另一份构建发布的 CLI 版本。

也可以在 `main` 手动触发，选择发布到 `next` 先验收：

```bash
# 构建和验证，不发布
gh workflow run server-release.yml --repo jackshen3102/run-weave --ref main
# 完整发布到 next（channel=latest 时安装验证通过后提升到 latest）
gh workflow run server-release.yml --repo jackshen3102/run-weave --ref main \
  -f publish=true -f channel=next
gh run list --repo jackshen3102/run-weave --workflow server-release.yml --limit 5
gh run view <run-id> --repo jackshen3102/run-weave
```

Agent 要记录 run ID、head SHA、六个包版本和最终回执。
`npm-server-<platform>` 是各平台构建产物，`npm-release-receipt` 记录发布阶段，
`npm-release-final-receipt` 的 `phase=complete` 表示发布及标签核对完成。
平台包先于主包发布；公共主包及 CLI 只取 Linux x64 job 的一份已验证产物。
CLI 包须包含原生锁依赖及四个平台 prebuild；`npm pack` 从生成的包目录运行。

发布脚本 [publish-server.mjs](../../scripts/release/publish-server.mjs) 在发布前核对全套
版本、sourceRevision、repository、原生依赖及 SHA-512，发布后重新下载核对摘要。
同版本只有字节完全相同才允许跳过并继续。新发布的包先进入 `next`；中间失败可能留下部分包，
不等于正式发行成功。

失败时先读日志和回执，解决原因后优先 **Re-run failed jobs**，复用本次已验证的 artifacts。
重新运行全部构建可能产生不同字节；若旧版本已发布，不能覆盖，应使用新版本重新发行。
不通过删除已有版本、关闭鉴权或强改摘要绕过冲突。

### 一次性可信发布配置

六个包分别设置 npm Trusted Publisher：`@runweave/cli`、`@runweave/server` 和
`server-darwin-arm64`、`server-darwin-x64`、`server-linux-arm64`、`server-linux-x64`
（平台包均在 `@runweave` scope）。绑定值：

| 字段 | 值 |
| --- | --- |
| Provider | GitHub Actions |
| Organization or user | `jackshen3102` |
| Repository | `run-weave` |
| Workflow filename | `server-release.yml` |
| Environment | `npm-release` |
| Allowed actions | `npm publish`、`npm dist-tag` |

GitHub `npm-release` environment 只允许 `main` 分支和 `server-v*` 标签部署。
发布和提升标签的 job 使用 GitHub-hosted runner、`id-token: write`、Node 22.23.2 与
npm 12.2.1，不配置长期 `NPM_TOKEN` / `NODE_AUTH_TOKEN`；生成包的 repository 指向同一 GitHub 仓库。

首次创建包及绑定信任关系需要维护者认证。新包先完成首次发布才能建立信任；不要用
临时空包替代正式平台产物。信任连接的 Pending validation 不能算已验证，必须完成一次真实 OIDC 发布。
接通后日常 CI 发布无需浏览器认证；配置变更时仍可能要求身份验证。
要求变化时复核 [npm 官方可信发布文档](https://docs.npmjs.com/trusted-publishers/)。

包的真实安装验收入口为 [registry.mjs](../../scripts/verify/server/registry.mjs)，隔离 HOME、
临时端口和 npm prefix，不修改 devbox 的生产服务。产品 UI 验收仍按改动范围执行，
不能被包安装验证或发布认证代替。自动发布也不代表服务器已自动部署；目标机器仍按下文更新。

## Devbox 10.37.224.230

以下为 2026-11-01 迁移后的安装约定，执行前复核实际路径和状态，不能套用到其他 devbox。

| 项目 | 值 |
| --- | --- |
| SSH 目标 | `10.37.224.230`，使用本机已有 SSH 配置 |
| 服务用户 / HOME | `root` / `/var/lib/runweave` |
| 实例 / 配置根 | `stable` / `/var/lib/runweave/.runweave` |
| 统一 CLI 入口 | `/usr/local/bin/rw`，指向保留实例 HOME、PATH 和配置根的 wrapper |
| npm prefix | `/opt/runweave-npm`，realpath `/data00/runweave-npm` |
| Node | `/opt/runweave-node/node-v22.23.2-linux-x64/bin/node` |
| systemd | `runweave-server-backend.service`、`runweave-server-app-server.service` |
| HTTP 地址 | `http://10.37.224.230:5001` |
| 包定位记录 | `/var/lib/runweave/.runweave/server/installation.json` |

服务 HOME 下的 `.npmrc` 仅将 `@runweave` scope 指向官方 npm registry，保留其他包的原 registry。
服务 drop-in 保留 HOME/WorkingDirectory；Backend 还沿用 `/etc/runweave/backend-network.env`。
保留这些设置及原数据目录、Agent 登录态，不在 `/root` 下初始化另一套实例。
旧 `runweave-backend`、`runweave-app-server` unit 已停用，日常更新不重新启用它们。
独立 `runweave-feishu-bridge` Hub 不随 Server 包更新，不能顺带重启。

### 日常升级 Server

```bash
ssh 10.37.224.230
sudo /usr/local/bin/rw server status --json
sudo /usr/local/bin/rw server doctor --json

# 两种更新方式择一；正式部署优先记录并使用已核验的精确版本
sudo /usr/local/bin/rw server update --version X.Y.Z
# 或跟随 npm latest
sudo /usr/local/bin/rw server update

sudo /usr/local/bin/rw server status --json
sudo /usr/local/bin/rw server doctor --json
sudo systemctl show runweave-server-backend runweave-server-app-server \
  -p ActiveState -p SubState -p MainPID -p NRestarts -p UnitFileState
```

更新前保存版本、配置与 unit/drop-in、发布指针和项目/终端/tmux 基线；数据库使用一致性备份。
更新会短暂中断 HTTP/WS；遇到 `SERVER_TASKS_ACTIVE` 等任务完成再试，不默认加 `--force`。
兼容性拒绝不能靠 force 绕过。停止态更新后仍保持停止，不把安装成功当成服务启动。

更新后确认 installed/active/running 都是目标版本且 healthy，并验证登录、项目和终端读取，
对比 tmux pane/任务 PID。只看到 `/health` 200 不能宣称用户登录或网页交互正常。
保留用户报告的未解决登录问题；没有在用户入口复现和复测时，不把服务健康写成问题已修复。
开机自启配置与整机重启验收分别报告，不为日常升级重启整台机器。

### CLI 单独升级

`server update` 不更新 `@runweave/cli`。先核对候选 npm 版本与 Server 管理协议兼容性，
再在同一 prefix 安装。不要用普通登录用户的裸 `npm install -g` 创建另一份 rw。

```bash
# X.Y.Z 替换为已核验的 CLI npm 版本；此命令不安装 Server
sudo env HOME=/var/lib/runweave \
  PATH=/opt/runweave-node/node-v22.23.2-linux-x64/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  /opt/runweave-node/node-v22.23.2-linux-x64/bin/npm install -g \
  --prefix /opt/runweave-npm --registry https://registry.npmjs.org/ @runweave/cli@X.Y.Z
sudo /usr/local/bin/rw version --json
sudo /usr/local/bin/rw server status --json
```

核对 prefix 内 CLI `package.json` 的 npm 版本及 wrapper 实际指向；`rw version` 的源码版本
不一定等于 npm 包版本。迁移使用 CLI npm 0.10.1 修复 Linux systemd 路径和 HOME，
当时它只发布到 `next`，不要未经核对就用旧 `latest` 覆盖该修复。

### 失败诊断与恢复

```bash
sudo /usr/local/bin/rw server logs
sudo /usr/local/bin/rw server status --json
```

检查 `/var/lib/runweave/.runweave/server/update.json` 的失败阶段；更新不会自动回退。
根据实际安装、active 指针和进程状态继续修复。需回退时先确认配置和数据兼容性，再使用
`server update --version <兼容旧版本>`，不直接覆盖数据库或手动抢占 App Server 锁。
迁移时的恢复材料保存在 `/var/backups/runweave-npm-migration-20261101/`，
该目录不代表后续每次更新的最新备份；操作前应建立本次备份。
