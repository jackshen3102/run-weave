# 跨机器、跨渠道的每日事实记录：调研与实施计划

日期：2026-10-22。源码基线：`c372da49`；调研前工作区干净。
本文是待实施计划，文中新增 CLI、文件和接口均未实现；“已验证”仅指下列实际读取。

## 本轮实施范围

用户后续收窄为本机原生 Agent，先看 2026-10-16 至 2026-10-22 的按天记录；无事项日写“没有”。已实现 collect/review/read/validate/render 与配套 Skill，当前合同见 [本地采集工具](../../packages/daily-record/README.md)。本计划中的增量索引、远端导入、Activity 接入、飞书、随记接口和调度保留后续，不作为本轮交付。

## 1. 目标与交付边界

用户明确目标是“纯记录，做记录事实”。把个人机器、工作机器上的 Agent 对话、飞书聊天、随记与相关产物，按日期整理成可回查的事实记录。记录讨论、尝试、实施、验证和产物各自实际发生的情况，保留来源与说话人。

首版交付一个采集 CLI 和一个每日记录 Skill，复用已有 CLI、MCP 与源文件；不新增后台服务、数据库平台或产品页面。采集工具负责材料与完整性，当前 Agent 负责按材料整理事实，确定性工具负责引用校验、渲染与保存。先跑通指定日期，再讨论调度；本计划不创建定时任务、不发布或部署、不修改源待办完成状态。

默认输出为执行机器上的日期目录，Markdown 是可查阅记录，JSONL 与 manifest 保留证据。默认时区采用当前用户环境 `Asia/Shanghai`，作为可修改的实施默认值，并非此前已确认的偏好。首版不生成绩效、效率评价或次日建议。

## 2. 实测现状

调研时间为 2026-10-22，北京时间。除随记成果写回外，本轮业务数据均为只读查询。

| 来源          | 已执行及所得证据                                                                                                                                                                                               | 对实现的约束                                                                                                                      |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 本机 Runweave | 实际调用 `list_sources`、`query_data(activity)` 与 `query_data(content)`，读到事件及完整回复正文；节点 `Y0CW21RFVN`、Stable，Backend revision `c372da49`                                                       | 能作为本机接口；事实留存 30 天、正文 7 天。接口工具请求成功只证明对应操作，不证明用户事项完成                                     |
| 本机 Codex    | 全量扫描现有 258 个 JSONL，按北京时间 2026-10-21 消息时间筛选：19 个会话，79 条 user、262 条 assistant 候选记录，2 个会话在当日开始前已存在                                                                    | 341 是尚未做上下文注入、分支与重复过滤的候选记录数，不是独立事项数；不得只扫当日文件夹或按 mtime 分日                             |
| Pi / Claude   | 分别发现 85 / 16 个 JSONL，读取原生结构；同一日期窗口的候选用户／助手消息均为 0                                                                                                                                | 这两项为该窗口扫描零条，不能据此断言其他机器或日期无活动                                                                          |
| Trae family   | 发现 53 个 JSONL；样本有 `history_mutation` 的 append/replace，items 包含消息、工具和 reasoning                                                                                                                | 现有生命周期 reader 不是完整聊天 reader；不能直接套 Codex 的 response_item 规则                                                   |
| 飞书          | `lark-cli auth status --json --verify` 验证 user 身份；按 2026-10-21 查询本人发送消息，读完全部分页：35 条、11 个会话，35 条均有消息链接；另实测日期范围内的会话消息、话题嵌套回复，以及不指定发送人的日期搜索 | 可以通过已登录 CLI 采集；样本只证明本人发送范围的完整分页，未做全账号所有消息的全量读取。回复、转发、编辑都要保留实际作者与原时间 |
| bytedcli 飞书 | 实际 `feishu user get` 返回 refresh token expired                                                                                                                                                              | 本机首选已读通的 lark-cli，不要求为了同一渠道重新登录 bytedcli；工作机可采用其已有可用 CLI，但必须返回同一材料合同                |
| 随记          | 实测 `get_service_info`、`list_changes`、记录和全部跟进读取；CLI 保护配置也核验了正确 owner/server；当前 schema 9                                                                                              | 已有增量与完整正文能力，但 list_records 时间过滤只针对创建时间。变化元数据无发生时间、无历史状态，不能当“当日完成清单”            |
| 工作机器      | 无已保存 Bifrost 连接；已有设备 key 授权返回 `device_code_not_found`。Runweave profile 仅配置本机；Desktop 另有名为“远程 devbox”的 SSH 配置，但未证明它就是用户说的工作机器                                    | 本轮没有远端正文读取证据。第二采集端身份必须明确；已有 devbox 不能擅自替代工作电脑。远端尚未接入时结果必须标记缺失                |

此前口头提及“8 个跨日会话”使用了 UTC 日期比较；按北京时间 `[2026-10-20T16:00:00Z, 2026-10-21T16:00:00Z)` 复核，正确值为 2。

## 3. 可复用代码与真正缺口

- [MCP 工具](../../packages/runweave-mcp/src/tools.ts)、[Activity 分页](../../packages/runweave-mcp/src/activity.ts)、[来源发现](../../packages/runweave-mcp/src/sources.ts)已有可用能力；search 默认最多扫描 100 个文件，每个只读末尾约 64 KiB，并且文件搜索不接受发生时间过滤。它适合定位，不是每日全量采集 API。
- [通用会话扫描](../../app-server/src/agents/conversation-source.ts)、[Codex 会话读取](../../app-server/src/codex/conversation-reader.ts)可参考身份校验、注入过滤和去重。但扫描有 64 MiB 窗口，传输还有约 8 MiB 预算，不能把 UI 会话接口当无限历史导出。
- [Trae 生命周期读取](../../app-server/src/trae/lifecycle-reader.ts)可用于发现 thread 与状态；完整聊天需读取 history_mutation。替换历史中的旧消息不能按替换发生时间重新算一遍。
- [随记变化查询](../../packages/suiji-server/src/records/changes.ts)、[变化合同](../../packages/shared/src/suiji/changes.ts)已有 owner、sequence 与水位。数据库已保存 revision snapshot 和 created_at，参见[原始迁移](../../packages/suiji-server/migrations/1788739200001-records.cjs)，可以通过只读接口提供准确的版本变化，不必新增写入状态机。
- [定时任务 CLI](../cli/scheduled-task-cli.md)已存在，后续复用；当前无需实现新的调度器。

真正要补的是：按消息时间的完整材料导出、不同来源的统一合同、事实归属与引用校验、可重复保存，以及第二台机器的实际接入。

## 4. 采集接口与数据合同

新增包名 `@runweave/daily-record`。首版提供进程级 JSON 接口，不要求每台机器另开 HTTP 端口。已接入机器可通过现有 MCP 的 run_command 启动 CLI；未接入机器可在其本地导出材料包后导入。之后增加其他 HTTP/MCP 提供方时沿用相同合同。

合同放到 `packages/shared/src/daily-record.ts`，增加 `@runweave/shared/daily-record` 子路径：

- `DayRequest`：`date`、IANA `timeZone`；计算固定 `[from,to)`，正文发生时间与上下文时间分开。
- `Material`：`schemaVersion:1`、`id`、`sourceId`、`machineId`、`provider`、`nativeId`、`threadId?`、`author`、`kind`、`occurredAt:string|null`、`observedAt`、`text`、`locator`、`sha256`、`contextOnly:boolean`、`derivedFrom:string[]`。
- `kind`：`user_message`、`assistant_message`、`tool_result`、`record_snapshot`、`record_change`、`followup`、`artifact`。模型 reasoning、凭据和系统注入不作为事实材料。
- `locator`：来源链接，或原始路径＋字节范围＋源摘要；本地路径标明机器归属。进程内 MCP evidence ID 不能作为唯一长期引用。长工具结果存本机证据文件，材料引用其 hash 与范围。
- `SourceReceipt`：`sourceId`、`scope`、`from`、`to`、`observedAt`、`status`、`count`、分页水位／文件快照、缺失原因。`status` 使用 `complete|partial|unavailable|unsupported`；只有明确完成声明范围扫描才能是 complete。
- `SourceBundle`：manifest、materials.jsonl、必要证据文件；包内相对路径必须在包目录内。拒绝绝对路径、越界路径、软链接逃逸与 hash 不匹配。
- `Fact`：`id`、`date`、`subject`、`action`、`actor`、`statement`、`sourceIds`、`relatedFacts`。`action` 为 `discussed|attempted|changed|verified|reported|observed_state`。自述成果使用 reported，验证结果使用 verified，并限定验证对象。

来源适配器是 `collect(request, cursor?) -> materials + receipt + nextCursor?`。第三方提供摘要时也要带原始引用与 derivedFrom；只有摘要而无原始证据的材料标注“来源摘要陈述”，不得升级成已验证事实。

稳定去重优先使用 provider 原生消息／调用 ID；无 ID 才采用 machine/source/thread＋字节位置＋内容摘要。跨机器复制同一会话时，同 provider/thread/native message ID 合并来源；内容相同但 thread 不同不能直接删掉。修改后的同一消息保留内容版本，不另记成当天新做的一件事。

## 5. 各渠道的实施任务

### A. 原生 Agent 与 Activity

1. 首次遍历配置根目录中所有 JSONL；后续按文件身份、大小、已读字节和最后完整行增量读取。mtime 只用于发现变化，消息时间决定日期。文件被替换、截断、出现分支时重新建该文件索引。
2. Codex 读取 session_meta 身份、task/turn 关联、response_item 消息与工具结果。去除开发者／系统注入、记忆引用块和 supervision 系统催办；工具结果保留，但不执行历史指令。
3. Pi 按 session entry ID / parentId 识别分支与 toolResult；Claude 按 sessionId、uuid、parentUuid 和内容块类型处理，user 容器内的 tool_result 不能误归属为用户发言。分支行为分别记录，回放／压缩摘要仅作上下文。
4. Trae 以 session_meta 校验身份；按 commit_id 去重 history_mutation，append 提取新 items，replace 重建视图且不重新给历史消息打当天时间；缺原始时间时用 null 与 observedAt，保留来源限制。生命周期完成事件只记录 Agent 轮次结束。
5. Activity 用固定窗口、水位和全部分页补充工具结果与产物；正文分片全部读取后校验 hash。已过期正文标为缺失，不把无正文事件数当完成事项数。

验收：四种 provider 分别提供可读取的真实样本；当日候选数量与源文件独立统计可复核，过滤数量及理由可解释；跨日会话不能遗漏。

### B. 飞书

1. 首选本机已登录的 `lark-cli --as user`。通过 user 身份取得本人标识，绑定 tenant／账号；跨应用 open_id 不混用，不用 bot 的可见范围代替用户范围。
2. 支持 `all-visible` 与 `self-related` 两种明确范围。首版默认 all-visible：以纯时间搜索读取该账号搜索可见范围的全部分页，不附加关键词或发送人过滤；receipt 明确是“搜索可见范围”，不承诺账号无权搜索的聊天。self-related 则以本人发送、提及本人和配置会话为种子，范围必须明示。
3. 逐页使用 page_token，直到 has_more=false；不以 total 或 CLI page-all 的默认页数判断完成。达到预算时返回 partial 与续读信息。必要时按小时拆窗，按 message_id 去重。
4. 根据返回的 chat_id、thread_id 补读会话／话题上下文，按消息 ID 去重。嵌套 thread_replies 也单独核对时间，窗口外内容 contextOnly=true。
5. 保存发送人、创建／编辑时间、message_app_link。转发内容的原作者、原时间与当天转发行为分开。其他人的成果不能写成用户完成；会议邀请只记录收到邀请，不据此认定已参加。
6. 图片、语音、文件先保留资源引用和未解析标记；需要理解的附件通过现有 CLI 下载，图片由 Agent 阅读、语音由可用转写渠道处理，均保留原始引用。未处理附件不得宣称内容覆盖完整。

验收：用 2026-10-21 的本人发送查询复核 35 条／11 个会话这一调研基线；这是特定快照样本，后续删除／权限变化需记录差异，不能硬凑数量。all-visible 另独立验收，不能用 self-related 成功替代。

### C. 随记

1. 首次以 list_changes 无 cursor 获取全量基线，处理全部分页；读取可见记录完整正文、全部跟进及本次相关附件。随后保存游标并增量读取，不能只列“今天创建”的记录。
2. 现有 API 阶段：createdAt 明确的新记录与 followup.createdAt 可按日归档；只有当前快照时写“截至采集时为某状态”，不给它编造完成日期。摘要正文不是证据全文。
3. 为准确记录当日修改／完成，独立补齐只读 `get_change({sequence})`：按当前 owner＋sequence 查询 changes，关联对应 revision、前一 revision 或 followup，返回 `occurredAt`、`beforeTaskStatus`、`afterTaskStatus`、对应历史 snapshot／followup。followup 使用其创建时间，record_changed 使用该 revision.created_at；前序缺失时 before 为 unknown。
4. kind=snapshot 的初始清单不是实际发生的变化，不能生成“今天从 open 变 done”。历史已删除记录或当前不可见附件按当前可见性拒绝，不通过 revision 接口复活已删除正文。
5. get_change 是新增能力，需部署服务后实测，未部署时明确采用步骤 2 的受限模式。老服务不支持时不得静默推断。沿用现有 mutation、幂等与游标语义，不修改历史迁移。

验收：旧记录当天新增跟进可检出；准确的状态转换由指定 revision 证明；改标签不能变成“当天完成”。

### D. 第二台机器

1. 当前待补的是工作机器身份及一个可用执行入口；不能根据已有 devbox 名称猜测。该信息只阻断第二采集端接入，不阻断 A/B/C 的开发和本机样本验证。
2. 同一采集工具在工作机器本地执行，回传 SourceBundle 即可；不要求它预装 Runweave，不复制本机飞书／随记 token。使用该机器自身的 Agent 根目录和独立 machineId。
3. 有可用 Runweave MCP 时通过其 list_sources 核对节点，再由 run_command 执行采集；有已授权 Bifrost 时复用连接、按 file policy 下载材料包。当前旧 key 的设备失效，不能当作可用连接。
4. 无远端通道时可以在工作机器终端导出后交付包。这是明确的手动导入模式，不宣称已实现远端自动采集。全渠道验收必须读到该机器真实会话并对照原始样本，不能用本机复制的 fixture 替代。
5. 一台机器离线时生成标注缺失的当日版本；补包后按原日期重生成，同一来源事件不重复计入，旧版本保留以便核查。

## 6. 文件范围与任务顺序

以下均为拟新增／修改，执行者先按就近 AGENTS 复核，不改已有用户修改：

| 顺序 | 文件                                                                                                                                                   | 职责与完成条件                                                                                                             |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| 1    | `packages/shared/src/daily-record.ts`、`packages/shared/package.json`                                                                                  | 上述跨进程合同与子路径导出，类型检查通过                                                                                   |
| 2    | `packages/daily-record/package.json`、`tsconfig.json`、`scripts/build.mjs`、`src/cli.ts`、`src/bundle.ts`、`src/state.ts`                              | Node 22 CLI；collect/import/merge/validate/render，受保护状态、原子保存、schema/hash 校验；不依赖 Frontend 或 Backend 实现 |
| 3    | `packages/daily-record/src/sources/native.ts`、`sources/activity.ts`                                                                                   | 四种 provider 与 Activity 的完整分页／增量导出，各来源覆盖独立                                                             |
| 4    | `packages/daily-record/src/sources/feishu.ts`、`sources/suiji.ts`                                                                                      | 用 argv 数组调用现有 CLI，凭据从保护文件／登录态读取；显式 scope、分页与缺失状态                                           |
| 5    | `packages/shared/src/suiji/changes.ts`、`packages/suiji-server/src/records/changes.ts`、`records/service.ts`、`src/mcp/schema.ts`、`src/mcp/server.ts` | 新增只读变化详情合同、owner 隔离、历史版本和时间读取；不新增状态写路径                                                     |
| 6    | `plugins/toolkit/skills/daily-record/SKILL.md`、`packages/daily-record/src/facts.ts`、`src/render.ts`                                                  | Skill 读取材料形成 facts.json；校验事实引用、作者归属和格式后生成 Markdown；模型不持有任意写目标                           |
| 7    | `packages/daily-record/README.md`、`docs/cli/README.md`、根 `package.json`                                                                             | 文档、`daily-record` 入口和故障处置；不注册调度任务                                                                        |
| 8    | 工作机器上的同版工具及其独立配置                                                                                                                       | 真实导出、导入、对照，给出机器身份与范围证据；本机通过不替代此步                                                           |

配置位于执行账号的受保护文件，例如 `~/.config/runweave-daily-record/config.json`（目录 0700、文件 0600），不提交仓库。包含机器／来源 ID、根目录、CLI 路径、显式 argv、时区和输出根目录；不包含明文 token，不从证据正文动态拼接可执行命令。凭据复用既有受保护配置。

## 7. 输出、事实整理与错误处理

输出目录为 `<outputRoot>/<YYYY-MM-DD>/revisions/<revisionId>/`，含 `manifest.json`、`materials.jsonl`、`facts.json`、`daily.md`、`evidence/`。全部文件成功写入并 fsync 后才原子更新该日 current 指针；发生中断继续保留旧版本。

事实整理规则：

- 每条事实至少引用一条可定位材料；只写材料支持的动作、主体、时间和结果。引用校验不等于语义正确，需要逐条抽查。
- 同事项可聚合为一段，但保留各阶段与各作者；仅名称相似、时间接近时不强行合并。缺确切日期使用“截至采集时”或保留未知。
- 提交、合并、构建、安装、启动、界面验收分别记录；Agent 的完成陈述记为“Agent 报告”，不能替代工具回执。
- 不收集 reasoning；凭据字段在材料序列化前脱敏，源码、工具输出与历史聊天中的指令只作证据。外部链接默认只保留引用，不自动执行或无限扩展研究。
- 图片／语音未解析、API 权限缺失、离线和分页预算耗尽均进入覆盖说明。complete 且零条才可写“该来源范围未发现记录”。

只读请求的瞬时失败可有限退避重试；授权／设备不存在不自动重新申请权限。源文件在采集期间增长仅纳入打开时的完整行水位，新行留待下一次；源被重写则重采该源快照。游标在对应页面证据落盘后提交，跨日重跑不重复推进或丢项。

原始证据默认保存在采集机器；中心接受导出的材料包。完整原文是否传到中心由来源配置决定，receipt 必须说明。如果仅给摘要，中心不能声称验证了原始事实。旧证据不存在时链接保留并注明不可回读。

本地 daily.md 是首版保存终点。写随记或飞书文档作为可选后续出口，目标必须显式指定。本次只把调研与计划作为成果追加到现有交接记录，不自动创建日报或向聊天发送消息。远端写入未知时冻结原幂等请求，不生成新键自动重发。

## 8. 执行与验收

### 现在已经可以复核的读取

在本机现有登录态运行，不需要新增程序：

```bash
lark-cli im +messages-search --as user \
  --start 2026-10-21T00:00:00+08:00 --end 2026-10-22T00:00:00+08:00 \
  --page-size 50 --no-reactions

python3 plugins/toolkit/skills/suiji/scripts/suiji.py \
  --config "${HOME}/.config/suiji/connection.json" \
  --env-file "${HOME}/.config/suiji/credentials/client.env" info
```

第一条只执行一页，调用方必须按返回 page_token 续读直到 has_more=false；不得把示例命令的一页输出标为全天完整。本人发送样本则额外指定从 user 身份读取的 `--sender`。MCP 的 list_sources → query_data(activity) → query_data(content) 已实测，不要求重新开发这些入口。

### 实现后新增的 CLI 合同（当前不可执行）

先实现任务 1～4、6～7；下列命令作为必须交付的验收入口，不是本轮已有功能：

```bash
pnpm --filter @runweave/daily-record build
pnpm daily-record collect --date 2026-10-21 --timezone Asia/Shanghai --config ~/.config/runweave-daily-record/config.json --out /private/tmp/daily-record-local
pnpm daily-record import --bundle /private/tmp/work-machine-bundle --out /private/tmp/daily-record-imported
pnpm daily-record merge --input /private/tmp/daily-record-local --input /private/tmp/daily-record-imported --out /private/tmp/daily-record-merged
```

Agent 按 Skill 从合并包生成 facts.json 后：

```bash
pnpm daily-record validate --materials /private/tmp/daily-record-merged --facts /private/tmp/daily-record-facts.json
pnpm daily-record render --materials /private/tmp/daily-record-merged --facts /private/tmp/daily-record-facts.json --out /private/tmp/daily-record-output
```

正常退出 0；可用但缺来源的 collect/merge/render 返回 2，仍保存 partial 产物；输入、身份、校验或内部失败返回 1，不能发布新的 current。Skill 可以接受明确 partial 产物，但不得忽略校验失败。merge 是可重复去重操作，同包导入两次不重复生成事实；render 对同一 facts 与 manifest 生成相同正文。

### 验证与通过门槛

- 实施阶段运行 `pnpm --filter @runweave/shared typecheck`，以及新增包必须提供的 `typecheck`、`lint`、`build`；涉及随记详情时运行该服务的 `typecheck`、`lint`、`build`，并实测部署后的新增只读工具。
- 新增 Skill 按 skill-creator 流程编写，运行 `pnpm toolkit:validate -- plugins/toolkit/skills/daily-record`；执行 `pnpm architecture:check`、`pnpm docs:check`。不新增单元测试代码。
- 行为验收使用配套[每日记录测试计划](../testing/skills/daily-record.testplan.yaml)。现有 [Research MCP 计划](../testing/architecture/research-mcp.testplan.yaml)只覆盖底层读取，不能替代新采集与事实规则。
- 本机端：指定完整日期的材料清单可独立复算，包含跨日会话；多页数据全部读取，缺失来源如实标记。
- 飞书端：真实日期查询和至少一条完整话题读取成功，能点回原消息；他人工作／旧转发不变成用户当天完成。
- 随记端：当天跟进可检出，当前完成状态与当日完成转换分开；只有部署并读取变化详情后才验收准确历史状态变化。
- 第二机器端：真实机器导出与中心导入成功，machineId、源会话与日期匹配；这一门槛当前尚未具备，不能以本机 fixture 判通过。
- 最终至少选一个真实日期生成 daily.md，逐条事实回查来源；无无源事实、无作者错归、无把轮次结束当事项完成，重跑不产生重复。工作机缺失时只能交付标明缺失的版本，不算全渠道验收通过。

## 9. 风险与回滚

初版只读源数据、写独立产物目录。禁用来源或删除新增工具即可停止采集，不清理用户会话、聊天和随记。新增只读随记接口可独立回滚，已有 MCP 工具保持兼容；不改变 schema 9 的历史迁移或 mutation 请求摘要。

机器身份、凭据过期、搜索索引可见性、超大日志与历史压缩是明确风险；分别由来源绑定、权限状态、scope receipt、增量／快照边界与保留原始定位处理。不能用配置存在、服务 healthy 或模型自述替代真实数据读取。

本轮交付限于调研、实施计划及验收合同；未实现上述新 CLI，未部署机器采集端，未生成实际日报。
