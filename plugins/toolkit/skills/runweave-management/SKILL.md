---
name: runweave-management
description: 管理 Runweave 实例配置与服务状态，查询 warning/error、解释配置、校验、修改并确认生效；更新安装和 Dev Session 生命周期沿用专属技能。
---

# Runweave 配置与服务管理

使用当前源码构建的 CLI 或目标机器已安装的 `rw`，先核对 `rw version --json` 支持以下命令。旧版本缺少命令时报告能力缺失，不直接编辑配置文件补救。
仓库操作指南：[配置 CLI](https://github.com/jackshen3102/run-weave/blob/main/docs/cli/configuration.md)、[权威字段参考](https://github.com/jackshen3102/run-weave/blob/main/docs/cli/configuration-reference.md)、[服务管理](https://github.com/jackshen3102/run-weave/blob/main/docs/cli/service-management.md)。离开仓库也可通过 `rw config keys --json` 查询当前二进制的字段目录及 constraints（枚举、范围、路径和成组凭据约束），用 `rw config explain <实际键> --instance <id> --json` 读取来源与生效方式。

## 定位与只读诊断

明确目标机器、Stable 或 Dev 实例，以及 Backend profile。本地配置命令读取执行 CLI 的机器；远端 profile 不会把本地磁盘查询变成远程读取。远端本地字段操作应在目标机器执行。Dev Session 使用其绑定入口及真实 Session ID，不猜端口或路径。

```bash
rw config path --instance <id> --json
rw status --instance <id> --profile <name> --json
rw config status --instance <id> --profile <name> --json
rw config keys --json
rw config validate --instance <id> --json
rw config doctor --instance <id> --json
```

`status.management.capabilities` 使用统一 warning/error 与依赖聚合；先看上游故障，再看受阻项。diagnostics.configuration 是候选排查关联，不证明故障由配置导致。动态字段模式要替换成真实键；不要将占位符直接交给 explain/set。
核对 node、profile、来源和 coverage；Backend 节点快照不包含 Electron IPC、当前页面连接和未上报独立服务。404/协议不支持/认证失败是读取能力或连接问题，不等于服务健康。`rw health` 可达不代表全部服务正常。
Research MCP 也可通过 `query_data` 的 `source: status` 查询同一 Backend API；旧 Backend 没有 management 时只解释已有证据，不伪造完整覆盖。

## 修改与确认结果

在本次授权范围内执行配置变更。先 explain 目标键，核对类型、约束、敏感性、归属与生效方式；读取最新 revision/digest 并保存预期值。值通过私有 JSON 文件或 stdin 传入，凭据不进命令参数、stdout 或成果。

```bash
rw config set <实际键> --value-file <private-json> --instance <id> \
  --expected-revision <revision> --expected-digest <digest> --json
rw config validate --instance <id> --json
rw config reload --instance <id> --profile <name> --json
rw config status --instance <id> --profile <name> --json
rw status --instance <id> --profile <name> --json
```

null 恢复默认。关联凭据需成组变更时使用配置文档的 import 流程，先 dry-run，不通过多次单键保存制造无效中间态。版本冲突重新读取并核对用户意图，不能去掉预期版本强行覆盖。
保存成功只表示持久化。检查目标字段 fieldStates 的 state、saved、applied 与 appliedRevision；pending/error/notObserved 不能报告为生效，重载失败保留旧采用值。重启字段通过目标服务既有生命周期入口处理，禁止按端口杀进程或重启无关服务。Dev Session 操作使用 runweave-dev-session；用户显式要求 Stable 更新时使用 update-runweave-desktop。
最后执行该服务真实功能验证，例如读取数据、连接或用户授权的业务操作；healthy 与 applied 本身不能替代业务成功。只读诊断不发送消息或写入终端。

恢复备份、迁移、初始化和软件更新不是普通配置写入；按配置文档/专属技能执行精确目标、预览和兼容检查。初始化只用于确认全新安装；不覆盖已有身份。写入响应不确定先核对，不自动重放有副作用的操作。

交付区分保存、应用、服务状态及业务验证四种证据，明确来源和未验证范围。
