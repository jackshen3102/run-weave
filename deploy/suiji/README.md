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

先按[服务入口](../../packages/suiji-server/README.md#外部-agent-mcp)在设备生成凭据，
只将 `registration.json` 送服务器登记。在 `settings.yaml` 设置 `services.suiji.mcpEnabled: true`，首次启用需重建 API。
之后注册和撤销不需要重启。`client.env` 的原文只留在客户端，不上传到服务器或镜像。
TLS 反向代理将 `/mcp` 与 `/mcp/uploads` 转到同一 API 端口。
全局关闭设置 `services.suiji.mcpEnabled: false` 并重建 API；不删除凭据或影响 App 会话。

## 多凭据迁移

本版要求 schema 6。沿用 `release.mjs deploy` 的发布锁、异机备份及不可变镜像。
已有部署必须有可信的 release-state；缺失时先核对真实镜像和部署信息，不能把它当成首次部署。
若实际服务使用多个 Compose 文件，release config 必须通过 `composeFiles` 数组按顺序列出全部绝对路径，
首项指向新版本 compose，其余保留现有 override。发现已有 override 而配置未声明时发布会停止。

发布流程备份后停旧 API，追加迁移，再把 deployment env 中旧 `SUIJI_MCP_TOKEN_SHA256` 与
`SUIJI_MCP_TOKEN_EXPIRES_AT` 通过管理员 `import-legacy` 原样登记。不接触原文、不延长期限。
导入成功后保存原 env 的受保护备份，移除旧两项，持久化新开关，再启动新版。
没有旧 MCP 配置则默认保持关闭；显式 false 也不会被迁移打开。
失败时保留现场，不自动删除新表或回退不兼容镜像。

手动迁移时 `admin mcp-credentials import-legacy` 接收 stdin JSON：
`version:1, serverId, ownerId, name, tokenSha256, expiresAt`，摘要与期限取自受保护旧配置。
重复导入不延长期限，不恢复已撤销条目。先确认导入成功，再移除旧配置并开启新开关；
直接启动带旧配置的新版 API 会报迁移错误，避免静默失联。

迁移前后由原客户端使用同一 token 各做一次只读请求，确认服务身份和访问都保持；
新增设备使用独立 token 验证。schema 5 的旧镜像不能运行 schema 6 数据库，失败后使用兼容修复镜像。
旧备份仍可在隔离环境按其镜像恢复，不能直接覆盖有新数据的生产库。

schema 6 备份额外核对凭据数量与稳定字段校验摘要，包含撤销状态；备份里没有 token 原文。
恢复目标强制持久化 MCP 关闭。恢复旧备份可能复活恢复点之后撤销的 token，生产恢复前应核对之后的撤销记录；
无法核对时先撤销全部恢复凭据，再登记新的客户端摘要，最后显式开启 MCP。

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

确认已登录后，在 YAML 设置 `services.suiji.ai.provider: codex-cli`，
可选设置 `services.suiji.ai.timeoutSeconds`（默认 180），通过原发布流程重建 API 容器。
YAML 的 `services.suiji.ai.codexHome` 必须设置为 `/data/codex`。
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

## 跟进版本迁移

跟进要求 schema 5。先做静止备份，再运行追加迁移和部署兼容镜像；旧 schema 4 二进制不能直接启动新数据库。备份和恢复核对包含 record_followups、followup_attachments 数量；旧备份按其 schemaVersion 保持兼容。认证回读覆盖普通/回收站记录、跟进与全部附件字节。

回退优先使用支持当前 schema 的修复镜像，不删表回退；恢复旧备份会丢失恢复点之后的写入，需要单独明确授权。随记 Skill 的上传入口 `/mcp/uploads` 与 `/mcp` 使用相同个人凭据和关停策略，不使用 App 会话或数据库凭据。

## 服务 YAML 配置

Compose 的 `SUIJI_CONFIG_DIR` 指向仓库外私有目录，挂载到容器 `/config`。
按 [settings.example.yaml](./settings.example.yaml) 创建 `settings.yaml`，目录 0700、文件 0600，
属主为容器 UID/GID 1000:1000。该目录需可写以保存 owner 锁及配置备份。
`services.suiji.databaseURL` 使用受限数据库账号 `suiji_api`，密码需 URL 编码；不能使用管理员账号。
数据库管理员密码仍由 Compose secret 供迁移工具读取，不放入服务运行配置。
发布工具的 config.json、Compose 的镜像/卷路径参数属于部署清单；不会覆盖服务 YAML 的业务字段。
