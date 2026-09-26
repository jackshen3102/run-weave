# 公网终端快照托管

本机 Backend 捕获静态终端文本，通过 HTTPS 上传到公网快照 Host。Host 保存内容、生成独立签名，
接收者直接访问 Host；上传成功后源电脑离线不影响读取。内容仍固定 24 小时有效，不实时同步。

Host 是同一仓库后端代码的独立入口，不启动 tmux、终端控制面或 App Server。可与现有 Web Backend
共用 AWS 主机和 Nginx，独立升级，不需要重启承载终端任务的 Backend。

## 部署 Host

1. 给分享域名配置指向服务器的 A 记录；使用 HTTPS，服务器仅公开 Nginx 的 80/443。
2. 在已有依赖的仓库运行 `node deploy/snapshot-share/build.mjs`，把生成的
   `deploy/snapshot-share/dist/` 整个目录安装到服务器 `/opt/runweave-snapshot-share/`。
   必须包含相邻的原生锁 node_modules；在目标 OS/架构构建，服务器使用 Node 22+。
3. 创建独立系统用户 `runweave-share`，其系统账户 home 必须为 `/var/lib/runweave-snapshot-share`。
   根据 [YAML 模板](../../deploy/snapshot-share/settings.example.yaml) 创建
   `/var/lib/runweave-snapshot-share/.runweave/settings.yaml`，目录 `0700`、文件 `0600`，
   owner 均为 `runweave-share`。用独立随机值替换上传凭据占位，不复用登录或签名密钥。
4. 安装 [systemd unit](../../deploy/snapshot-share/runweave-snapshot-share.service)，根据实际安装位置调整
   `ExecStart` 的 Node 路径。启动 `runweave-snapshot-share`；本机
   `http://127.0.0.1:8093/health` 应返回 `{"ok":true}`。
5. 先配置 80 端口 ACME webroot `/var/www/runweave-share-acme`，取得域名证书后，按
   [Nginx 模板](../../deploy/snapshot-share/nginx.conf.example) 启用 HTTPS。
   `nginx -t` 通过后 reload；仅向分享 Host 转发读取和上传路径，不代理原 Backend 控制面。
   配置证书续期成功后的 Nginx reload hook。

Host 默认只监听 `127.0.0.1:8093`。一份持久化目录只能运行一个 Host；systemd 负责进程单实例。
数据和独立签名密钥保存在 `services.snapshotHost.directory`，备份/迁移必须保留整个目录。
沿用全 Host 最多 100 份、合计 100 MiB、单份正文 10 MiB 配额，每分钟清理过期内容；读取到期即时失效。
上传 JSON 允许转义膨胀，但最终按 UTF-8 正文大小校验；最多四个并发上传请求。

## 配置发送端 Backend

在实际捕获终端的 Backend 所属实例 `settings.yaml` 中配置：

```yaml
services:
  snapshotPublisher:
    url: https://share.example.com
    token: REPLACE_WITH_HOST_UPLOAD_TOKEN
```

地址必须是 HTTPS origin，不接受子路径、userinfo、query 或 fragment。密钥为 32～256 位
字母、数字、下划线或连字符。使用 `rw config validate --instance stable` 检查后，通过
当前 Backend 的配置入口或 `rw config reload --instance stable` 加载。错误只隔离分享域，
状态明确报告 error；reload 失败保留旧运行快照。文件及备份为私有，公开接口不返回密钥。

所有业务 Backend（包括与 Host 同机的 AWS Backend）均只捕获并上传，不创建快照目录或签名密钥。
两项都不配置时分享返回 `SNAPSHOT_PUBLISH_NOT_CONFIGURED`（503），其他 Backend 功能仍可使用。
所有新分享均等待 Host 成功持久化；上传失败返回
`SNAPSHOT_PUBLISH_FAILED`（502），不自动退回内网链接、不自动重试创建。超时可能已在 Host 留下快照，
后续手动重试会产生新快照，未返回的记录按原有效期清理。
不兼容或迁移旧的本地分享链接。

### 从旧 macOS 启动补丁迁移

新版直接读取所属实例 YAML，不依赖 launchctl 的业务环境。
`~/.runweave/snapshot-share/publish.env` 仅作为 `rw config migrate --dry-run` 的显式来源。
核对迁移结果、验证新 Backend 实际发布成功后，再按原 LaunchAgent 的准确 label 停用旧
`load-environment.py` 补丁；不全局清除其他进程环境，不用补丁执行成功代替分享验收。

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

回滚 Host 必须使用支持当前 YAML 版本的完整产物目录（含原生锁依赖），重启独立服务并保留数据目录和配置。
发送端升级需同步发布前后端，使用最新的 `shareUrl` 合同；不实现旧版本兼容。
