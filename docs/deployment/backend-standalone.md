# 旧源码部署迁移到 npm

纯服务端的源码升级方式已淘汰。本文仅用于把旧源码或独立 Backend 发布包部署迁移到
`@runweave/cli` + `@runweave/server`；完成后统一使用 [npm 升级流程](./npm-server-operations.md)。
不再在目标服务器拉源码、编译 Backend 或运行独立组件安装器升级。
本地 Mac 桌面端仍保留[源码更新](./electron-local-updates.md)，CI 继续从源码构建 npm 发行包。

## 迁移前

1. 通过独立 SSH 确认主机、服务用户、HOME、实例、配置根、数据目录、Node、npm prefix、
   原 Backend/App Server owner 和持久托管方式。记录实际 unit、入口与环境来源，过滤凭据。
   SSH 登录用户不一定是服务用户，不能换 HOME 后创建另一套 Stable。
2. 固定已经公开验证的 CLI 与 Server 精确版本，核对平台包、Node 22、架构及 glibc。
   平台不支持或配置/数据不能兼容时先解决发行问题，不回退到源码日常升级。
3. 保存原 unit/drop-in、程序与发布指针、配置、认证、Backend 身份、Agent 登录态、Activity 密钥。
   数据库采用一致性备份；记录项目/终端 ID、tmux socket/pane 与任务 PID。
   原仓库和本地修改保留，待新部署稳定后另行处理，不在迁移中删除。
4. 确认旧 Backend 实际运行策略为 `terminal.tmux.shutdownPolicy=preserve`，systemd 保留
   `KillMode=process`。仅修改配置无法改变旧进程的内存策略；不能证明保活时先排空任务。
   保留短暂 HTTP/WS 中断预期和恢复通道，不通过待停止的服务执行唯一控制会话。

## 准备与切换

命令合同见 [Server CLI](../cli/server-cli.md)。下列占位符须替换为已经核对的值，
所有命令保持原服务用户、HOME、Node PATH 和实例；不要直接复制其他机器的 root/prefix。

```bash
npm install -g --prefix <原服务的npm-prefix> --registry https://registry.npmjs.org/ \
  @runweave/cli@<精确CLI版本> @runweave/server@<精确Server版本>
```

- 安装公开包不等于接管运行服务。先验证新 CLI 的实际路径、包版本与帮助，保护实例 wrapper，
  核对配置可由候选版本读取；不要让 PATH 中另一份 rw 操作错误实例。
- 准备持久托管配置及恢复材料后，按原 owner 停止旧 Backend 和 App Server。
  核对实际 PID、锁和进程退出；不要删锁、杀端口占用者或仅凭 stop 回执认定接管完成。
  只有已经确认的旧 owner 可以停止；不能误停同机的其他实例或独立 Hub。
- 若已有 `rw server` 安装记录但指向源码产物，使用同实例
  `rw server update --version <精确Server版本>` 切换到 npm，不手动改 installation/current。
- 若尚未采用 `rw server` 管理，在同一配置根运行 `rw server init`，复用原 Stable 配置、认证与数据；
  先检查现有配置，不能重置密码或用新初始化替代迁移。非交互缺失认证时按 CLI 帮助提供私有 auth file。
- 执行 `rw server doctor --json`。生成 `rw server service install --dry-run`，
  核对服务用户、HOME、Node、实例路径、端口及必需环境文件/drop-in；注册命令会启动服务。
  确认旧 owner 已退出后再执行 `rw server service install`。已有其他 supervisor 时审查并更新其 npm 入口，
  不额外注册第二套 systemd/launchd owner。
- 旧源码 unit 停用且不再自启；保留恢复材料。新 unit 启动前确保必要 drop-in 已生效，
  不能因生成 unit 缺失原网络/认证环境就丢弃这些配置。默认生成配置不等于适配了该机器。

## 验证与恢复

核对 npm installed/active/running 精确版本、sourceRevision、两个组件 PID 与实际 supervisor，
检查健康、日志和重启次数。用已有合法凭据完成认证业务请求，核对项目/终端、数据路径及 tmux 保活。
用户入口的登录问题仍须在相同入口复测；API 验证不能代替网页交互验收。
核对持久自启，未执行整机重启就明确说明，不为迁移默认重启整台机器。

失败时先读取实际安装、指针、unit 和 owner 状态，停止后续切换。优先修复 npm 部署；
确需恢复旧部署时，先确认数据/配置向后兼容、停止新 owner，再恢复备份的旧入口与 unit。
这属于本次迁移恢复，不恢复源码日常升级路线。不得让新旧服务同时占用实例，
不自动用旧数据库覆盖迁移后的写入。验证通过后交接为 npm 管理，日后只走 `rw server update`。
