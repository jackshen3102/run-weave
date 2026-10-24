# Daily Record 多机器定时执行与随记上报计划

日期：2026-10-24。状态：本地实现与隔离验证已推进，真实双机、飞书及定时部署待配置验收。当前操作合同已迁入 Daily Record 的 references/scheduled-reporting.md；本文保留实施范围和未完成的真实验收门槛，不代表生产已部署。

## 1. 已确认的目标与范围

复用 Daily Record，同一份定时任务模板分别在 Mac、devbox 的 Runweave Backend 执行。每个实例只读取所在机器的数据，不从 Mac SSH 调度 devbox，不新增远端采集服务，也不新增通用定时器。

| 执行节点 | 本机 Agent                       | 飞书聊天                 | 飞书文档 | 输出                                   |
| -------- | -------------------------------- | ------------------------ | -------- | -------------------------------------- |
| Mac      | 启用，按配置指定 provider 与目录 | 启用，使用本机本人登录态 | 本次关闭 | 核对后的工作事实与覆盖回执，上报随记   |
| devbox   | 启用，按配置指定 provider 与目录 | 明确禁用                 | 关闭     | 同格式事实与覆盖回执，上报同一随记账号 |

两边使用同版 Skill、采集器和任务提示词，仅机器 ID、来源开关、路径、运行环境和凭据配置不同。devbox 不安装或检查 lark-cli，不持有飞书凭据。飞书范围属于账号，不能按机器重复采集。

最终按北京时间工作日期、项目展示事实。保留讨论、尝试、进展、Agent 反馈、验证等状态，不生成效率评分或次日建议。原始会话和聊天保留在采集机器，随记只存现有事实字段和原生来源标识。

非目标：跨机器自动语义合并、同步原始聊天、SSH 拉取、远端历史浏览接口、飞书消息发送/文档写入、采集随记待办作为新工作、修改待办完成状态、独立模型 SDK、全历史全文索引和来源管理新 UI。

## 2. 已核对的代码现状

| 能力            | 当前事实                                                                                                                                                                                                                                                  | 复用方式与缺口                                                                                           |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 原生 Agent 材料 | [CLI](../../packages/daily-record/src/cli.ts)、[采集器](../../packages/daily-record/src/native.ts) 已有 collect/review/read/validate/render，覆盖 Codex/Pi/Claude/Trae                                                                                    | 保留现有命令和 schemaVersion=1 兼容；新增自动流程的来源筛选，不让未启用 provider 造成虚假缺失            |
| 飞书聊天        | [Skill](../../plugins/toolkit/skills/daily-record/SKILL.md)、[脚本](../../plugins/toolkit/skills/daily-record/scripts/feishu.py)、[规则](../../plugins/toolkit/skills/daily-record/references/feishu.md) 已有本人消息发现、分页、选定消息上下文和材料读取 | 复用独立脚本；调用 discover 时显式指定 --channels messages；不把飞书塞进本机 DailyMaterial/provider 枚举 |
| 整理与导出      | Skill 负责阅读材料、核对并合并事实，现有 TS validate/render 只接受本机材料                                                                                                                                                                                | 为自动流程补跨来源事实校验和统一导出；仍由现有后台 Agent 执行语义整理                                    |
| 随记导入        | [共享合同](../../packages/shared/src/suiji/work-records.ts)、[导入服务](../../packages/suiji-server/src/work-records/imports.ts)、[CLI](../../plugins/toolkit/skills/suiji/scripts/work_records.py) 已有 prepare/import/回读、稳定键和人工字段保护        | 复用设备 MCP、现有事务和身份映射；缺少无人值守恢复入口，不能直接循环调用人工 retry                       |
| 调度            | [Backend 调度](../../backend/src/scheduled-tasks/runtime.ts) 和 [CLI](../cli/scheduled-task-cli.md) 已支持每日任务及 catch-up-latest                                                                                                                      | 只作唤醒；缺日补齐由 Daily Record 自身按日期决定，不能把一次 catch-up 当作已补齐多天                     |
| 全局覆盖        | [工作列表](../../packages/suiji-server/src/work-records/service.ts) 仅汇总收到的 scope                                                                                                                                                                    | 补最小预期来源登记，防止 devbox 未上报时误判全天完整；复用现有 App partial/unknown 展示                  |
| 数据规模        | [本机说明](../../packages/daily-record/README.md) 明确每次全量扫描；单包最多 100 条事实、200 KiB                                                                                                                                                          | 首轮测量真实数据；分批阅读，不无声截断；本期保留单日超限拒绝，不扩展上传协议                             |

旧的 [2026-10-22 研究计划](2026-10-22-daily-factual-record.md) 含远端包拉取和随记来源采集等历史方向，本次执行以本文为准，不扩入那些能力。

## 3. 运行配置与共用任务

新增本机受保护配置。以下字段为拟定合同，非已存在的参数；配置目录 0700，文件 0600，不提交真实配置或凭据：

```ts
type DailyJobConfig = {
  schemaVersion: 1;
  producerId: string; // 首次登记后固定，不用 hostname/路径
  sourceNamespace: string; // 固定导出流，重跑不换
  startDate: string; // 首次采集日期，显式指定，不默认扫描全部历史
  timeZone: "Asia/Shanghai";
  stateDir: string;
  collectorArgv: string[]; // 指向同版已构建采集器；禁止拼接 shell
  sources: {
    localAgent: {
      providers: ("codex" | "pi" | "claude" | "trae")[];
      home?: string;
    };
    feishu: { enabled: boolean; channels: "messages"; accountScope?: string };
  };
  projectAliases: Record<string, string>; // 本机仓库身份到已确认项目名，不按同名目录猜测
  suiji: { configPath: string; tokenFile: string; autoPublish: boolean };
  maxDaysPerRun: number; // 默认 7，从最早未完成日推进
};
```

- scope 使用稳定、无路径的标识，例如 agent:<producerId>:codex、feishu:<accountScope>:messages。accountScope 是本机登记的脱敏稳定标识，与实际登录身份绑定，发现身份变化时拒绝继续。
- producerId、sourceNamespace、startDate 和来源开关变更必须显式校验；换 hostname 不换身份，不能复制 Mac 的机器身份到 devbox。迁移状态目录需连同事项映射和待确认请求迁移。
- startDate 以前不声明覆盖；启用、停用来源按生效日期登记，不能为了让历史变完整而追溯移除缺失来源。
- autoPublish 默认关闭；部署时用户确认的任务草稿须明确包含自动导入、同一冻结请求的有界恢复范围，启用后不逐日重复询问。人工 retry 的既有语义保持不变。

共用提示词只表达：读取本机配置 → 处理未完成日期 → 按 Daily Record 规则阅读整理 → 校验 → 按已授权配置发布 → 回读并报告结果。不在提示词中嵌入 token、另一台机器地址或聊天原文。

时间采用相同的每日 schedule/timezone；具体时刻、两个 Backend 身份、实际项目目录、模型、权限和首次日期属于部署输入。部署步骤通过现有 scheduled-task validate-create 展示完整草稿，按 scheduled-task Skill 确认后再写入。本轮不创建任务。

## 4. 同一条处理链

新增 Skill 脚本 `scripts/job.py`，仅组织本机状态与已有 CLI，不复制飞书 HTTP 客户端、随记认证客户端或模型执行器。拟定命令如下，全部接受 `--config`：

| 命令                                  | 输入与输出                                                                                                       |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| prepare --run-id <id>                 | 核验配置/身份，先发现待确认包，再计算 startDate 到昨天的缺日；返回批次目录、来源开关、需阅读的材料入口与事实模板 |
| validate --batch <dir> --facts <json> | 确定性校验材料摘要、日期、来源、状态、稳定事项映射与包限制；失败不发布                                           |
| publish --batch <dir> --facts <json>  | 先落盘冻结请求，再调用现有随记 prepare/import/独立回读；仅已授权 autoPublish 执行写入                            |
| reconcile --batch <dir>               | 仅处理该批次的已冻结导入；在授权和次数上限内原样重放现有导入入口，复用幂等回执并独立回读；不重新生成事实         |
| status                                | 返回逐日逐来源的采集状态、整理状态、发布状态、剩余日期和明确错误；无写入                                         |

### 4.1 日期与状态

- 默认只处理完整日，窗口为该日上海零点到次日零点，左闭右开。可读先前上下文理解事项，但仅把当天新增行为写入当天。
- 每日每来源记录 complete/partial/unavailable；关闭的来源为未请求，不产生 unavailable。配置启用却目录缺失或登录失败必须记录缺失。
- 本机批次阶段为 prepared → collecting → reviewed → validated → pending → confirmed；失败保留原阶段和错误。另记覆盖状态，不以 confirmed 代表采集完整。
- 只有服务回执及独立回读确认后才完成该版本的上报。partial 包允许保存已知事实，但相应来源日期仍进入后续待补清单。缺一天不能被更晚日期的单一 lastSuccessDate 跨过。
- 每次从最早未完成日处理，最多 maxDaysPerRun 天；预算耗尽保存已完成批次和剩余日期。任务返回明确 remaining-work，不报告全量成功。下次继续原范围，不自动扩大首次日期。
- 同一配置只有一个活动整理批次；用本地原子锁保护状态提交并绑定 runId/批次代际。重复或手动并发执行不得同时分配事项键。活动所有者未确认退出时返回 busy；中断恢复不得仅凭时间到期抢占，旧代写入必须被拒绝。

### 4.2 来源采集与语义整理

- 原生来源沿用 collectNative 的消息身份、时间、注入排除和工具回执逻辑；新增 job 使用显式 provider 白名单，旧 collect 默认行为不变。批次材料带稳定机器身份，旧 hostname 字段仅为显示信息。
- 飞书禁用时，代码不执行 lark-cli 身份预检、不发现飞书候选、不保存飞书 requestedScope。启用时复用 feishu.py discover/review/read/context，只读本人发送消息及选定相关回复，不抓取全部群消息。
- 聊天搜索的 complete 仅指读完该窗口的当前可见搜索结果，不宣称覆盖服务端所有历史。分页或选定上下文失败使对应来源 partial；认证失效不得降级为机器人身份。
- Agent 分日期、项目和会话阅读；截断预览必须按需读全文。整理输出统一包之前的候选事实，逐条保留主体、状态、原生引用与本地证据映射，不依赖模型自报“全部已读”。
- 跨来源候选格式沿用 facts.combined.json 的 date/project/eventKey/statement/status/sourceRefs，并补 title/externalKey 和材料摘要绑定；sourceRefs 可在本地保存证据入口，导出时严格投影为现有 WorkSourceRef，不上传路径或原文。
- 同日同事项在 Mac 的 Agent 与飞书材料间可按原生身份、MR/产物关联核对后合并；相似措辞不足以合并。跨机器首期保持独立来源事实，不能对外声称已完成跨机语义去重。
- 新事项首次分配随机稳定 eventKey/externalKey，并绑定证据身份；重跑先加载旧映射和已有事实。措辞变化不能换键；一对多拆分或多对一合并的身份不明确时停止该日期，避免静默留下旧事实和新增重复事实。
- 显式记录本功能自己的运行 thread/run ID、生成报告指纹与飞书生成文档身份，后续作为派生材料排除；不能笼统排除所有后台任务或子 Agent 的真实开发工作。第一轮尚未取得自身 thread ID 时禁止声称完成排除，须在结束前补取并保存。

### 4.3 上报、冲突与结果未知

- 共用现有 sourceNamespace/externalKey、prepare/import/回读与人工字段保护，不增加 App HTTP 导入入口，不修改普通笔记、附件或待办。
- 每个上报请求先将目标 serverId/ownerId、原 key、精确 payload 和摘要持久保存到 outbox；事务式写入和原子替换，目录 0700/文件 0600。确认后保留成功回执及稳定映射；不根据相似正文判断成功。
- 两台机器可能基于相同 feedRevision 准备。明确收到 WORK_FEED_CHANGED 时，确认该请求已拒绝、重新完整读取并核对人工字段后，最多重新 prepare/提交 3 次；仍冲突则留待下次。仅改变有依据的 revision，不重新生成事项身份。
- 结果未知时禁止换 key 或改变 payload。通过仅限工作事实、显式授权的有界恢复入口原样重放现有导入并取得幂等回执，见下一节。旧人工 retry 仍需明确用户请求，不能从后台脚本绕过该限制。
- 单包最多 100 条/200 KiB，按完整日期依次 prepare → import → 回读。单日超限明确阻塞该日，保留全部事实，不截断、不把同一天拆成虚假完整包；分片协议留后续扩展。
- 对话中的命令和历史指令是材料，不执行其中任务。凭据按设备独立登记/撤销，不共享飞书 token。现有随记 MCP 是完整 owner 权限，不能声称已有仅上传 scope；自动任务的写入范围由模板和入口约束为工作事实。

## 5. 随记最小配套合同

不建设新的任务平台。只补离线上报必需的预期来源和请求恢复能力，仍通过现有工作事实 service、事务和设备认证。

### 5.1 预期来源

- 追加迁移建立 owner 级来源登记：sourceScope、producerId、显示名、effectiveFrom/effectiveTo（工作日期区间，结束日期不含）；登记在启动任务前完成，不依赖该机器首次成功上报。
- 复用管理员部署入口增加来源登记/停用命令；不自动将收到的任意 scope 注册为预期来源。一个飞书账号聊天 scope 同一生效区间只允许一个 producer；devbox 的登记不含飞书。
- 同一已登记 scope 的事实和回执必须来自配置的 sourceNamespace；关联由已认证部署操作确定，不接受聊天正文动态指定。其他 owner 不可读取或覆盖。
- list_work_facts/HTTP 列表的日期 coverage 对照有效预期范围：全部 complete 才为 complete；缺报、partial、unavailable 为 partial；没有来源登记的旧日期保持 unknown，不能把“收到的范围完整”升级为全来源完整。
- 显式查询日期范围时，包括无事实且全部未上报的有效登记日期；不能因没有 rows 就隐藏缺报日。旧未登记日期的历史事实仍可读，不迁移成完整。
- 增加只读 list_work_sources({from,to})：返回有效来源、逐日实际回执与 missingScopes，供 job status/部署验收诊断。现有 App 继续使用 coverage，不新增来源管理页面。
- 来源登记变化与回执变化都推进 feedRevision，保证分页与覆盖口径一致。停用仅影响生效日期后，不删除已有事实或历史缺报。

### 5.2 冻结导入的恢复

不新增上传结果查询接口。现有 `records/mutations.ts` 在执行导入和校验 feedRevision 之前，先按 owner/key 校验操作与请求摘要；同键同参数返回原提交回执，同键不同参数拒绝。并发首次提交由数据库唯一键及事务约束，因此可以复用现有 `import_work_facts` 原样重放恢复结果。

服务继续从认证取得 owner，保留 mutations.ts 的 canonical digest 和旧幂等摘要，不改变其他操作的重试规则。恢复遇到明确 WORK_FEED_CHANGED 时，说明原冻结导入尚未成功且本次被拒绝，才允许按第 4.3 节重新 prepare；超时或连接断开仍是未知结果，不能换键。

新增 CLI `work-reconcile --request <file> --job-config <file>`：仅接受工作事实导入冻结文件，校验服务/账号/来源身份及 autoPublish 授权；最多原样调用 3 次并退避，收到原回执后独立回读。仍未知则保留 pending 并停止该流后续包。其他操作不获得自动重试能力；现有人工 retry 不自动化。

仅来源登记新增 features.workSources；旧 features.workRecords 保留。工作事实自动恢复依赖该版本 CLI 及既有导入幂等合同，不增加服务能力开关。旧服务缺少来源登记时允许本地采集整理并保留 outbox，不声称已启用全来源完整性判断；工作事实能力缺失时不发送导入。

## 6. 文件范围与实施顺序

各步只修改所列职责需要的文件；不得顺手实现旧研究计划的其他渠道。新增源码路径为建议固定入口，内部 helper 可按就近规则拆分。

| 步骤                      | 文件/模块                                                                                                                                                                                                                                                                                          | 交付与通过条件                                                                                  |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 1. 固定机器配置与本地状态 | 新增 `plugins/toolkit/skills/daily-record/scripts/job.py`，`packages/shared/src/daily-record.ts`，必要时新增 `packages/daily-record/src/job-config.ts`                                                                                                                                             | 配置严格校验、来源白名单、逐日状态、原子 outbox 和稳定键；禁用飞书时零飞书调用；不启动新 daemon |
| 2. 复用采集与统一导出     | `packages/daily-record/src/{cli,native,facts}.ts`、`plugins/toolkit/skills/daily-record/scripts/feishu.py`，新增同目录 `job_facts.py`                                                                                                                                                              | 保留旧 collect/validate/render 合同，补 job 的跨渠道候选校验与导出；材料未完整读取时如实标记    |
| 3. 配套来源覆盖           | `packages/shared/src/suiji/{work-records,auth}.ts`、`packages/suiji-server/src/work-records/{service,repository,imports,schema}.ts`、`packages/suiji-server/src/mcp/{server,router}.ts`、`packages/suiji-server/scripts/admin.ts`、新增 `packages/suiji-server/scripts/work-sources.ts` 与追加迁移 | 正确识别未上报来源；owner 隔离；复用原写入幂等合同；来源能力独立声明                            |
| 4. 无人值守发布           | `plugins/toolkit/skills/suiji/scripts/{suiji,work_records}.py`、其 references，Daily Record job 脚本                                                                                                                                                                                               | opt-in 自动导入与有界 reconcile，明确冲突重新准备、未知结果原样恢复；人工字段保护不变           |
| 5. Skill 与部署材料       | `plugins/toolkit/skills/daily-record/SKILL.md`、`references/{feishu,suiji-work-records}.md`、新增同目录 `references/scheduled-reporting.md` 和 `references/scheduled-task.template.json`、`packages/daily-record/README.md`                                                                        | 同一个任务提示词读取不同本机配置；模板不硬编码机器名、时刻、凭据；说明构建/安装前置             |
| 6. 真实双节点验收         | 依下方 YAML、现有任务 CLI 和来源管理员入口                                                                                                                                                                                                                                                         | Mac 实际本机+飞书、devbox 实际原生记录到隔离随记账号；不得用本机复制样本替代 devbox             |

实现就近约束：跨运行时协议在 shared；随记服务不导入 Backend；job 复用脚本和采集 CLI，不把共享类型变成 Node 实现；不新增单元测试。原生 App/Web 本期无需新增 UI，只验证现有 coverage 展示兼容。

## 7. 验证与验收

新增 [多机器定时上报验收](../testing/skills/daily-record-reporting.testplan.yaml)，覆盖来源开关、逐日补报、稳定键、未知结果、并发冲突、来源缺报和真实节点。原生解析/日期/引用继续使用 [本机用例](../testing/skills/daily-record-local.testplan.yaml)、[项目用例](../testing/skills/daily-record-projects.testplan.yaml)；随记事务、人工保护、账号隔离和旧客户端继续参考 [服务用例](../testing/suiji/work-records-service.testplan.yaml)、[客户端用例](../testing/suiji/work-records-clients.testplan.yaml)。旧研究 YAML 不作为当前执行指令，不要求其未实现的随记采集、get_change 或远端拉包。

本轮只运行以下文档/格式检查；实施阶段再运行相应实现检查和真实用例：

```bash
pnpm testplan:validate docs/testing/skills/daily-record-reporting.testplan.yaml
pnpm docs:check
git diff --check
```

实施时按变更运行 daily-record/shared/suiji-server 的 typecheck、lint、build，`pnpm architecture:check`、`pnpm toolkit:validate`；Python 脚本做语法检查和真实隔离 CLI 验证。未修改调度内核不重复改造或验证调度算法；若实际修改，再运行 `pnpm scheduled-tasks:verify-runtime`。执行 YAML 使用 run-test-cases Skill，首个失败停下并记录证据。

验收必须分开记录：文档格式、本机 fixture 行为、真实 Mac/飞书、真实 devbox、随记服务回执与回读、实际每日调度。手动触发成功不等于指定时刻已经调度；构建和健康探测不等于导入成功。浏览器或原生 UI 验收仍走项目对应工具，不用 API 结果冒充。

## 8. 部署、兼容与回退

1. 先用隔离服务追加迁移并验证旧笔记/待办/工作事实无变化；发布服务与独立能力标识，再安装同版采集器/Skill。devbox 已有 Backend 不代表已有 daily-record 构建产物、Python、Agent 登录或非交互式 PATH，必须逐项实查。
2. 在两个节点各自生成固定机器身份、保护目录和独立设备凭据；配置显式首次日期、provider 白名单和项目别名。Mac 单独验证本人飞书身份，devbox 不部署飞书配置。
3. 在随记登记两个节点的有效 scope；飞书只登记给 Mac。先在隔离账号手动执行共用任务，各节点取同一完整日真实材料，对照原文与成功回执。
4. 经用户确认完整定时任务草稿后，分别在指定 Backend 创建同版模板任务。模型、权限、目录和时刻绑定每个 Backend 的实际能力，不自动扩大权限或改全局模型配置。
5. 观察一次真实到点执行；验证 Mac 关闭不阻断 devbox，飞书缺失仍显示缺失；补报不改变工作日期。生产自动写入的启用在具体草稿确认后执行，计划落盘本身不部署。
6. 暂停时禁用两个既有任务，保留本地状态、outbox 和随记事实；需要停用来源时登记结束日期，不清除历史缺报。不删除原始对话、不重置身份、不清空成功记录。
7. 旧 schemaVersion=1 材料和人工导入命令保持可用；新服务迁移不能改写已执行迁移。数据库升级后仅使用支持当前 schema 的服务产物回退/修复，不做破坏性 down。旧客户端继续读取事实，未登记的旧日期保守为 unknown。

完成实现后，将有效合同并入包 README/Skill 引用，再按文档治理删除本计划；不得把计划当成已经部署的当前事实。
