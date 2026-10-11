# 配置与服务管理

Agent 使用 [runweave-management Skill](../../plugins/toolkit/skills/runweave-management/SKILL.md) 管理配置与诊断。
字段含义、默认值和约束见 [生成的字段参考](./configuration-reference.md)，读写与迁移见 [配置 CLI](./configuration.md)。

## 状态入口

```bash
rw status --instance stable --profile local --json
rw config status --instance stable --profile local --json
rw version --json
```

`rw status` 通过认证 profile 读取 `GET /api/runtime-status`，返回原有 node、reports 和 management。
`reports[].items[].facts` 中的 `runtime-version.*` 字段承载组件版本与构建信息。
其中节点 CLI 来自 Backend 所在机器可调用的 `rw`，最多缓存 60 秒；当前执行命令的 CLI
版本使用 `rw version --json`，其 `build.buildId` 标识具体构建。两者可以属于不同机器。
management.capabilities 复用共享聚合规则：生命周期 state 和 attention（none/warning/error）独立；
上游故障导致的 blocked 不重复计入能力异常数量。diagnostics 列出状态项、来源、依赖、候选配置域与字段模式，
以及只读操作标识。关联是排查线索，不是根因判定或自动修改授权。

coverage 明确这是 Backend 节点快照，列出快照包含的 runtime（包括注册表的未上报/未配置占位报告）；不包含 Electron 本地 IPC、Frontend 页面连接和
未上报独立服务。返回成功表示读取成功，可能仍有 warning/error；404、认证失败或未知协议会以非零退出，
不能把失败当成空列表或健康。诊断输出不会自动启动、停止或修复服务。
Research MCP 的 `query_data(source=status)` 返回同一 Backend API 的数据。

`rw config status` 读取 `GET /api/configuration`，核对返回的实例身份与 `--instance`；返回 API 允许公开的
远端字段、consumer 和 fieldStates，敏感值只报告 configured。未公开的本地字段和其他进程无法由这个
接口确认生效。磁盘 explain 的 application:notObserved 与运行中的 applied 是不同证据。
profile 选择 Backend 连接；instance 选择执行 CLI 的机器上的配置身份，两者不能互相替代。

## 验证修改结果

1. 通过 keys/explain 和字段参考确认约束、实际键与生效方式，读取最新 revision/digest。
2. 按配置 CLI 的 CAS 规则写入，随后 validate；凭据通过私有输入传入，不输出原值。
3. 重载支持 reload 的消费者；restart 字段使用所属服务的既有生命周期入口。
4. 查询 config status，核对字段 saved/applied、state 和 appliedRevision。error/pending/notObserved
   都不是应用成功；全局 revision 变化不等于每个字段必须重载。
5. 再读 status，检查报告新鲜度、上游和恢复状态，并执行目标服务的真实功能验证。

这些步骤区分持久化、应用、服务状态与业务成功。服务 healthy 不证明新配置已应用，配置 applied 也不证明
网络、凭据或真实业务可用。远端字段写入继续受现有 remote 权限和实例握手限制。

## 字段参考保鲜

```bash
pnpm configuration:docs
pnpm configuration:docs:check
```

参考由字段注册表与共享校验元数据生成，不维护手写字段副本。新增字段或修改枚举、范围、服务归属时更新
元数据并重新生成。业务消费者的额外校验不能由配置文件 schema 推断，按字段归属查实际消费者。

运行状态面板保留能力分组；配置编辑按服务/功能折叠，保留已有远端编辑能力。
动态占位字段仍通过 CLI 的实际路径管理。
