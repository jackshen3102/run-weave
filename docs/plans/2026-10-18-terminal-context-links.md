# 任务交接中的随记关联与成果溯源实施计划

日期：2026-10-18。粒度：L2；账号隔离、关联并发和会话身份部分给出确定合同。
状态：已获用户授权实施，产品代码已落盘；正式验收尚未全部完成，暂保留此计划。未更新 Stable 或手机，未提交或发布。

## 1. 目标与范围

在现有 Terminal 的“任务交接”中，让用户按需关联一条已有随记，阅读原文与补充，查看关联会话中的成果报告，并回到其真实来源。解决回翻与出处定位，不要求用户维护新的任务系统。

界面基线为[终端上下文关联原型](../prototypes/terminal-context-links/README.md)。后续用户已明确要求“实现这个计划”，实现范围以本文合同为准。

范围：

- Web / Electron 共用的任务交接侧栏、关联选择弹窗与只读原文阅读。
- 终端列表增加小型关联标识；不移动或重新排序终端、项目、worktree。
- 对已有会话阅读增加从来源定位消息的能力；保留终端输入与草稿。
- 必要的随记连接复用、设备本地关联持久化、来源字段和请求隔离。

非目标：独立任务中心、看板、自动建卡、自动改写目标、进度百分比、自动派发、自动写入随记成果或状态、跨电脑同步关联、自动选择另一台电脑、自动新建/恢复终端、原生 iOS 改版、更新 Stable/手机、提交或合并代码。

不重新设计随记页面、Browser 或长任务监控，不改其现有业务语义。随记服务、数据库、MCP、CLI、App Server 的协议与进程生命周期不在改动范围。

## 2. 当前代码事实

| 已有能力                                | 入口                                                                                                                                                                                                                                                    | 与原型的差异                                                                       |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 按 terminal / panel / thread 保存交接卡 | [共享合同](../../packages/shared/src/task-handoff.ts)、[服务](../../backend/src/task-handoff/service.ts)                                                                                                                                                | 目前没有随记关联；结果是建议性摘要，不是验收证明                                   |
| 从原生历史和 Activity 配对请求/结果     | [source.ts](../../backend/src/task-handoff/source.ts)、[evidence.ts](../../backend/src/task-handoff/evidence.ts)                                                                                                                                        | 原生来源编码在 evidence.id 中，缺少用于新导航的显式结构化来源字段                  |
| 任务交接查看、刷新、编辑目标和继续验收  | [panel.tsx](../../frontend/src/components/terminal/handoff/panel.tsx)、[HTTP 客户端](../../frontend/src/services/task-handoff.ts)                                                                                                                       | 需要增加原文来源视图，不能用原型替换掉未讨论的现有功能                             |
| 随记账号恢复与 HTTP 读写                | [connection.tsx](../../frontend/src/features/suiji/connection.tsx)、[accounts.ts](../../frontend/src/features/suiji/accounts.ts)、[SuijiClient](../../frontend/src/services/suiji.ts)                                                                   | 当前连接由页面持有，不能直接从交接面板复用；两个独立客户端会引入重复刷新凭据的竞争 |
| 跟进分页和可选 Agent sessionId          | [跟进读取](../../frontend/src/features/suiji/followups.tsx)、[合同](../../packages/shared/src/suiji/followups.ts)                                                                                                                                       | sessionId 单独不是电脑、面板与消息身份，不能据此猜测或恢复原会话                   |
| 原生会话阅读及阅读位置恢复              | [会话面板](../../frontend/src/components/terminal/conversation/panel.tsx)、[use-conversation](../../frontend/src/features/terminal/conversation/use-conversation.ts)、[阅读位置](../../frontend/src/features/terminal/conversation/reading-position.ts) | 已有 data-conversation-message 锚点，尚无外部定位请求的完整消费合同                |
| 绑定当前身份读取会话                    | [HTTP 客户端](../../frontend/src/services/terminal/conversation.ts)、[Backend 路由](../../backend/src/routes/terminal/conversation.ts)                                                                                                                  | 可复用 expectedThreadId，不需要另建一个执行器或让 TUI接收定位命令                  |

本计划依据源码，不据此声称当前安装版本已具备或已经验收这些能力。

## 3. 两项原型到实现的明确修正

1. **tmux 不按消息 ID 滚动。** “回到原会话”先核对原终端与面板、切回该终端，再在已有“会话阅读”里定位并高亮对应消息。不得伪装成已定位 TUI 的历史输出。定位完成后，用户可以关闭阅读页继续在原终端输入。
2. **示例中的成果类别不是自动分类需求。** 保留现有交接卡的报告和证据；只展示记录本身明确的 Web、模拟器或设备信息，不依据文字猜出真机验收结论，也不生成未经来源支持的缺口。“相关会话”只来自用户已建立的本机关联，不解析跟进 sessionId 后自动认领。

若原终端不存在、已换 thread、电脑不在当前连接范围，显示原会话不可用。保留已读来源摘录及关联元数据，提供查看已保存记录；不新建终端，不把同名终端当替代目标。

## 4. 用户可见行为

### 4.1 默认与已有功能

- 打开现有任务交接入口；未关联时展示当前会话原生输入、最近回复及已有交接信息，不要求先建随记。
- 已关联时增加关联标题、随记状态、原文、分页跟进入口及相关会话。现有目标编辑、刷新、继续验收和证据查看继续可用，放在其原有语义区，不因新增内容删去功能。
- “本轮最新输入”来自原生用户消息；不能取模型生成目标、终端回显或监督注入文本。读取不到则显示来源不可读，不把旧消息标成最新。
- “后续补充”列表按来源显示 app 或 agent 和时间；不把 Agent 跟进统一标为“你”，也不默认每条跟进都是新增用户要求。
- 侧栏只读，不追加成果、不完成/归档/修改随记；状态标签读取随记服务的实际状态。

### 4.2 按需关联

1. 点击“关联随记”，复用当前随记环境与账号；未登录时引导打开既有账号设置，不在交接中提供第二套登录表单。
2. 搜索现有、未删除记录，复用 `/api/suiji/v1/records` 的当前搜索与分页合同；有更多结果时必须有分页入口，不只查第一页。
3. 选择记录，展示原文、当前状态、最新跟进摘要和打开完整跟进的入口。
4. 确认前重新 GET 记录与最新跟进信息。正文版本、跟进序号、删除状态或账号身份变化时，停止旧确认，展示变化并由用户重新确认；不自动重试确认。
5. 写入当前来源目标的本机关联。每个 terminal/panel/thread 在同一随记账号身份下最多一条关联；同一记录可显式关联多个会话。
6. “关联操作 → 解除当前会话关联”只删除该条本地关系，不删随记、跟进、其他会话或终端。

原文与跟进读取复用现有 RecordBody、附件读取规则与不可执行 Markdown。首屏展示有界摘录并明确有更多内容；完整跟进按 cursor 加载，不把第一页当全部。原文阅读返回后保留交接位置与终端草稿。

### 4.3 成果来源

- 当前会话报告沿用真实交接结果和 evidenceIds。相关会话只展示本机曾实际读到的报告，标明会话、工作区和读取时间。
- 原会话可用时显式刷新；不可用时只能显示“上次读取”的摘录，不宣称实时。
- 工具请求/结果只有在现有唯一配对成立时沿用“执行记录”标识；单条 Agent 报告保持“报告”。这些均不等于用户接受或整体任务完成。
- 只有完整且经当前 Backend 核对的定位身份才出现可执行“回到原会话/查看对应回复”。旧数据或仅有随记 sessionId 时提供查看摘录，不猜消息、电脑或 worktree。
- 切换前保存前端已有阅读位置；复用 workspace-store 的终端/面板选择，不写 composer、PTY 或发送任何 Agent 指令。

## 5. 数据归属与接口合同

### 5.1 随记连接复用

将 connection.tsx 中的连接生命周期提取到新增 `frontend/src/features/suiji/connection-provider.tsx`，保留已有账户 UI 与 accounts.ts 的凭据落盘方式。抽屉和任务交接共享一个当前环境的 SuijiClient；账号设置页消费同一控制器，不再持有独立的刷新会话。

控制器提供当前 environment、client、info、generation、连接状态与已有设置入口。切环境、退出或修改账号立即取消旧 client，请求结果必须核对 generation 和 endpoint/serverId/ownerId 后才能写 UI。关闭抽屉不关闭其他可见消费者正在使用的连接；应用根卸载才统一释放。

只在用户打开随记或调用关联入口后初始化连接，不让全部终端在启动时登录随记。密码、access/refresh token 不进入关联存储、Backend 请求、URL、来源档案或日志。

### 5.2 设备本地关系

新增 `frontend/src/features/terminal/handoff/context-link-store.ts`。采用独立 IndexedDB 数据库 `runweave-handoff-links-v1`（版本 1），不升级或复用随记草稿数据库。

```ts
// 仅前端使用的本地模型，不进入 shared。
type LocalHandoffLink = {
  schemaVersion: 1;
  linkId: string;
  backend: {
    connectionId: string | null;
    apiBase: string;
    endpointId: string | null;
  };
  target: {
    terminalSessionId: string;
    panelId: string | null;
    threadId: string;
  };
  projectId: string;
  suiji: {
    environment: "production" | "development";
    endpoint: string;
    serverId: string;
    ownerId: string;
    recordId: string;
  };
  confirmedSource: { recordVersion: number; latestFollowupSequence: number };
  revision: number;
  linkedAt: string;
};
```

- 主键为规范化 backend 身份 + target + 随记 environment/endpoint/serverId/ownerId，不包含 token 或瞬时请求 generation。
- `links` store 保存关系；`observed-sources` store 只缓存该关系下实际读到的交接卡结果和有界证据摘录（保留原限制、来源目标、card revision、observedAt），不建立全量会话镜像或后台采集器。
- 每次读写携带当前账号完整身份；切换账号时立即清空内存视图，旧账号数据不出现在新账号或终端标识中。
- 读取时同时检查当前 projectId、terminal、panel、thread 和当前 Backend。代次变化只使在途工作失效，不把正常重连当作新记录命名空间。
- 增改删在一次 IndexedDB readwrite 事务内比较 expectedLinkId 与 expectedRevision。初建要求不存在；重复同内容可返回现值，异内容冲突。每次解除后再新建生成新的随机 linkId，避免旧 revision 恰好相同时旧请求误改新关系。
- 同一次事务写入关联及当前已核实的来源缓存；缓存绑定 linkId，解除时只清理该 linkId 的缓存，其他关系不受影响。事务失败不给成功反馈。存储不可用时仍可阅读来源，但不能宣称关系已经持久化。
- 同页面使用共享 store；跨标签页通过 BroadcastChannel 只广播变更键及 revision，接收端重新读库，不广播正文、凭据或直接覆盖内存。

关联确认不是跨随记云服务和 IndexedDB 的分布式事务：确认前的云端重读与本地保存之间仍可能出现新跟进。关系记录保存当时看到的版本；后续打开/显式刷新时重新核对并展示新内容，不承诺消除这个时间窗，更不回写或覆盖云端正文。

### 5.3 复用现有读取接口

- 随记：`GET /api/suiji/v1/records`、`GET /api/suiji/v1/records/:id`、`GET .../:id/followups?cursor=...`；沿用当前鉴权、cursor 和删除可见性合同。跟进页非完整快照，确认比较使用记录版本加最新 sequence，不能只比较父记录版本。
- 当前交接：沿用 `GET /api/task-handoff/:id?panelId=...`，保留原有刷新与编辑接口，不新增远程随记代理。
- 当前原生输入/消息：复用 `GET /api/terminal/session/:id/conversation?panelId=...&expectedThreadId=...`；来源暂不可读时明确降级。仅侧栏打开时按已有完成/输入变化刷新，不在所有终端新增全文轮询。
- 后端身份变化返回现有 `CONVERSATION_TARGET_CHANGED` / 409，终端缺失或来源缺失沿用现有错误/availability；跨会话导航遇到这些结果停止，不偷偷切到新 thread。

### 5.4 来源字段与定位

为 `packages/shared/src/task-handoff.ts` 的 TaskHandoffEvidence 增加可选 `origin`：

```ts
origin?: {
  target: TaskHandoffTarget;
  provider: "codex";
  turnId?: string;
  messageId?: string;
  activityEventId?: string;
};
```

- 原生消息从真实 turn/message 构建 origin，工具事实从真实 Activity scope/event 构建，不能由模型输出定位字段。
- 后端组装时核对 origin.target 与读源 target 一致；来源不能完整取得时保留摘录并不提供精确定位。
- 不依赖解析 `native:turn:message` 字符串补造旧记录；旧 evidence 没有 origin 时保持当前查看行为，下次真实读源可以补齐，不为补字段自动调用模型。
- 新增前端 `conversation/navigation.ts` 的一次性定位请求，包含稳定 backend 身份、完整 ConversationTarget、messageId、requestId 和来源页位置；打开目标阅读页后再次校验 response.target，找到 `data-conversation-message` 后定位并消费请求。
- 原生用户输入与监督输入的区分复用当前监控来源过滤规则；不能把 `runweave-task-supervision` 正文显示为用户新要求。若当前阅读合同无法可靠区分，补充明确的来源标识或隐藏该条，不用模糊文本猜测其他用户消息。
- 目标可用但消息不存在/不在当前返回范围时显示“无法定位该条回复”，保留阅读页与来源摘录；不高亮近似文本或其他轮次。
- 历史只读浏览可复用 Work History 的现有数据与身份核对，但本轮不增加跨电脑恢复、历史终端重建或运行指令。

## 6. 修改文件与任务顺序

| 步骤 | 文件/模块                                                                                                                                                                                                                              | 交付及检查                                                                                      |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 1    | `frontend/src/features/suiji/connection-provider.tsx`（新）、`connection.tsx`、`connection-model.ts`、`drawer.tsx`、`frontend/src/App.tsx`                                                                                             | 抽取共享连接，账号页/抽屉原操作不变；检查无重复 token 刷新、退出与环境隔离                      |
| 2    | `packages/shared/src/task-handoff.ts`、`backend/src/task-handoff/source.ts`、`evidence.ts`                                                                                                                                             | 补真实 origin，不改变模型判断、配对或旧卡读取；验证来源身份与旧数据降级                         |
| 3    | `frontend/src/features/terminal/handoff/context-link-store.ts`、`use-context-link.ts`（新）                                                                                                                                            | 本机关联、事务冲突、来源缓存和账号隔离；验证关联/解除/重开页面                                  |
| 4    | `frontend/src/components/terminal/handoff/panel.tsx`、新增 `source-reader.tsx`、`suiji-link-dialog.tsx`                                                                                                                                | 原文/跟进阅读、搜索分页、来源与状态反馈；复用现有 UI Dialog、RecordBody 和统一 overlay presence |
| 5    | `frontend/src/features/terminal/conversation/navigation.ts`（新）、`use-conversation.ts`、`reading-position.ts`、`frontend/src/components/terminal/conversation/panel.tsx`、`frontend/src/components/terminal/preview/panel/index.tsx` | 完整身份导航、一次性消息定位与返回；不能写终端输入                                              |
| 6    | `frontend/src/components/terminal/session/session-tab.tsx` 及其 strip 调用                                                                                                                                                             | 当前账号下存在关联时显示小图标；不改变状态点、终端顺序和 worktree 邻接                          |
| 7    | `frontend/docs/task-handoff.md`、必要的随记连接说明与本计划引用的验收 YAML                                                                                                                                                             | 更新实际合同与验证证据，不把原型数据作为产品完成证据                                            |

实现前重新读各目录 AGENTS.md，保留当前未提交的原型。组件文件可按职责再拆分；任何新增跨运行时 DTO 进入 shared，不把纯前端本地模型迁入公共包。

## 7. 兼容、失败与回退

- 旧交接卡与旧客户端：origin 可选，旧字段/旧接口不删除；未关联默认不制造新数据，现有继续验收语义与输入保护保持。
- 本地新库首次按需创建；旧随记草稿、已有交接 JSON、历史与数据库不迁移、不重写。回退旧前端只是看不到关联，新库保留，不回填到其他状态。
- 云服务 401：复用现有认证恢复；恢复失败显示登录入口，清除当前可见私人摘录，不自动切账号。404/删除：显示记录不可用，仅允许解除本地关联，不偷偷读取回收站。
- 网络故障：已登录同一账号可显示注明读取时间的本地摘录，不能当成当前最新要求；未认证时不展示缓存正文。
- 账号/Backend/terminal/panel/thread 切换：取消在途读取和确认，迟到结果不覆盖新界面，不重放写入。
- 原始关联消息不足：显示只有摘录/来源不完整，不猜测执行归属。多个 Agent 报告可以共存，不能把一条报告当作全部工作完成。
- 本地保存结果不确定：重新读库核对同一 linkId、revision 与内容；不自动重放云端业务请求。
- 所有回退都不删终端、worktree、随记或历史，不把临时不可达当成需要新建的理由。

## 8. 验收与门禁

新增[任务交接上下文关联验收](../testing/terminal/task-handoff-context-links.testplan.yaml)，覆盖真实服务、账号身份与来源定位。现有原型的 23 项检查只证明模拟交互，不替代该计划。

实现阶段静态门禁：

```bash
pnpm --filter @runweave/shared typecheck
pnpm --filter @runweave/backend typecheck
pnpm --filter @runweave/backend lint
pnpm --filter @runweave/frontend typecheck
pnpm --filter @runweave/frontend lint
pnpm architecture:check
pnpm docs:check
pnpm testplan:validate docs/testing/terminal/task-handoff-context-links.testplan.yaml
```

真实验收用 toolkit:run-test-cases 按 YAML 逐条执行，浏览器用 toolkit:playwright-cli。需要 Dev Session 时先按 toolkit:runweave-dev-session 取得隔离实例，不操作 Stable、生产随记或无关终端。验证同一实现的 Desktop 与纯 Web；原生 iOS 不在此次通过范围。

必须证明：手动关联、云端变化后重读、多个终端/账号隔离、来源精确定位、草稿不变、本地关系重开保留、不可用时不创建替代执行、原有交接继续路径不回归。命令通过、截图或格式校验不能代替这些后置状态。

实际进展（2026-10-18）：

- 共享随记连接、本机关联事务、原文/附件/分页跟进、真实 origin、会话阅读定位及终端标识已实现；当前合同已更新到 `frontend/docs/task-handoff.md`。
- shared/backend/frontend 类型检查、backend/frontend lint、架构检查、文档检查和 15 条 YAML 格式校验均通过。
- 独立 Beta `dvs-97791e` / `pool-04` 中正式执行 HCL-001～003 通过：包含云端不变核对、25 条跟进与附件读取，以及父记录版本不变但跟进序号变化时的再次确认。
- HCL-004 前提受阻：Desktop CDP 的 `Target.createTarget` 返回 Not supported；`dev:open --surface web` 返回不支持的 `runweave://app/index.html`，无法取得同源双页的合法测试入口。严格顺序执行停在这里，HCL-005～015 未作为正式用例执行，不能计为通过。
- 另做单页补充诊断：旧 linkId 解除被拒绝且新关系保留、BroadcastChannel 通知重读、事务中止后错误反馈与关系保留、页面重载恢复、A/B 环境账号切换隐藏与恢复、精确 messageId 高亮，以及旧面板来源停止跳转。它们不替代双页并发、完整草稿保护、原生浮层或纯 Web 验收。
- 证据与运行记录位于本工作区 `.runweave/handoff-context-20261018/`，只使用隔离 Backend、临时 PostgreSQL 和测试账号；原型截图不作为实现证据。

剩余验收需要同一实现可用的纯 Web 地址及支持创建同源双页的受控 CDP。该依赖涉及 Dev Session surface 能力，不能通过偷偷降级 profile 或手动替换入口绕过。其余正式用例仍须继续按 YAML 核对，不能把当前静态门禁与补充诊断当成全量验收。全部完成后再按文档治理清理本临时计划。
