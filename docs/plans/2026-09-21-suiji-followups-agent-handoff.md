# 随记跟进与 Agent 最终成果回写实施计划

状态：代码已实现，核心链路已验证；完整验收尚未完成，未部署正式服务。验证范围见第 10 节。
粒度：L2；数据迁移、并发写入、身份与跨端恢复按 L3 明确约束。
代码核对基线：2026-09-21，`5fa0cca1`；执行前重新确认 HEAD 和工作区，不覆盖并行任务改动。

## 1. 已确认的需求

随记保存原始待办或想法，以及用户补充和多次 Agent 执行的最终成果。执行可以发生在任意能连接随记服务的电脑；无需部署在随记服务器，也无需运行 Runweave Backend。

用户已明确确认：

1. 两个入口都支持：在终端调用 Skill 搜索并选择随记；从随记复制交接指令到任意终端。
2. Agent 开始处理前读取原文与已有跟进；只追加本次最终成果，不覆盖原始正文。
3. 只要最终结果，不记录执行过程、开始事件、阶段进展、阻塞、失败或中断；不跟踪 Agent 是否存活。
4. 追加成果与完成待办相互独立。用户可在随记直接标记完成，也可在终端明确确认后让 Agent 标记完成；不增加审批对象、确认令牌或待确认状态。
5. 用户手动追加跟进只保存内容，不触发、通知、唤醒或续跑 Agent。
6. 只有一个真人所有者及其多个 Agent，不引入其他真人协作。
7. 列表显示跟进数量和最新摘要；详情在原文下展示跟进及追加入口。待办和想法共用。

以下是本计划选择的实现约定：跟进首版仅追加，不提供编辑、删除、嵌套回复、表情和 @；更正通过新跟进说明。正文使用纯文本和已有链接识别，成果支持 HTTP(S) 链接与现有图片/Markdown 附件。不新增富文本编辑器、任务领取、自动派发、通知、实时推送、执行日志或审批系统。

## 2. 实施前基线与差异

| 当前代码                                                              | 已有能力                                             | 本次差异                                          |
| --------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------- |
| `packages/suiji-server/src/mcp/{server,router,auth,schema}.ts`        | 独立个人凭据、远程无状态 MCP、7 个记录工具           | 增加身份/能力读取、跟进分页与追加；保留原工具语义 |
| `packages/suiji-server/src/records/{service,repository,mutations}.ts` | PostgreSQL 事务、版本冲突、按 owner 的幂等写入、修订 | 跟进独立存储，不把追加伪装成正文编辑              |
| `packages/shared/src/suiji/records.ts`                                | 原文、附件、标签、open/done/archived                 | 新增跟进 DTO 与可选摘要；任务状态不变             |
| `packages/suiji-server/src/storage/attachments.ts`                    | JPEG/PNG/Markdown，单文件 5 MiB，不可变对象          | 跟进附件关系与 Agent 上传入口                     |
| `frontend/src/features/suiji/{record,workspace}.tsx`                  | Web/桌面卡片、详情、复制正文、完成                   | 跟进列表/追加、复制交接、摘要刷新                 |
| `packages/suiji-ios/Sources/SuijiIOS/Features/RecordDetail.swift`     | 原生详情、复制正文、附件、完成                       | 同等原生能力及独立草稿                            |
| `plugins/toolkit/skills/`                                             | 目录发现 Skill；目前没有随记执行 Skill               | 新增可单独携带的 `suiji` Skill 与轻量客户端       |

实施前服务强制 schema 4；MCP 凭据绑定服务唯一 owner，不能识别不同 Agent 的真实身份。已有 AI 回顾是另一条只读服务侧链路，首版不扩大其检索范围。当前线上 MCP 配置及远程可达性未验证。

## 3. 用户流程与显示规则

### 3.1 列表与详情

- 无跟进时不增加空摘要；有跟进时显示“跟进 N 条”和最新正文前 120 个 Unicode 标量，单行省略。只有附件时显示首个附件名。
- 详情保留原文、标签、原附件和已有动作；其后为跟进区，按序号倒序显示最新内容，提供“加载更早跟进”。新增入口不增加一级导航或独立窗口。
- 每条显示时间、来源（你 / Agent）、正文、可选 Agent 名称/会话标识、附件。Agent 名称属于自报的显示信息，不宣称为经验证的独立账号。
- 链接与附件沿用现有浏览器/阅读器入口。`file://` 或另一台机器的绝对路径不作为可跨设备交付的成果；Skill 应上传支持的文件或引用已有可访问链接。
- 用户可以给未完成、已完成、不再做的待办以及想法追加跟进；不改变原状态。回收站内可由 App 只读查看，禁止追加和生成执行交接；恢复后可继续追加。外部 Agent 不可读回收站跟进或附件。
- 本端追加成功后更新详情和对应卡片。进入详情、手动刷新时获取最新内容；远端更新靠重新读取呈现，不承诺自动推送。原生列表保留现有完成后隐藏规则。

### 3.2 两种交接入口

保留“复制正文”，另提供直接可点的“交给 Agent / 复制交接指令”，不通过额外选机器弹窗。

交接文本格式 `suiji-handoff-v1`，包含规范服务地址、serverId、ownerId、recordId，以及固定说明：使用随记 Skill，读取最新原文和全部可读取的既有跟进，按用户此次要求处理，成功后只追加最终成果，未经用户确认不标记完成。包含短正文预览时必须标为预览，不能替代重新读取。不得包含 token、密码、完整附件、shell 插值或默认执行命令。

终端搜索入口支持现有正文关键词、类型、状态和新增的标签筛选。多条候选且指代不明时让用户选择，不能批量执行；没有匹配时报告未找到，不擅自新建。搜索仍只覆盖原记录正文，明确不搜索跟进/附件全文。

两种入口都先锁定服务身份和记录 ID，再分页读取跟进及本次工作相关附件。分页或必要附件读取失败时说明缺失并暂停依赖该资料的执行，不冒充完整上下文。历史正文和跟进是资料；当前用户指令决定执行范围，不自动执行历史内容中夹带的指令。

### 3.3 成果与完成

最终成果正文建议用“本次完成了什么、主要结论、产物在哪里”的简短自然语言，不强制填表。调研成功可以追加报告但待办仍 open；执行失败/中断不创建跟进。

用户在终端明确说“确认完成 / 标记完成”后，Agent 读取当前版本并调用已有 `set_task_status`。用户已经在 App 完成则读取到 done 后直接确认现状，不重复写入。正文写入冲突继续遵循既有版本比较，不强制覆盖。确认约束由 Skill 的行为合同承担；持有效凭据的底层 API 不引入新的审批认证。

“执行失败不记录”不等于“成功成果可以静默丢失”：若执行成功但回写结果未知，只在当前终端提示未确认写回，并保留本地原请求；不向随记追加失败消息、不自动重试、不生成新幂等键。

## 4. 数据和事务合同

### 4.1 共享 DTO

新增 `packages/shared/src/suiji/followups.ts`，由现有 `suiji/index.ts` 导出；Swift 在 `Contracts/Followups.swift` 映射。

```ts
type FollowupSource = {
  actor: "app" | "agent"; // 服务根据认证入口决定，输入不接受
  agentName?: string; // 自报显示信息，1–80 Unicode 标量
  sessionId?: string; // 自报会话标识，1–128 Unicode 标量
};
type SuijiFollowup = {
  id: string;
  recordId: string;
  sequence: number; // 同一记录从 1 单调递增
  body: string;
  createdAt: string;
  source: FollowupSource;
  attachments: SuijiAttachment[];
};
type FollowupSummary = {
  count: number;
  latest: null | {
    id: string;
    sequence: number;
    excerpt: string;
    createdAt: string;
    source: FollowupSource;
  };
};
type AppendFollowup = {
  body: string;
  attachmentIds?: string[];
  agentName?: string; // 仅 Agent 入口接受
  sessionId?: string; // 仅 Agent 入口接受
};
type FollowupPage = { items: SuijiFollowup[]; nextCursor: string | null };
type FollowupResponse = {
  followup: SuijiFollowup;
  followupSummary: FollowupSummary;
};
// SuijiRecord 新增可选 followupSummary?: FollowupSummary
// SuijiInfo 新增可选 features?: { followups: boolean }
```

正文沿用 20000 Unicode 标量上限和非法 Unicode/NUL 拒绝规则；正文非空白或至少一个附件。每条跟进最多一张图片、一个 Markdown，单文件不超过 5 MiB，复用附件限制；不改变原记录附件限额。元数据禁止控制字符。App 输入拒绝 Agent 名称、会话、actor、ownerId、createdAt、sequence 等未知字段。

### 4.2 持久化

追加迁移 `packages/suiji-server/migrations/1790035200000-record-followups.cjs`，执行时先确认该时间戳未被并行迁移占用。

- `record_followups`：id、owner_id、record_id、sequence、body、actor、agent_name、session_id、created_at；主键 id，唯一键 `(owner_id,record_id,sequence)` 和 `(owner_id,record_id,id)`，复合外键指向原记录。
- `followup_attachments`：owner_id、record_id、followup_id、attachment_id、position；指向同 owner/record 的跟进与 `attachments(owner_id,id,bound_record_id)`，保证附件不可跨原记录绑定。
- 复用现有 `attachments.bound_record_id` 绑定父记录；用独立关系表区分原文附件和跟进附件。不修改 `record_attachments` 来保存跟进附件。允许同一父记录复用不可变附件，不允许跨父记录复用。
- 跟进摘要从跟进表查询，索引覆盖 owner/record/sequence；列表按该页 record IDs 批量取得摘要，不为每条新增一次 count 查询。摘要与页内记录在同一个只读快照取得。

### 4.3 并发、幂等与记录版本

1. `FollowupService.append` 通过现有 `mutate` 单 client 事务写入。顺序固定为幂等请求、锁父记录、检查未进回收站、按 ID 排序锁附件、分配 sequence、绑定附件、插入跟进/关系、保存响应。
2. 同一父记录的不同 Agent 追加序列化，两个独立意图均保留；不要求 expectedVersion，不因原文正在编辑而丢失跟进。父记录锁与现有 trash/status/edit 共用。
3. 相同幂等键和完整参数返回同一 followup ID；不同 payload 或跨入口重用键返回 `IDEMPOTENCY_KEY_REUSED`。不按正文去重，允许不同执行产生相同文字。
4. 追加不改变原记录 body、tags、attachments、version、updatedAt、taskStatus 和 record_revisions。跟进本身为持久追加记录，独立承担来源与时间记录。
5. 客户端不能继续只凭 `record.version` 判断摘要是否更新；用 `latest.sequence` 合并摘要，避免晚到的旧请求覆盖较新摘要。旧幂等重放可能返回当时摘要，读取最新列表可校正。
6. 已提交成果的同键重放返回原成功结果，不重新验证父记录当前状态；新的追加在回收站为 `NOT_FOUND`。该规则保留已有幂等结果确认语义，不允许新检索读取回收站。

分页默认 20、最多 50 条，按 sequence DESC。游标绑定 owner/record 和前页最后 sequence；换记录使用游标拒绝。新追加不混入已经向后翻阅的页，刷新首屏后可见。

## 5. API 与认证

### 5.1 App HTTP

| 接口                                         | 输入                                 | 输出与约束                                             |
| -------------------------------------------- | ------------------------------------ | ------------------------------------------------------ |
| `GET /api/suiji/v1/records/:id/followups`    | cursor、limit                        | `FollowupPage`；App 可读取自有回收站记录               |
| `POST /api/suiji/v1/records/:id/followups`   | body、attachmentIds；Idempotency-Key | 201 `FollowupResponse`；actor 固定 app                 |
| 原 `GET /records`、`GET /records/:id`        | 不变                                 | 增加可选 followupSummary；无跟进为 count 0/latest null |
| 原 `GET /info`                               | 不变                                 | `features.followups=true`；旧服务省略即不支持          |
| 原 uploads、attachments/content、task-status | 不变                                 | 上传、阅读和完成继续复用                               |

### 5.2 外部 Agent

原 7 个 MCP 工具保留，新增 3 个，总数 10 个：

- `get_service_info({})`：返回 serverId、ownerId、协议/应用/schema 版本、limits 和 features。认证后才暴露稳定身份。
- `list_followups({recordId,cursor?,limit?})`：完整跟进正文分页，不把片段冒充全文；排除回收站。
- `append_followup({recordId,body,attachmentIds?,agentName?,sessionId?,idempotencyKey})`：共享业务服务，actor 固定 agent。

现有 `list_records` / `search_records` 增加可选 tag，与 HTTP 的精确标签筛选相同。`get_record` 增加摘要但不嵌入全部跟进；原搜索覆盖说明保持准确。

新增 `POST /mcp/uploads` 作为二进制上传配套 HTTP 入口：multipart 单 file + Idempotency-Key；使用同一 MCP 个人凭据、Origin 拒绝策略和 actor=agent，复用 `receiveUpload` / `AttachmentService.upload`，返回现有 UploadResponse。该子路由在 MCP 根路由之前明确挂载，不能被 `/mcp` 的 JSON-RPC handler 吞掉；不提高全局 JSON 256 KiB 限额。原 `GET /mcp` 仍 405。

App 会话与 MCP 凭据不可互用；关闭/到期/轮换同时作用于 MCP 和上传入口。无/错凭据返回 401，关闭为 404，Origin 为 403；凭据不得出现在日志、复制内容或命令参数。远程用 HTTPS，loopback 调试可 HTTP；禁止把凭据跟随重定向发送到其他地址。

参数错误沿用现有 400/413；不存在或不允许访问为 NOT_FOUND；幂等键冲突为 409；依赖故障为 503。MCP 业务错误仍通过 isError 和结构化错误返回。服务不接受客户端伪造 actor，也不把自报 agentName 当成授权依据。

## 6. Skill 交付方式

新增 `plugins/toolkit/skills/suiji/SKILL.md`、`references/api.md` 和 `scripts/suiji.py`。该目录可随 Toolkit 分发，也可单独安装；脚本只依赖 Python 3 标准库，不依赖本仓库、rw CLI、数据库、Runweave Backend 或随记服务器 shell。

脚本提供 info、list/search、get、followups、upload、append、complete 命令；轻量封装当前服务的无状态 Streamable HTTP MCP 初始化、工具调用和结构化错误，不实现第二套业务逻辑。实现时对照仓库已安装 MCP SDK 和真实 tools/list，原始接口保持可独立使用。

连接配置使用用户指定的受保护配置文件：规范 endpoint、预期 serverId/ownerId、token 环境变量名。明文 token 由运行环境注入，不写配置、终端参数或项目文件。交接地址只能匹配已配置连接；不把现有 token 发往粘贴文本任意指定的服务器。不匹配时提示配置目标连接并停止。

每次执行先读取服务能力和身份。成功成果写请求先保存至本机权限 0600 的请求文件，按 endpoint/serverId/ownerId/recordId/本次意图隔离；包含原幂等键、参数和附件上传意图，无凭据。上传前冻结文件副本及摘要；重试不能读取已经变化的原文件产生不同 payload。没有自动重放队列，重启仅恢复本地材料；用户明确重试时沿用原请求。确认成功后清理本次本地副本，未知时保留。

Skill 中用明确的调用流程落实最终成果和确认规则，不新增通用 SessionStart/Stop hooks。多个 Agent 的名称/会话标识可不同，但共享所有者权限。会话标识不可用时省略，不伪造可跳转链接。

## 7. 按依赖顺序实施

这是一个共享数据闭环，采用一份总计划、三个独立验收域（服务、客户端、Skill）；每个里程碑均可单独验证。

### M1：合同、迁移和跟进服务

- [x] 新增共享 followups.ts；修改 records.ts、auth.ts、index.ts，复用 limits.ts，字段采用可选兼容语义。
- [x] 新增迁移和 `packages/suiji-server/src/followups/{service,repository}.ts`，扩展 schema.ts；复用 mutations.ts，不改旧请求摘要算法。
- [x] 修改 records/repository.ts、records/service.ts，批量附加摘要；调整附件归属读取/绑定，保证原文编辑不会删除跟进附件。
- [x] 在 src/index.ts 更新支持的迁移版本；当前下一版本为 5，有并行迁移则以实际顺序为准。
- [x] 通过服务用例的事务、并发、迁移和附件合同，才能进入依赖此合同的客户端验收。

### M2：HTTP/MCP 与能力发现

- [x] 修改 http/app.ts 并新增 http/followups.ts；认证由入口决定，调用同一个 FollowupService。
- [x] 修改 mcp/server.ts、schema.ts、router.ts，复用 auth.ts；新增 mcp/uploads.ts，正确隔离 multipart 与 JSON-RPC。
- [x] 补齐 get_service_info、followups 工具、摘要、tag 筛选与结构化错误。
- [x] 用真实 HTTP/MCP 取证验证认证、上传与关停；不能仅凭类型检查认定远程可用。

### M3：Web 与桌面

- [x] 修改 `frontend/src/features/suiji/record.tsx`、workspace.tsx，复用 drafts.ts 与 services/suiji.ts。
- [x] 新增 features/suiji/followups.tsx、followup-actions.ts、record-content.tsx；跟进复用原 EditorModel 的独立模式，避免复制上传与冻结逻辑；共享纯交接格式放 `packages/shared/src/suiji/handoff.ts`，Swift 按同一格式生成。
- [x] 跟进草稿使用独立命名空间，包含 environment/endpoint/serverId/ownerId/recordId；复用 Web Locks，避免同一草稿多标签页同时操作。保存前落盘，未知请求冻结，刷新不自动写。
- [x] 本端成功后刷新摘要；切连接取消旧请求，迟到响应不能写入新身份。摘要更新不能被原记录 version 相等挡住。
- [x] 缺 features.followups 的旧服务隐藏跟进追加/交接入口，不破坏原来的复制正文、编辑和完成。
- [x] 使用真实 Electron 随记抽屉执行 Web 用例，遵循 playwright-cli；如需启动 Dev Session，先使用 runweave-dev-session。

### M4：原生 iOS

- [x] 新增 `packages/suiji-ios/Sources/SuijiIOS/Contracts/Followups.swift`、Features/FollowupsView.swift；State/EditorModel.swift 增加跟进模式。
- [x] 修改 Contracts/Contracts.swift、Features/RecordDetail.swift、DesignSystem/Components.swift、State/SuijiSession.swift、State/DraftStore.swift；复用 Services/APIClient.swift。
- [x] 确保新 DTO 文件进入现有 Swift target；默认缺字段兼容。独立草稿路径和请求冻结不影响原正文编辑器/状态请求。
- [x] 更新 `packages/suiji-ios/scripts/check-mapping.mjs`，用真实服务解码跟进响应及可选摘要；不新增单元测试。
- [x] 申请共享随记 Simulator 槽位，构建并用 agent-device 验证原生交互。不得用 Web 验证或构建成功代替原生验收。

### M5：Skill 与跨机器闭环

- [x] 按第 6 节新增 Skill、脚本、API 参考；更新 plugins/toolkit/README.md 的入口说明。
- [x] 在仓库外独立目录验证脚本及新 Agent 会话的 Skill 发现；安装缓存路径不能依赖当前 checkout。
- [ ] 分别验证终端搜索和复制交接；用第二台真实电脑验证最终成果回到同一记录。
- [x] 没有第二台机器/凭据/网络条件时把跨机器用例记为 blocked，不用同机两个进程冒充。

### M6：文档与发布交接

- [x] 修改 `deploy/suiji/backup.mjs`、release.mjs、readback.mjs：备份清单和恢复核对包含跟进及关系表数量，回读核对跟进与附件；旧备份缺新计数字段时按 manifest.schemaVersion 区分，不能查询旧 schema 不存在的表或忽略新 schema 的缺失计数。原记录修订只核对原字段，跟进按自身表取证。
- [x] 更新 packages/suiji-server/README.md、packages/suiji-ios/README.md、deploy/suiji/README.md、docs/architecture/suiji.md 的当前合同。
- [x] 更新旧 `docs/testing/suiji/mcp-agent.testplan.yaml` 的 7 工具严格断言为 10 个，仍保持原 7 工具未知字段拒绝；不要把新增工具误报成安全回归。保留其他原工具测试合同。
- [ ] 实现完成后把有效合同迁入上述活文档，按文档治理删除临时实施计划。提交、上线、设备安装及 PR 流程由后续执行授权决定，本计划不执行这些操作。

## 8. 兼容、迁移与回退

- 原迁移校验摘要不变；追加 schema，保留现有记录、附件对象、修订和 mutation_requests。旧记录摘要为零，不生成虚构历史跟进。
- 先备份并验证恢复材料，再迁移、部署服务、更新客户端/Skill。备份必须覆盖新跟进表、关系表和附件对象。
- 旧客户端忽略可选字段，可继续编辑/完成；追加不增加父记录版本，所以旧客户端原文编辑不会覆盖跟进。新客户端连接旧服务时关闭新能力。
- schema 5 不能直接启动当前只支持 schema 4 的旧二进制。优先前向修复或部署明确支持当前 schema 的兼容服务；不得为回退删表。若只能恢复旧备份，必须停止写入并单独确认恢复点之后的数据损失，不作为自动回退。
- 并行任务可能增加迁移或改变客户端生命周期；执行前重读就近 AGENTS.md 和当前代码，保持本合同不变。

## 9. 验收与验证方式

本轮配套三个新格式测试计划，每条独立 fixture、独立判定和恢复；均为待实现后的 required 验收：

- [服务与数据合同](../testing/suiji/followups-service.testplan.yaml)：20 条，追加、分页、并发、幂等、附件、认证、回收站、迁移与恢复。
- [客户端交互](../testing/suiji/followups-clients.testplan.yaml)：16 条，Web/桌面与原生分别取证，覆盖摘要、追加、交接、完成、草稿和隔离。
- [Skill 与跨机器](../testing/suiji/followups-agent.testplan.yaml)：13 条，两个入口、只回写成果、确认完成、无自动执行、独立安装与真实远程回写。

现有回归按相关范围执行：[MCP](../testing/suiji/mcp-agent.testplan.yaml)、[记录服务](../testing/suiji/service-records.testplan.yaml)、[Web 录入](../testing/suiji/web-capture.testplan.yaml)、[iOS 录入](../testing/suiji/ios-capture.testplan.yaml)、[备份恢复](../testing/suiji/deployment-recovery.testplan.yaml)。不要默认运行所有无关测试。

实现阶段静态门禁（仓库根目录）：

```bash
pnpm --filter @runweave/shared typecheck
pnpm --filter @runweave/suiji-server typecheck
pnpm --filter @runweave/suiji-server lint
pnpm --filter @runweave/suiji-server build
pnpm --filter @runweave/frontend typecheck
pnpm --filter @runweave/frontend lint
pnpm architecture:check
pnpm docs:check
pnpm testplan:validate docs/testing/suiji/followups-service.testplan.yaml docs/testing/suiji/followups-clients.testplan.yaml docs/testing/suiji/followups-agent.testplan.yaml
```

期望全部退出 0；编译、lint、架构约束或格式失败均不能记为通过。不写单元测试，不运行已无 tracked spec 的 frontend test:e2e 冒充验证。

服务用例使用专用 PostgreSQL 18、真实对象存储和生产业务服务。通过受保护环境提供 DATABASE_URL/MIGRATION_DATABASE_URL；执行 `pnpm --filter @runweave/suiji-server db:migrate` 后确认事件中的 schemaVersion 为实际最新版本，再按包 README 启动专属服务。只操作本例拥有的数据和进程。

原生按包 README 运行 ios:doctor、申请共享槽位、`ios:build --simulator <本次 UDID> --configuration Debug`、`ios:run --task-dir <同一绝对任务目录> --configuration Debug` 以及 mapping:check。UDID、端点、task-dir 从本次环境取得，不复制历史值。Skill 用系统 skill-creator 的 quick_validate.py 检查新目录，按 plugins/toolkit/README.md 验证 manifest；再在新会话进行真实调用。

浏览器必须使用 toolkit:playwright-cli，原生必须使用 toolkit:agent-device；按 toolkit:run-test-cases 逐例执行并保存判定。日志证据只保留 ID、方法、工具名、状态和脱敏结果，不采集凭据。

完成标准：三个新测试计划全部 required 用例有真实 pass；选定原有回归通过；没有原文/附件丢失，没有未确认的自动完成，没有过程/失败跟进，没有追加触发执行。任何环境缺失明确 blocked；格式通过、静态通过、原生行为、跨机器行为分别报告。

## 10. 本次实现与验证范围（2026-09-21）

已落盘服务、Web、独立 iOS、便携 Skill、备份/恢复回读扩展和测试合同。两端沿用现有 EditorModel 的上传、冻结和草稿逻辑，跟进使用独立草稿命名空间；附件 DTO 与记录展示组件单独提取，消除新依赖环。未改变任务状态机、自动执行链路或 AI 检索。

- 静态检查：shared/server/frontend typecheck；server/frontend lint；server build；architecture:check；docs:check；四份相关 YAML 格式均通过。架构检查新运行时及类型环均为 0。iOS Debug 构建、共享 Simulator 安装启动和真实服务 Swift mapping 通过。
- 真实服务检查：SUIJIFUS-001 至 019 对应的 HTTP/MCP/PostgreSQL 场景通过。包含旧 HEAD schema 4 服务写入后升级 5、旧幂等响应保留、并发锁顺序、认证/关闭/过期及文件大小边界。证据 `.runweave/suiji/followups/service-results.json`。
- 恢复：真实 pg_dump/pg_restore 到另一空数据库，复制独立对象目录，启动恢复服务并执行部署模块 authenticatedReadback；33 条记录、101 条跟进、25 个附件读回通过，包含回收站。SUIJIFUS-020 的完整部署入口与异机备份链路仍未验收，不能用本机恢复代替。
- 客户端主链路：当前代码 Beta Dev Session `dvs-4caf5a`/`pool-01` 中通过真实 Electron 抽屉登录、读取 iOS 新成果、复制交接、图片/Markdown 选择、草稿收起恢复及保存；实际服务只新增一条跟进，保留另一端完成状态。独立随记 Simulator `8D2275F3-4483-444E-A034-E6D1FBC59B94` 实际完成摘要读取、复制交接、文字草稿恢复/保存、Markdown 阅读及完成待办。原生与 Web 证据分别保存，不以截图代替服务后置条件。
- 便携脚本：复制 Skill 到仓库外目录，完成上传、追加、附件读取、完成及已完成不重复写。真实代理丢弃服务已提交的成功响应后，0600 冻结文件保留；显式 retry 重放原键仅一个成果。该证据不等同新 Agent 会话的行为遵循或第二台物理电脑验证。
- Skill 单目录 quick_validate 通过。整个 Toolkit 的旧校验器拒绝既有 plugin.json hooks 字段及 product-exploration 元数据；这两处均为本次未修改的基线内容，未顺带调整。

客户端逐例验收补充（2026-09-22）：SUIJIFUC-001 至 016 全部通过。Web 使用隔离 Beta Dev Session `dvs-04c1d0`/`pool-03`；iOS 使用共享随记槽位本次 Debug 构建。两端均实际验证 25 条分页、图片/Markdown、稳定身份交接、完成与撤销、独立草稿、成功响应丢失后刷新/重启且仅手动同键重试、A/B 服务迟到响应隔离和真实 schema 4 旧服务兼容。原生内置浏览器按既有规则拒绝 loopback 网页，因此报告夹具改用局域网 HTTP 地址并实际读取页面标记。证据 `.runweave/suiji/followups-cases/results.json` 及原生任务目录 `.runweave/mobile-qa/suiji-followups-cases`。未修改业务实现或测试合同。

真实 Agent 验收与修复（2026-09-22）：SUIJIFUA-002 首次失败是创建同名成果文件失败后仍 append 旧文件，误写旧测试记录。用户授权分析影响后修复：append 必须显式传入本次选中的 `--record-id`，联网前核对输入文件，后续复用已校验内容；Skill 要求唯一成果与请求文件、创建失败即停止提交。保留原同名旧文件后，真实 Agent 重验只向正确目标写入最新结论，旧记录与旧文件不变。旧 append 调用需补参数；已有冻结请求格式不变，真实原键重试、正常追加和完成检查通过。

继续逐例执行时，SUIJIFUA-012 发现 Agent 将列表中相同正文误判为原请求确认成功。补齐连接关闭及部分响应的 `NETWORK_RESULT_UNKNOWN` 分类，并明确列表不携带幂等键，不能替代原请求确认。真实断连重验中，Agent 报告未确认、保留 0600 原请求；重启后不自动重试，用户明确要求后用原键取得原成果 ID 并清理请求，始终只有一条成果。HTTP401 等明确错误分类保持不变。

SUIJIFUA-001 至 010、012、013 均已通过，包含多页资料与夹带指令、无匹配/多候选、成功只写最终结果、失败不写、完成确认、真实 App 完成后 Agent 不重复写、身份不匹配不联网和真实进程中断后不续跑。A009 使用当前源码 Beta Dev Session `dvs-95df18`/`pool-04` 实际点击；A013 记录了控制脚本识别 Node 包装进程的夹具修正，再在明确阻塞点完成实际中断验收。未修改测试合同。完整轨迹、失败历史、修复重验及累计结果见 `.runweave/suiji/followups-cases/verification.md`。

剩余验收：第二台实际电脑/HTTPS 配置未提供，SUIJIFUA-011 blocked；SUIJIFUS-020 的整条异机部署恢复也 blocked。累计47通过、2阻塞，共49项，因此保留本计划。此前19项服务与16项客户端用例沿用历史真实证据，本轮未重复执行。测试资源清理与隔离备份见同目录 `cleanup-target-guard.json`；没有提交、发布正式服务或安装到真机。
