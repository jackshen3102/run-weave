# 随记独立部署

产物只包含随记服务、协议构建结果与运行依赖。Compose 为 PostgreSQL 18.6 和 API 提供独立持久目录，
数据库没有宿主端口，API 仅发布 loopback。TLS 由同机反向代理接入，参考 [Caddy 配置](./Caddyfile.example)。

## 准备目标

需要 Docker Engine、Compose、Node 22、tar、rsync、SSH。代码目录与数据目录分开。
执行机就是配置中的目标主机；命令不猜测 SSH 发布目标。外部备份 SSH 账号需提前配置连接与目录权限。

1. 复制 [.env.example](./.env.example) 到受保护配置位置，提供绝对数据目录与两个独立随机数据库密码文件。
2. 密码文件权限设为 `0600`；API 普通角色密码与 PostgreSQL 管理密码分别存储。
3. 准备同样受保护的 owner JSON 文件，只有 `username`、`password`；不把密码放命令参数。
4. 按 [config.example.json](./config.example.json) 提供真实环境、主机、路径、域名、TLS、异机备份位置、
   RPO/RTO 和允许停写窗口。`ownerCredentialsFile` 用于首次初始化与发布后真实鉴权读回。

正式版本的 `apiURL` 必须为 HTTPS、hostname 与 `domain` 一致。
本地开发可显式设置 `tls: local-loopback` 和 `http://127.0.0.1:<port>`；这不证明云端可达。
异机备份目标必须是真实 `user@host:/absolute/path`，不能用本机目录或另一同机容器冒充。

## 构建、迁移与部署

```bash
docker build -f deploy/suiji/Dockerfile -t <registry>/suiji:<git-revision> .
# 构建上下文使用 Dockerfile.dockerignore，要求 BuildKit；不发送 .runweave、凭据或工作区资料。
node deploy/suiji/release.mjs deploy --config /absolute/config.json --image <registry>/suiji@sha256:<digest>
```

本地构建也可传 `sha256:<image-id>`，发布必须固定不可变镜像；应用版本由 env 中的 `SUIJI_REVISION` 记录。
不要覆盖固定 tag 后将它当作不可变引用。镜像不会启动终端、Backend、App Server 或 Electron。
容器入口读取各自 secret 后降权为 UID/GID 1000，API 不取得迁移凭据。

发布锁覆盖所有变更。已有版本先停 API、等待在途请求完成并做有效异机备份，然后再迁移和换版。
迁移失败不替换旧 API，不执行 down；失败日志和旧镜像保留。
首次部署初始化空库与 owner，重复初始化不会覆盖账号。就绪检查还会登录读取记录、版本快照与附件校验和。
身份、输入限额和运行版本通过 info 获取；健康接口不返回敏感配置。

管理员命令与业务进程使用不同凭据：

```bash
docker compose --env-file /absolute/deployment.env -f deploy/suiji/compose.yaml run --rm -T admin migrate
docker compose --env-file /absolute/deployment.env -f deploy/suiji/compose.yaml run --rm -T admin init < /absolute/protected-owner.json
docker compose --env-file /absolute/deployment.env -f deploy/suiji/compose.yaml run --rm -T admin reset < /absolute/protected-owner.json
```

同一部署还需沿用 `--project-name`，与 release config 的 project 一致。
已执行迁移摘要与工具历史一起提交；改写旧迁移会被拒绝。追加兼容迁移时同步修改 API 的 schema 支持范围。
镜像回退只有在旧镜像支持当前 schema 时才允许，发布脚本不会擅自回退数据库或选择未经证明兼容的镜像。

## 可选 MCP

先按[服务入口](../../packages/suiji-server/README.md#外部-agent-mcp)生成个人凭据。
将生成的 `server.env` 中两项摘要/期限配置加入受保护的 deployment env；Compose 将它们传给 API。
不把含原 token 的 `client.env` 放到服务器配置或镜像中。TLS 反向代理将 `/mcp` 转到同一个 API 端口。
更新配置后通过现有发布流程重建 API 容器使其生效；轮换凭据需同步更新 Agent 环境变量。
移除两项并重建 API 可关闭 MCP，未配置时 HTTP 和原生客户端继续工作。本阶段没有 schema 迁移。

## Codex 回顾

镜像包含固定版本 Codex CLI，默认关闭回顾。登录保存在 `${SUIJI_DATA_DIR}/codex`，
与容器生命周期分离；入口创建目录并交给运行 API 的 UID/GID 1000，权限为 `0700`。
目录只用于此服务的 Codex 登录和运行状态，不挂载个人工作区或整套 Runweave。

先发布包含 Codex 的镜像，再使用同一 deployment env 和 Compose project 完成登录：

```bash
docker compose --env-file /absolute/deployment.env --project-name <project> -f deploy/suiji/compose.yaml run --rm --no-deps api codex-login
docker compose --env-file /absolute/deployment.env --project-name <project> -f deploy/suiji/compose.yaml run --rm --no-deps api codex-status
```

第一条使用设备码登录，按终端链接在浏览器确认；登录命令不连接数据库。
参考 [Codex 无界面设备登录](https://learn.chatgpt.com/docs/auth#login-on-headless-devices)。
认证内容不放进镜像、仓库或日志；Codex 需要能写回该目录以刷新登录。目录不属于记录/附件业务备份。

确认已登录后，在 deployment env 设置 `SUIJI_AI_PROVIDER=codex-cli`，
可选设置 `SUIJI_AI_TIMEOUT_SECONDS`（默认 180），通过原发布流程重建 API 容器。
Compose 将持久目录作为 `SUIJI_CODEX_HOME=/data/codex` 传给服务。
手机重新连接后进入「AI」提问；是否启用仍以实际鉴权 `info.ai.enabled` 为准。
验收必须创建一次真实回顾并检查回答及原文引用，镜像构建和 CLI 登录成功不代表模型调用已通过。

## 备份和恢复

```bash
node deploy/suiji/release.mjs backup --config /absolute/config.json
node deploy/suiji/release.mjs restore --config /absolute/isolated-config.json --backup /absolute/backup-directory
```

备份使用正常关闭，等待在途写/上传结束，不用超时强杀制造不一致快照。
静止窗口内产生 PostgreSQL dump、附件 tar、记录/修订/幂等数量、稳定身份、schema/应用版本和 SHA-256 清单。
原 API 随后恢复同版；超出声明停写窗口或异机复制/校验失败都会非零退出，不产生本机完成标记。
异机文件和完成标记都校验后才报告完成。失败产物保留供排查，没有自动清理。

恢复配置必须 `environment: development`、`restoreIsolated: true`，无既有发布状态、容器、数据库或附件数据。
恢复前检查完成标记、完整校验和、tar 路径与文件类型；恢复到新的空目标，不接受覆盖生产。
恢复后核对身份、行数和每个对象摘要，再通过真实鉴权 HTTP 读回记录及全部附件，并报告恢复耗时与 RTO 对比。
源服务不被改写。恢复中途失败保留目标现场；脚本不会为了重试自动删除已经恢复的数据。

备份频率必须按声明 RPO 配置运维调度；本任务不创建后台任务。数据库大版本升级需单独计划。

## 当前验证范围

隔离容器首次启动、稳定账号管理和进程重启持久化已取得真实证据。
完整部署 YAML 在第 4 条因缺少实际异机备份配置停止，后续升级/备份/恢复用例未判通过。
迁移校验和锁等直接命令检查单独记录，不能替代发布链路或异机恢复验收。
详见 [架构与交付状态](../../docs/architecture/suiji.md) 和
[部署恢复合同](../../docs/testing/suiji/deployment-recovery.testplan.yaml)。
