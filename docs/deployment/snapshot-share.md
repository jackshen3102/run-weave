# 公网终端快照托管

本机 Backend 捕获静态终端文本，通过 HTTPS 上传到公网快照 Host。Host 保存内容、生成独立签名，
接收者直接访问 Host；上传成功后源电脑离线不影响读取。内容仍固定 24 小时有效，不实时同步。

Host 是同一仓库后端代码的独立入口，不启动 tmux、终端控制面或 App Server。可与现有 Web Backend
共用 AWS 主机和 Nginx，独立升级，不需要重启承载终端任务的 Backend。

## 部署 Host

1. 给分享域名配置指向服务器的 A 记录；使用 HTTPS，服务器仅公开 Nginx 的 80/443。
2. 在已有依赖的仓库运行 `node deploy/snapshot-share/build.mjs`，把生成的
   `deploy/snapshot-share/dist/host.cjs` 安装到服务器 `/opt/runweave-snapshot-share/host.cjs`。
   产物包含依赖，服务器只需要 Node 22+，不依赖运行中的 Web 仓库或其 node_modules。
3. 创建独立系统用户 `runweave-share`。按
   [环境变量模板](../../deploy/snapshot-share/host.env.example) 写入
   `/etc/runweave/snapshot-share.env`，权限 `0600`，owner root。
   用 `openssl rand -hex 32` 生成专用上传凭据，不复用登录 JWT、SSH 私钥或快照签名密钥。
4. 安装 [systemd unit](../../deploy/snapshot-share/runweave-snapshot-share.service)，根据实际安装位置调整
   `ExecStart` 的 Node 路径。启动 `runweave-snapshot-share`；本机
   `http://127.0.0.1:8093/health` 应返回 `{"ok":true}`。
5. 先配置 80 端口 ACME webroot `/var/www/runweave-share-acme`，取得域名证书后，按
   [Nginx 模板](../../deploy/snapshot-share/nginx.conf.example) 启用 HTTPS。
   `nginx -t` 通过后 reload；仅向分享 Host 转发读取和上传路径，不代理原 Backend 控制面。
   配置证书续期成功后的 Nginx reload hook。

Host 默认只监听 `127.0.0.1:8093`。一份持久化目录只能运行一个 Host；systemd 负责进程单实例。
数据和独立签名密钥保存在 `RUNWEAVE_SNAPSHOT_HOST_DIR`，备份/迁移必须保留整个目录。
沿用全 Host 最多 100 份、合计 100 MiB、单份正文 10 MiB 配额，每分钟清理过期内容；读取到期即时失效。
上传 JSON 允许转义膨胀，但最终按 UTF-8 正文大小校验；最多四个并发上传请求。

## 配置发送端 Backend

在**实际捕获终端的 Backend 进程**配置以下变量，升级本次前后端代码后生效：

```dotenv
RUNWEAVE_SNAPSHOT_PUBLISH_URL=https://share.example.com
RUNWEAVE_SNAPSHOT_PUBLISH_TOKEN=<与 Host 上传凭据一致>
```

地址必须是 HTTPS origin，不接受子路径、userinfo、query 或 fragment。只配置一项、错误地址或无效
凭据格式会阻止 Backend 初始化，避免误生成内网分享链接。凭据只放在 Backend 环境中，不进入前端、
URL 或 Git；Electron 用户需把变量传给其内置 Backend，不能只设置 Web 构建变量。

所有业务 Backend（包括与 Host 同机的 AWS Backend）均只捕获并上传，不创建快照目录或签名密钥。
两项都不配置时分享返回 `SNAPSHOT_PUBLISH_NOT_CONFIGURED`（503），其他 Backend 功能仍可使用。
所有新分享均等待 Host 成功持久化；上传失败返回
`SNAPSHOT_PUBLISH_FAILED`（502），不自动退回内网链接、不自动重试创建。超时可能已在 Host 留下快照，
后续手动重试会产生新快照，未返回的记录按原有效期清理。
不兼容或迁移旧的本地分享链接。

### macOS 登录环境加载脚本

已有 LaunchAgent 使用 `~/.runweave/snapshot-share/load-environment.py` 时，从仓库更新脚本：

```bash
install -m 700 deploy/snapshot-share/load-environment.py "$HOME/.runweave/snapshot-share/load-environment.py"
```

脚本由 `/usr/bin/python3` 执行，读取同目录的 `publish.env`（凭据文件保持 `0600`）。
使用不带引号的 `KEY=VALUE`，支持空行、整行 `#` 注释和等号两侧空白；不执行 shell 展开。
写入前先解析整个文件并检查两项配置均非空，格式错误不会提前写入其中一项；空配置不写入或清除
现有环境。`launchctl` 的两次写入本身不是事务，命令执行失败仍可能留下部分更新，需修复后重跑。
此脚本只设置 GUI 环境，不更新已运行进程；它执行成功不能代替实际 Backend 的配置和分享验收。

## 接口和验证

- `POST /api/snapshot-shares`：专用 bearer 认证；JSON `{title, text}`，成功返回 201 和既有
  `PublishTerminalSnapshotResponse`。Host 不接收任意 HTML，也不接收源机器的签名密钥。
- 源 Backend 创建接口必须返回 `shareUrl`，由配置的公网 origin 加 Host 返回的合法签名路径构成；
  前端只使用此 HTTPS URL，缺失或非法链接直接拒绝，不推导本地或局域网地址。
- `GET/HEAD /share/terminal/...`：沿用[快照分享合同](../cli/terminal-snapshot-share.md)的签名校验、
  no-store、HTML 转义、CSP 和行号引用；不要求登录，不允许终端控制。
- 上传缺凭据/错误凭据应为 401；畸形请求 400；超限 413；并发满 429；存储满 507。
  无效/过期分享、未知路径应为 404，不返回 SPA 或登录页。
- 验证发布、匿名读取、签名篡改、Host 重启后读取、源进程退出后读取，并在浏览器验证页面与选行。
  真实正文不得用于部署烟测，使用专门的无敏感内容 fixture。

回滚 Host 仅替换 `/opt/runweave-snapshot-share/host.cjs` 并重启独立服务，保留数据目录和凭据。
发送端升级需同步发布前后端，使用最新的 `shareUrl` 合同；不实现旧版本兼容。
