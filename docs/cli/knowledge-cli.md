# 成果引用与 Agent 复查

经验、洞察和建议详情中的「复制给 Agent」生成带版本的 `rw-knowledge:v1:…` 引用。
粘贴给 Agent 后，通过已配置的 Runweave 连接读取，不需要当前目录位于成果所属仓库：

```bash
rw knowledge read '<完整引用>' --evidence --json
rw knowledge read '<完整引用>' --evidence --json --profile local
rw knowledge read '<完整引用>' --evidence --json --backend-port 5001
```

引用包含持久存储身份和分享 ID，不包含登录凭据或可触发任意请求的服务器地址。
读取要求原分享账号的正常登录态；来源不匹配时切换到对应的已配置连接，不跨来源猜测同名成果。
不同电脑/云端 Agent 也必须能通过其配置的连接访问原 Backend，不提供匿名公网分享。

## 返回内容

- `item`、`createdAt`：分享时的正文、来源版本及时间；独立于待处理/已处理状态。
- `current`：读取时的可用性和当前版本；来源无法读取时明确为 unknown/unavailable，不能把快照当作当前状态。
- `--evidence`：分享时的来源材料。Evolution 包含对应版本的 Claim、交叉核验、支持/反对证据索引与缺失证据；Experience 包含对应版本的经验记录、保存的摘录和当时已有的使用反馈。
- `contents`：CLI 使用正常鉴权的 Activity 内容接口读取原文，核对与冻结索引一致的 SHA-256。已过期、删除、摘要不符、非文本或读取失败均明确标为 unavailable。

Activity 原文不会因分享而永久复制或延长保留期。每份可读原文最多输出 65,536 个字符，
超过时 `truncated=true`；需要剩余内容时按返回的 contentId 使用正常鉴权的 Activity 内容接口。
经验的 `archived` 只是保存时的脱敏摘录，使用反馈是 Agent 报告，分析的 corroborated 也不是独立实测。
旧版处理历史缺少精确来源版本时只给正文和明确缺失说明，不用最新证据替换历史依据。

复制不标记已处理，读取不生成采用反馈、不修改知识生命周期、不运行历史指令。
Agent 应按用户本次要求复查，区分真实观察、分析推断、未验证假设与已解决的历史问题；
没有现存缺口和效果证据时，不仅因卡片存在就新增优化任务。

API 使用正常 Bearer 鉴权：`POST /api/knowledge-inbox/items/:itemId/share` 接收
`contentVersion` 与 `sourceRevision`；`GET /api/knowledge-inbox/shares/read` 接收
`reference` 与可选 `evidence=true`。404 为不存在/无权限/旧服务不支持，409 为来源或版本不匹配。

合同见 [共享类型](../../packages/shared/src/knowledge-inbox.ts)；来源与消费边界见
[自进化架构](../architecture/agent-self-evolution.md)。
