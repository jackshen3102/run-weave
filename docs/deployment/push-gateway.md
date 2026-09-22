# 推送服务：AWS Lightsail + Docker Compose 部署

本文用于首次部署到 **Lightsail 单台 Linux 实例上的 Docker Compose**，命令以 **Ubuntu 24.04 LTS、普通登录用户 ubuntu** 为例。
如果现有实例使用其他系统，保留网络与服务配置步骤，按实际发行版调整安装命令；不要覆盖已有应用或磁盘。
环境变量、订阅授权和投递语义以[网关说明](../../packages/push-gateway/README.md)为准。

```text
Mac / 业务调用方 → https://push.example.com:443
                         ↓ Caddy
                  127.0.0.1:8092 → 网关容器 → Apple APNs → iPhone
                         ↓
                  /srv/runweave-push/data（SQLite）
```

采用与[随记](../../deploy/suiji/README.md)相同的管理方式：独立 Compose project、持久数据目录、
宿主机反向代理。容器只运行推送网关，与随记分开发布、重启和备份；可共用已有 Caddy 的 80/443。
网关使用 SQLite 与进程独占锁，当前只运行一个副本。本文不使用 Lightsail 托管容器服务，也不引入托管数据库。
云端不运行 Electron、Mac Backend 或 iOS 工程。
Mac 休眠、离线或 Backend 停止时，不会产生新的电量事件；云端网关不会代替 Mac 采集电量。

首次上线使用新的数据目录，并把 Mac Backend 与网关更新到同一代码版本。当前网关使用 schema 2，
不导入旧电量服务的试运行数据库，也不保留旧接口。Apple 密钥可在授权环境和 App ID 匹配时复用。

## 1. 准备 Lightsail 实例、静态 IP 和域名

在 Lightsail 控制台选择实例所在区域，使用 Linux/Unix → OS only → Ubuntu 24.04 LTS。
建议从 **2 GB 内存**的套餐起步；这是低流量服务的部署起点，未经容量压测。仓库安装、类型检查的
峰值内存可能高于运行时；若构建内存不足，在同架构 Linux 构建机生成发布目录后再传输。
优先选择含公网 IPv4 的 dual-stack 套餐，以便绑定静态 IPv4。

1. 在 **Networking → Create static IP** 创建静态 IP，选择同区域的目标实例并绑定。
   默认动态公网 IPv4 会随停止/重新启动改变，静态 IP 用来稳定域名指向。
   见 [Lightsail 静态 IP](https://docs.aws.amazon.com/lightsail/latest/userguide/lightsail-create-static-ip.html)。
2. 在域名当前的 DNS 服务商添加 `push.example.com` 的 **A 记录 → 静态 IPv4**。
   DNS 可以继续放在现有服务商，不必迁移到 Route 53 或 Lightsail。
   若使用 Lightsail DNS zone，须在域名注册商完成对应 NS 委派；见
   [Lightsail DNS 配置](https://docs.aws.amazon.com/lightsail/latest/userguide/lightsail-how-to-create-dns-entry.html)。
3. 首次部署只配置 A 记录。只有实际启用、放通并验证 IPv6 后才添加 AAAA，避免部分客户端走不可达地址。
4. 在实例 **Networking → IPv4 firewall** 配置下表；Lightsail 使用实例防火墙界面，不是 EC2 的 Security Groups。

| 入站端口 | 来源                                                          | 用途                         |
| -------- | ------------------------------------------------------------- | ---------------------------- |
| TCP 22   | 管理者当前公网 IP；需要时勾选 Allow Lightsail browser SSH/RDP | SSH 运维                     |
| TCP 80   | Any IPv4                                                      | Caddy 证书验证和 HTTPS 跳转  |
| TCP 443  | Any IPv4                                                      | Mac 与手机访问 HTTPS 网关    |
| TCP 8092 | 不添加规则                                                    | Docker 仅发布宿主机 loopback |

启用 IPv6 时单独检查 IPv6 firewall；两组规则互不替代。删去与目标限制冲突的宽泛 SSH 规则前，
先确认仍有可用管理入口。Lightsail 防火墙允许出站，且不限制实例私网流量；因此 8092 的宿主机 loopback 发布仍然必要。
如系统启用了 UFW，也需允许相应 SSH 与 80/443 入站，不能只修改控制台规则。
依据：[Lightsail 防火墙](https://docs.aws.amazon.com/lightsail/latest/userguide/understanding-firewall-and-port-mappings-in-amazon-lightsail.html)、
[SSH 来源与浏览器连接](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-editing-firewall-rules.html)。

## 2. 准备 Apple 凭据

使用与 App 签名相同的付费开发者团队，在 Apple Developer 的 Certificates, Identifiers & Profiles →
Keys 创建启用 Apple Push Notifications service 的密钥；授权范围需包含
`com.runweave.app.native` 和目标环境。记录 Key ID、Team ID，下载 `.p8` 并保存在仓库外。
Apple 私钥只可下载一次，应同时保存受保护的备份。
操作入口见 [Apple 创建私钥说明](https://developer.apple.com/help/account/keys/create-a-private-key)。

当前 Debug/Profile 真机构建使用 sandbox，Release 使用 production。开发者账号付费不会把
Debug 自动变成 production；以实际安装包的签名 entitlement 为准。

## 3. 安装 Docker 并构建镜像

服务器只需 Docker Engine、Compose 插件、Git 和宿主机 Caddy，无需在宿主机安装 Node、pnpm 或 SQLite。
按 [Docker 官方 Ubuntu 安装步骤](https://docs.docker.com/engine/install/ubuntu/)安装 Engine、Buildx 与 Compose，
确认以下命令成功。已用于随记的 Docker 可直接复用，不重复安装或重启其他服务。

```bash
sudo docker version
sudo docker compose version
sudo docker buildx version
```

把仓库通过现有只读 Git 授权放到 `/opt/runweave-push/repo`，检出经过验证的提交，记录完整 commit SHA。
仓库地址不含 token。以该提交的唯一 tag 构建，下面的 `release-001` 需替换为实际发布标识：

```bash
cd /opt/runweave-push/repo
sudo docker build -f deploy/push-gateway/Dockerfile -t runweave-push:release-001 .
sudo docker image inspect runweave-push:release-001 --format '{{.Id}}'
```

将输出的 `sha256:...` 记录为部署镜像 ID。也可以在构建机推送镜像到私有仓库，服务器 pull 后使用
`registry/image@sha256:...`；不要把可覆盖的 latest tag 作为发布身份。
构建机与服务器架构须匹配。Mac 构建供 x86_64 Lightsail 使用时，显式使用
`docker buildx build --platform linux/amd64 --load ...`，或在目标服务器构建。

镜像按[Dockerfile](../../deploy/push-gateway/Dockerfile)安装 Node 22、依赖并编译 Linux SQLite 原生模块；
仅复制 shared 和网关代码。专用 Dockerfile.dockerignore 限定上下文，不把私钥、本机配置或工作区资料送入构建。
当前入口使用 tsx，镜像打包时保留所需依赖。宿主机不复制 Mac node_modules。

## 4. 准备配置、持久目录并启动容器

部署文件在 [deploy/push-gateway](../../deploy/push-gateway/compose.yaml)。在仓库外创建数据和私有配置目录：

```bash
cd /opt/runweave-push/repo
sudo install -d -m 755 /srv/runweave-push
sudo install -d -m 700 -o 1000 -g 1000 /srv/runweave-push/data
sudo install -d -m 700 /srv/runweave-push/private
sudo cp deploy/push-gateway/deployment.env.example /srv/runweave-push/deployment.env
sudo chmod 600 /srv/runweave-push/deployment.env
```

镜像以 UID/GID **1000:1000** 运行。将 Apple `.p8` 安全上传并安装为
`/srv/runweave-push/private/apns.p8`，owner `1000:1000`、权限 `600`。
根据 [gateway.env.example](../../deploy/push-gateway/gateway.env.example)创建
`/srv/runweave-push/private/gateway.env`，同样 owner `1000:1000`、权限 `600`：

```dotenv
APNS_KEY_ID=YOUR_KEY_ID
APNS_TEAM_ID=YOUR_TEAM_ID
PUSH_GATEWAY_ADMIN_TOKEN=YOUR_RANDOM_ADMIN_TOKEN
```

管理员 token 使用独立高熵随机值，生成后直接存入受限文件；上传时的暂存副本也需保护并在安装后清理。
私钥和环境文件作为 Compose secrets 只读挂载到容器；Node 从文件加载环境，不把秘密写入镜像或 Compose 明文配置。
本地 Compose 的文件型 secret 使用 bind mount，因此必须设置宿主文件权限，不能依赖 secret 的 uid/gid 声明改属主。
见 [Compose secrets](https://docs.docker.com/compose/how-tos/use-secrets/)。

用 `sudoedit /srv/runweave-push/deployment.env` 填入镜像 ID 和真实绝对路径：

```dotenv
PUSH_GATEWAY_IMAGE=sha256:REPLACE_WITH_LOCAL_IMAGE_ID
PUSH_GATEWAY_HOST_PORT=8092
PUSH_GATEWAY_DATA_DIR=/srv/runweave-push/data
PUSH_GATEWAY_APNS_KEY_FILE=/srv/runweave-push/private/apns.p8
PUSH_GATEWAY_ENV_FILE=/srv/runweave-push/private/gateway.env
```

该文件只保存镜像引用和路径；不要加入 Apple 私钥内容或管理员 token。容器内部固定监听 0.0.0.0:8092，
Docker 只把它发布到宿主机 127.0.0.1:8092。SQLite 写入 `/data`，对应上述宿主持久目录。
根文件系统只读，临时缓存写入 tmpfs。不要更改镜像用户来绕过数据目录权限错误。

后续所有 Compose 命令都使用同一 project、env-file 和 compose 文件。以下 shell 函数仅为缩短命令，
新 SSH 会话需重新定义，并把仓库检出保持为对应发布版本：

```bash
push_compose() {
  sudo docker compose --project-name runweave-push \
    --env-file /srv/runweave-push/deployment.env \
    -f /opt/runweave-push/repo/deploy/push-gateway/compose.yaml "$@"
}
push_compose config --quiet
push_compose up -d --wait gateway
push_compose ps
curl --fail http://127.0.0.1:8092/health
```

Compose 配置 `restart: unless-stopped`；手动 stop 后需要显式 up/start 才恢复。
容器 healthcheck 失败本身不会触发 Docker 重启，需监控处理。
本服务直接调用 Apple，不需要配置 AWS access key、SNS 或 IAM 调用凭据。

## 5. 配置域名 HTTPS

Caddy 使用[官方 Ubuntu 安装方式](https://caddyserver.com/docs/install#debian-ubuntu-raspbian)；
若随记已使用同机 Caddy，直接添加站点并 reload，不另起一个占用 80/443 的代理。
这里假设 Caddy 在宿主机；若已有 Caddy 也在容器中，应通过共用 Docker 网络访问网关服务名，不能使用该容器内的 127.0.0.1。

先用 `dig +short A push.example.com` 核对静态 IP，用 `dig +short AAAA push.example.com` 排除错误 IPv6。
将以下站点块加入 `/etc/caddy/Caddyfile`；替换域名，保留同机其他站点：

```caddyfile
push.example.com {
    @admin path /admin /admin/*
    respond @admin 404
    reverse_proxy 127.0.0.1:8092
}
```

Caddy 负责申请和续期公开证书；不需要给 iPhone 安装本机 CA，也不需申请 Lightsail 负载均衡器证书。
证书签发依赖域名解析、80/443 入站和证书服务出站可达，见
[Caddy Automatic HTTPS](https://caddyserver.com/docs/automatic-https)。

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl enable --now caddy
sudo systemctl reload caddy
curl --fail https://push.example.com/health
curl -sS -o /dev/null -w '%{http_code}\n' https://push.example.com/admin/status
```

health 预期返回 `{"ok":true}`，公网 `/admin/status` 预期为 `404`。
从 Mac 以及手机蜂窝网络再次访问 HTTPS health；服务端 curl 成功不能证明外部防火墙已放通。
请求不应依赖私有 CA 或 `--insecure`。health 只证明进程和入口可用，不证明 Apple 接受或手机收到通知。

## 6. 授权 Mac 和启用手机

先更新 Mac Backend 到本次通用接口版本。按[给一台 Mac 授权](../../packages/push-gateway/README.md#给一台-mac-授权)
取得目标 profile 的 hostId。在 Lightsail 上暂时停止网关，再运行一次性管理容器，替换真实 hostId：

```bash
push_compose stop gateway
umask 077
push_compose run --rm --no-deps -T gateway src/admin.ts add-host YOUR_HOST_UUID sandbox > "$HOME/runweave-sender-credential.txt"
push_compose up -d --wait gateway
```

管理容器使用相同镜像、挂载目录和秘密文件，不发布宿主端口。写入操作只允许在网关停止时执行，避免争用数据库独占锁。

确认授权命令成功；输出文件只显示一次凭据。把以下配置保存到目标 Backend 的
`<browserProfileDir>/device-monitor/push.json`，目录权限 `700`、文件权限 `600`。
hostId 使用该 Backend 的 `/api/device/status` 返回值，不复制其他安装的身份或凭据：

```json
{
  "hostId": "YOUR_HOST_UUID",
  "gatewayURL": "https://push.example.com",
  "senderToken": "YOUR_HOST_SENDER_TOKEN"
}
```

Backend 每次启动直接读取该文件，开机、Dock、命令行和更新重启使用相同路径，不依赖工作目录
或启动包装脚本。配置独立于 App 和 runtime 安装目录，升级保留；修改后重启 Backend 生效。
缺少文件表示未配置；格式错误、非 HTTPS origin 或 hostId 不匹配时关闭推送并记录不含凭据的警告，
不影响电量展示和终端。Stable、Beta 和其他 profile 各自保存配置，不自动共用发送凭据。

临时运行或部署注入仍可成对提供环境变量，优先于文件：

```dotenv
RUNWEAVE_PUSH_GATEWAY_URL=https://push.example.com
RUNWEAVE_PUSH_SENDER_TOKEN=YOUR_HOST_SENDER_TOKEN
```

只提供其中一个或提供空值属于配置错误，不与文件拼接，也不静默回退。环境变量不会自动写回文件。
旧部署的 `private/backend.env` 需一次性转存到上述 profile 配置；仅在终端 export 无法保障下次
从 Dock 启动。采用公开证书后，不再需要为该网关指定本机私有 CA。`.p8` 留在云端网关，
Mac 只保存发送凭据，个人配置与凭据不得提交到仓库。

手机在连接管理中启用“低电量提醒”，授予系统通知权限并完成订阅确认。
如果之前绑定了本机试运行网关，先在旧网关可达时关闭提醒，完成撤销，再切换 URL 并重新启用；
无需迁移试运行数据。完成后停止旧试运行网关的自动启动，避免误用旧地址。

Debug/Profile 使用 sandbox，Release 使用 production，须分别核对签名、Apple 密钥授权及 sender 环境。
真实设备需验证锁屏横幅、前台接收与点击路由，见[电量推送验收计划](../testing/app/mac-battery-alerts.testplan.yaml)。
不要通过改正式 profile 的电量样本或去重记录来制造告警。
其他业务的接入方式见[通用通知接口](../../packages/push-gateway/README.md#接入其他通知业务)。

## 7. 运维、备份和升级

日常管理与随记一样使用 Compose；只操作 `runweave-push` project：

```bash
push_compose ps
push_compose logs --tail=100 gateway
push_compose exec -T gateway node --env-file=/run/secrets/gateway_env --import tsx src/admin.ts status
push_compose restart gateway
df -h /srv/runweave-push/data
```

管理员 status 只访问容器内 HTTP，不创建第二个数据库 writer，也不打印 token。
日志已限制为 3 个 10 MB 文件；外部监测 HTTPS health，关注 unhealthy、反复重启和磁盘空间。
health 不检查 APNs 凭据，仍需保留手机端到端验收。

**备份：**先 `push_compose stop gateway`，确认容器正常退出，再完整备份 `/srv/runweave-push/data/`，
包含 SQLite、WAL、撤销与去重状态；同时备份 private 目录、deployment.env、Compose 文件、Caddy 配置和代码 SHA。
备份含密钥与凭据，保存到实例之外的受控位置。完成后 `push_compose up -d --wait gateway` 恢复服务。
不要只复制运行中的 state.sqlite，也不要用 `down -v` 或清空数据目录作为升级步骤。

Lightsail **Snapshots** 的自动快照可作为额外恢复点。当前保留最近 7 个自动快照，需要长期保留时选择 Keep
转成手动快照；删除实例前保留所需手动快照。参见
[自动快照设置](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-configuring-automatic-snapshots.html)。
整机快照不替代停写后的应用备份；手动快照入口见
[Lightsail 实例快照](https://docs.aws.amazon.com/lightsail/latest/userguide/lightsail-how-to-create-a-snapshot-of-your-instance.html)。

**升级：**先准备并验证新镜像，记录现用镜像 ID，停容器并完成上述备份；修改 deployment.env 的镜像引用后执行：

```bash
push_compose config --quiet
push_compose up -d --wait --force-recreate gateway
curl --fail https://push.example.com/health
push_compose exec -T gateway node --env-file=/run/secrets/gateway_env --import tsx src/admin.ts status
```

验证原订阅仍在并完成真实通知检查。同 schema 镜像回退只切镜像，不恢复旧数据库；旧快照可能丢失后续撤销记录。
更换 Lightsail 实例时先关闭旧网关及自动启动，再恢复同一份数据、权限和配置到新实例，重新绑定静态 IP。
不能同时运行两份持有相同状态的副本；本机锁不能协调跨机器容器。

## 常见问题

| 现象                       | 优先检查                                                                      |
| -------------------------- | ----------------------------------------------------------------------------- |
| 域名无法访问或证书签发失败 | 静态 IP、A/AAAA、Lightsail 两组防火墙、UFW、80/443 是否被其他代理占用         |
| HTTPS 返回 502             | Compose ps/logs、容器 health、宿主机 127.0.0.1:8092、Caddy 所在网络           |
| SQLite 或秘密文件权限错误  | 宿主数据目录与秘密文件是否为 UID/GID 1000:1000；父目录可由 Docker daemon 访问 |
| 镜像无法启动或原生模块错误 | 镜像 CPU 架构是否匹配，是否误用了 Mac node_modules，查看退出日志              |
| Unsupported gateway state  | 是否误用了旧试运行数据库；保留原目录，首次上线使用新空目录                    |
| health 正常但不提醒        | Mac 实际进程环境、hostId、订阅确认、通知权限、APNs 环境，以及是否有新事件     |
| accepted 但没有横幅        | accepted 仅表示 Apple 接受，继续核实手机通知设置和收件证据                    |

## 可选：本机开发验证

准备 Node.js 22 和仓库指定的 pnpm，按网关说明安装依赖。运行前可检查本机原生 SQLite 模块：

```bash
pnpm --filter @runweave/push-gateway exec node --import tsx -e \
  "import('better-sqlite3').then(({default:D})=>{const db=new D(':memory:');db.close()})"
```

此节不是 Lightsail 部署的前置步骤。需要在 Mac 调试时，把私钥、环境文件和数据放在以下目录；代码使用独立、固定版本的 checkout，避免日常切分支改变服务：

```text
~/.runweave/push-gateway/
  private/apns.p8
  private/gateway.env
  private/backend.env
  data/
  logs/
```

私有目录权限设为 `700`，私钥和环境文件设为 `600`。`gateway.env` 使用简单 `KEY=value`
格式，填入实际值，不保留占位符：

```dotenv
PUSH_GATEWAY_BIND=127.0.0.1
PUSH_GATEWAY_PORT=8092
PUSH_GATEWAY_DATA_DIR=/absolute/path/to/push-gateway/data
APNS_PRIVATE_KEY_FILE=/absolute/path/to/push-gateway/private/apns.p8
APNS_KEY_ID=YOUR_KEY_ID
APNS_TEAM_ID=YOUR_TEAM_ID
PUSH_GATEWAY_ADMIN_TOKEN=YOUR_RANDOM_ADMIN_TOKEN
```

生成管理员 token 时把 `openssl rand -hex 32` 的输出直接保存到受限文件，不粘贴到聊天或日志。
在仓库根用 Node 的环境文件入口启动；将示例路径替换为实际路径：

```bash
pnpm --filter @runweave/push-gateway exec node \
  --env-file=/absolute/path/to/push-gateway/private/gateway.env \
  --import tsx src/index.ts
```

需要常驻时用用户 LaunchAgent 管理同一个命令，指定绝对 Node 路径、网关包的 WorkingDirectory、
独立日志路径和 `RunAtLoad`。不要同时保留手动进程和 LaunchAgent；同一数据目录只允许一个实例。
LaunchAgent 登录后运行，不保证退出登录或 Mac 休眠期间可用。

网关地址必须是手机和 Mac 都可访问、证书受信任的 HTTPS origin。
`https://localhost` 在手机上指向手机自身，不能用作跨设备地址。局域网部署可以使用固定 LAN 地址
和私有 CA，给 Mac 的 Node 进程配置 `NODE_EXTRA_CA_CERTS`。手机直接访问网关的备用撤销流程
需要在 iPhone 安装、信任对应根证书；通过 Backend 注册、关闭提醒及通过 Apple 接收推送不依赖该信任。
不要关闭 TLS 校验。私有 CA 的客户端信任要求见
[Caddy 本地 HTTPS](https://caddyserver.com/docs/running#local-https-with-systemd)。
这条路径只覆盖可达的局域网；需要手机蜂窝网络访问时，使用可达的公网域名入口。

Mac 上需用桌面 App 自带的 Node 复核连接，系统 Node 或 curl 成功不能替代这一检查。
若 `.local` 名称连接超时，可使用已包含在证书 SAN 中的固定局域网 IP；地址变化时须更新配置。
