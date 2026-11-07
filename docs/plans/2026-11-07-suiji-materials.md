# 随记「素材」分类与手机分享实施计划

状态：A/B/C 实现已落盘，已完成下列隔离验证，整体验收仍有待完成项。2026-11-07 已完成隔离 PostgreSQL/HTTP、Swift DTO、Simulator 分类/编辑和隔离日报图片消费验证；真机系统分享与正式启用尚未完成；Web 兼容编辑交互已于续跑通过，不代表功能已上线。

## 1. 已确认目标

- 入口在现有「记录」Tab，增加「素材」分类；不新增 Tab，不放到「工作」下，不使用「今日素材」名称。
- 接收用户主动分享的截图、文字和链接，备注可选；保存时不等待 AI。
- 保留今天、昨天及更早的素材，支持日期筛选；整理完成不删除原材料。
- 现有每日任务读取素材，与 Agent、飞书、浏览和屏幕事项合并；结果继续沿用现有工作记录/总结入口。
- 原型是布局意图，不替代现有行为：现有「全部、想法、待办」全部保留，在其后追加「素材」。保留标签、搜索、下拉行为、浮动新增按钮和四个底部 Tab。

## 2. 当前事实与设计取舍

| 当前代码                                                       | 事实                                                 | 本次处理                                                        |
| -------------------------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------- |
| `packages/suiji-ios/Sources/SuijiIOS/App/SuijiRootView.swift`  | 记录页按 kind 筛选，当前只有 note/task               | 增加独立分类筛选，不把 material 加进旧 kind 枚举                |
| `packages/shared/src/suiji/records.ts`                         | 正文、标签、附件和版本已有共享合同                   | 素材作为 note 的显式子类，增加可选 metadata，保持旧客户端可解码 |
| `packages/suiji-ios/Sources/SuijiIOS/State/DraftStore.swift`   | 新记录共用 `new` 草稿，按身份隔离                    | 分享使用独立 UUID 队列，不能复用或覆盖普通 `new` 草稿           |
| `packages/suiji-ios/Sources/SuijiIOS/State/EditorModel.swift`  | 冻结请求、附件上传及手动重试已存在                   | 提取可供扩展使用的最小保存能力，保留既有幂等合同                |
| `packages/suiji-ios/Sources/SuijiIOS/Services/APIClient.swift` | 凭据缓存与刷新锁只在进程内                           | 扩展加入后需要跨进程凭据协调，不能直接复制两个 APIClient        |
| `packages/suiji-server/src/auth/service.ts`                    | refresh 会轮换同一个 session 的 access/refresh token | 刷新前重新读共享 Keychain，App 与扩展互斥刷新                   |
| `packages/suiji-server/src/mcp/attachments.ts`                 | 已可向 Agent 返回实际图片                            | 日报阶段复用读图，首版不在分享界面等待 OCR 或模型               |
| `plugins/toolkit/skills/daily-record/scripts/job.py`           | 采集来源没有随记素材                                 | 增加显式来源、变更发现、来源版本与处理回执                      |
| `packages/suiji-server/src/work-records/imports.ts`            | 稳定 externalKey/eventKey 更新已有事实，保护人工字段 | 复用导入事务，增加素材消费回执，避免另起日报系统                |

首版范围：单张 JPEG/PNG 图片、一段文字、HTTP(S) 链接及可选备注；可同时携带一张图与文字。沿用每条一张图片、每附件 5 MiB、正文 20,000 Unicode 标量的上限。分享来的图片必要时转换/压缩，超限须明确提示，不能静默丢掉第二张图或截断文字。

非目标：全手机后台采集、多图拼接、音视频转写、自动抓取链接全文、自动识别来源 App、独立生活日报、改写历史周报、自动部署或创建新的定时任务。链接只说明收到该链接，不能据此生成正文阅读结论。

## 3. 用户行为

### 3.1 分享与手动新增

1. 系统分享菜单选择「随记」，进入轻量面板：预览、可选备注、归属日期、保存按钮。按钮默认「记入今日」；日期改为过去日期后改为「保存素材」，避免文案矛盾。
2. 默认为 Asia/Shanghai 当天；归属日期可以选择过去日期，首版不接受未来日期。实际采集时间、服务端创建时间始终保留，不随归属日期变化。
3. 点击保存先持久化独立草稿，再执行一次上传/保存；云端确认后结束分享扩展，不要求切换到随记主 App。
4. 断网或扩展被系统结束后，草稿保留。未确认显示「待发送」或「保存结果待确认」，主 App 素材列表上方提供待发送入口与手动重试。恢复联网、启动、登录、回到前台不自动触发业务重试。
5. 未登录时明确提示先登录随记；没有已验证身份时，不把材料绑定到随后任意登录的账号。分享内容只保留在当前面板，未落盘时不能显示已保存。
6. 素材分类内点新增默认创建素材；其余分类仍沿用原默认待办与草稿恢复规则。编辑器增加「素材」选择与归属日期，普通想法可显式转为素材。素材转为想法表示停止后续纳入；转待办需先退出素材分类，不静默清理 metadata。

### 3.2 记录列表与日期

- 「全部」包含素材；「想法」仅普通 note；「待办」维持原行为；「素材」只显示素材 note。分类是业务字段，不占用现有最多两个标签的额度。
- 素材列表默认全部日期，按归属日期倒序分组，再按采集时间和 ID 倒序。日期可选今天、昨天或起止日期；列表分页、搜索和日期共同绑定游标。
- 标题优先显示用户文字/备注；纯图显示「截图素材」，纯链接显示链接或收到的标题，不伪造 AI 摘要。原图可打开，卡片注明截图/文字/链接。
- 正文和备注可搜索；首版不宣称已支持图片文字或链接全文搜索。
- 状态与上传分开：本机「待发送/结果待确认」；云端「待整理」；当前版本被日报处理后「已整理」。编辑已整理素材后变为「待重新整理」。
- 「已整理」表示处理了该版本，包括经审阅后合并到已有事项或无需单独成条，不等于必然新增一条总结。
- 已整理素材继续可见。删除进入既有回收站；取消素材分类/删除后停止新采集，已生成总结不会随之删除，操作处说明这一点。首版不自动撤回既有总结或周报。
- 日期筛选下没有内容时显示空态，不能隐藏历史或把「今天没有」表述为「没有素材」。

## 4. 子计划 A：服务端合同与素材生命周期

### 4.1 合同

保留 `RecordKind = note | task`，新增 `SuijiRecord.material?: MaterialMetadata | null`。缺省/null 表示普通记录。新增 `features.materials` 与 `features.workMaterials`，分别表示存取/消费能力。

建议明确以下字段，命名可在实现前统一调整，但语义不可省略：

```ts
type MaterialInput = {
  captureId: string; // UUID；每次用户保存的稳定身份
  capturedAt: string; // 带时区的 ISO 时间，来自客户端，属于用户提供数据
  materialDate: string; // YYYY-MM-DD，Asia/Shanghai 业务日期
  inputType: "image" | "text" | "link";
  sourceUrl?: string; // 仅 HTTP(S)，不自动请求
};
type MaterialMetadata = MaterialInput & {
  sourceHash: string; // 服务生成的当前内容摘要；不包含处理回执字段
  processedVersion: number | null;
  processedAt: string | null;
};
```

- 原始分享文字与用户备注均保存于 body，使用清晰分段；图片由 attachmentIds 关联。无需另建图片仓库。用户备注必须与截图内识别内容区分。
- `POST /api/suiji/v1/records` 接受可选 material；存在时 kind 必须 note，captureId 对 owner 唯一，同身份不同内容不能覆盖。
- `PATCH /records/:id` 的 material 缺省保留、null 取消分类、对象更新元数据；captureId/capturedAt 创建后不可改，归属日期可改。沿用 expectedVersion。旧客户端只更新 body 时必须保留 material。
- processedVersion/processedAt 为只读，App 不能伪造。处理状态在读时由 record.version 与 processedVersion 推导，处理回执不递增正文版本。
- sourceHash 也只读，由服务使用既有 canonical digest 对当前正文、归属元数据、版本及有序附件 ID/内容摘要计算；采集器使用服务返回值，避免 Python/Swift/TS 各自序列化导致不一致。原图读取仍须验证附件身份与实际内容，不能仅有 hash 就视为已阅读。
- `GET /records` 增加 `category=idea|task|material`；无参数维持旧列表行为。material 分类增加 `materialFrom/materialTo`（包含两端业务日期）。现有 from/to 仍表示创建时间，不能偷换语义。materialFrom/To 只与 material 分类组合。
- 创建、编辑、取消分类、删除/恢复均经既有事务写 revision 与 record_changes。归属日期、分类和附件变动必须能从变化流发现。

### 4.2 存储、权限与兼容

- 追加迁移创建 `record_materials` 和素材处理回执存储；以 owner/record 关联，captureId 唯一，禁止修改已执行迁移。运行时 schema 支持号从实施时实际最大版本递增。
- record/revision/metadata/变更日志与业务幂等响应共用同一 PG client 事务；修改先锁 records 行，保持既有锁顺序。
- HTTP 使用原 App 会话，MCP 使用原设备凭据；owner、actor 由认证入口确定，客户端不能传。原图访问仍遵守附件 owner 和回收站边界。
- 保持旧请求哈希：旧 payload 没有 material 时，不在幂等摘要中自动补 material:null。
- 旧客户端读取素材可显示普通 note；更新时省略新字段必须保留。显式改 kind=task 但仍为素材时拒绝并说明需要新版完成分类转换。
- 上线顺序：追加迁移和兼容服务 → 新 App/扩展 → 日报来源启用。旧服务不声明能力时隐藏分类及分享保存，不降级为会被误认为已接入日报的普通笔记。
- 回滚先关闭消费与新建入口，保留记录、附件、回执和冻结请求；不执行删表式 down migration。旧服务 schema 范围不兼容时不得直接回退旧二进制。

### 4.3 文件范围及完成条件

- 修改 `packages/shared/src/suiji/records.ts` 及现有 suiji 导出/ServiceInfo 合同；新增 `packages/shared/src/suiji/materials.ts`。
- 修改 `packages/suiji-server/src/schema.ts`、`records/service.ts`、`records/repository.ts`、`records/changes.ts`、`http/app.ts`、MCP schema/注册入口；新增 `src/materials/service.ts`，承载素材校验与处理回执。
- 追加 `packages/suiji-server/migrations/` 迁移；更新 `src/db` 实际 schema 门禁。
- 完成条件：真实隔离 PostgreSQL/HTTP 中创建、分类、日期、分页、修订、回收站、旧 payload 重放和跨 owner 拒绝均可独立取证。

## 5. 子计划 B：iOS 分享扩展和记录分类

### 5.1 运行边界

- 在现有 `Suiji.xcodeproj` 增加 Share Extension target、独立 Info.plist/entitlements，使用正式宿主同一签名团队；宿主 Bundle ID 保持不变。
- 新建轻量 `SuijiCaptureCore` Swift target：仅包含扩展需要的 DTO、身份范围、保存队列、上传与认证能力；主 App 依赖它。扩展不能整体导入含 Clarity、浏览器或主 App 生命周期的 SuijiIOS target。
- 使用 App Group 存放独立捕获队列和当前已验证连接快照；凭据通过 Keychain Access Group 共享，不放共享偏好或正文文件。将已有登录安全迁入共享组：先读旧凭据、写新组并回读成功后再切换，不要求用户重新安装。
- 队列键包括 environment、规范 endpoint、serverId、ownerId、captureId。每项先复制 NSItemProvider 的临时内容到自有目录，再原子写 manifest；扩展退出后材料仍可读。
- 每项保存时持有跨进程文件锁；App 与扩展不能同时提交同一项。普通 Swift actor 不足以实现此约束。进程结束释放锁，文件状态保留；不能靠删锁文件抢占活跃提交。
- 凭据刷新也须跨进程串行：锁内重新读 Keychain，确认是否确需刷新，保存轮换后的 token。所有请求读取最新凭据。共享锁有界等待，超时保留队列并允许手动重试，不能阻塞分享界面无限等待。
- 切换环境、退出或更换 owner 后取消旧操作；队列继续属于原身份，不得自动迁移。重登相同身份后才可读/重试。正式与开发即使 URL 相同也要隔离。

### 5.2 保存状态机

`editing → queued → sending → confirmed`；确定失败回 queued，未知结果进入 uncertain。每次用户点击保存的原始 payload、上传键和记录键都先落盘。重试沿用原键、原附件及原 payload。uncertain 状态不能编辑内容或使用新键绕过，先确认原结果。确认成功后才移除队列文件；清理失败时仍保留 confirmed 标识，下一次不再次创建记录。

不把扩展中的系统取消等同于删除已排队材料。已入队内容在主 App 提供明确查看/处理入口；取消按钮在落盘前只是放弃本次输入。图片读取失败、格式不支持或多图输入均保留可恢复界面并解释，不能显示成功。

### 5.3 文件范围及完成条件

- 修改 `packages/suiji-ios/Package.swift`、`ios/Suiji.xcodeproj/project.pbxproj`、宿主 entitlements；新增 `ios/SuijiShare/` target 文件与 `Sources/SuijiCaptureCore/`。
- 修改 `Sources/SuijiIOS/Services/APIClient.swift`、`Credentials.swift`，按最小范围提取公共能力；原普通记录和跟进状态机不改变。
- 修改 `Sources/SuijiIOS/App/SuijiRootView.swift`、`State/SuijiSession.swift`、`State/EditorModel.swift`、`Contracts/Contracts.swift`、`Features/RecordEditorSheet.swift`、`RecordDetail.swift`、`DesignSystem/Components.swift`；新增素材卡片/日期过滤/待发送队列视图，避免继续扩大根视图。
- 修改 `frontend/src/services/suiji.ts` 及必要的记录编辑序列化：只做新字段保留/类型兼容，不默认重做 Web UI。旧页面编辑素材后元数据和日期不得丢失。
- 完成条件：真实 iPhone 从截图分享菜单保存，回到来源 App；主 App 的记录/素材分类可看到原图、备注、日期。连续分享与普通草稿同时存在，彼此不覆盖。签名、构建、安装、真机交互分别报告。

## 6. 子计划 C：每日任务消费与回执

### 6.1 来源发现和读图

- `sources.materials` 默认关闭；配置 enabled、effectiveFrom、accountScope。仅在一个明确指定的既有日报生产者启用，沿用 sourceNamespace/producerId，不新建调度或默认在所有机器打开。
- 新增 `channel=suiji-material`，scope 绑定 serverId/ownerId；nativeId 使用 recordId，revision 使用 record.version，hash 覆盖实际读取的正文、material 元数据及附件内容摘要。不得把原文/URL/本机路径塞进 work sourceRef。
- 使用既有 `list_changes` 维护本地素材索引，首次扫描及增量分页均完整读到冻结终点；随后 `get_record/read_attachment` 读取当前可见版本。只纳入 material 非空、未删除、归属日期在生效范围内的记录，其他普通笔记和日报输出不进入来源。
- checkpoint 与待处理索引原子保存；扫描成功可以推进扫描游标，但消费完成只能随发布确认推进。中断后重放同一材料，不会因为游标已前移而漏掉。
- 来源 complete 只说明当前登记范围内已上传的素材已读完，不代表手机全天活动完整，也不代表手机没有离线待发送项。
- 对已确认日期收到新素材、修改或改日期时，重新安排受影响日期，不限于最近七天；生效日以前的材料保留可查看，但不自动回填旧日报。归属日期与上传日期分开。
- 截图必须通过真实图片读取送入具备读图能力的执行模型，文字化 read 命令不能替代图片。为当前日报执行环境验证一次真实图片输入；模型不支持或图片读取失败时标记 partial/待整理，不能只根据文件名或备注假装看图完成。
- 阅读后再次校验版本；并发编辑导致版本改变则重新采集。跨日重分配保留原 eventKey/externalKey，不能把日期或版本塞进事实身份。与其他来源共享事项时，只移动属于改日期素材的当天事实，不能移动其他来源证明的进展。

### 6.2 发布与「已整理」

扩展 `ImportWorkFacts` 的可选 `materialResults`，每项包含 recordId、recordVersion、内容 hash、outcome（included/merged/no-new-fact）、关联 eventKeys；字段缺省时旧导入合同不变。

- include/merge 要求 eventKeys 指向本次导入或明确复用的同 owner 事实，sourceRefs 保留真实材料引用。无新增结论可记录 no-new-fact，但仍需实际阅读；不要为显示已整理强行编造事实。
- 服务在导入事务中校验素材仍属于该 owner、仍有效、版本/hash 相符；任一过期则拒绝此次事务，不确认旧版本。处理回执与工作事实导入原子提交，不能先标记已整理再导入。
- 回执只更新 processedVersion/processedAt，不改变 record.version，也不产生会导致反复消费的内容变化事件。客户端从服务器读取状态，不能在上传成功后本地直接改成已整理。
- 发布结果未知时按原冻结请求恢复；确定被版本冲突拒绝后才重新 prepare/read/validate。成功后独立回读事实与素材回执。
- 重复执行沿用稳定事实身份；多来源合并保留所有依据。手改的事实字段与手改周报沿用原保护规则。改日期与取消/删除不得自动清理人工结果。
- 素材只能证明用户提供的内容。截图中的成功提示不能独立生成 verified；生活内容可记为未归类事实，不强塞项目，也不据此扩建第二套日报。
- 删除/取消素材阻止后续读取，但不追溯擦除已生成总结；编辑会重新处理当前版本，旧成果只按现有稳定身份和人工保护合同更新。对需要撤回既有结论的情况，保留人工编辑入口，不在首版新增自动删除协议。

### 6.3 文件范围及完成条件

- 新增 `plugins/toolkit/skills/daily-record/scripts/job_materials.py`；修改 `job.py`、`job_state.py`、`job_facts.py`，支持素材启用迁移、变化索引、图片阅读、稳定身份和旧日期重处理。
- 修改 `packages/shared/src/suiji/work-records.ts`、`packages/suiji-server/src/work-records/schema.ts`、`imports.ts` 与素材服务；更新实际 Swift work DTO 和 MCP 参数校验消费者。
- 同步 `plugins/toolkit/skills/daily-record/SKILL.md`、`references/scheduled-reporting.md`、`references/suiji-work-records.md` 及随记服务/原生包 README，明确人工素材与原有来源语义。
- 完成条件：真实图片和文字进入隔离日报，来源原图可回读、事实不重复、回执与版本一致；已确认的旧日期收到素材后能补报。隔离链路通过后，按实施授权升级正式服务/App并启用原任务来源，分别验证手动触发与自然到点执行。

## 7. 验收与实施顺序

详细新增用例见 [素材保存与分类验收](../testing/suiji/materials.testplan.yaml)及[日报素材消费验收](../testing/skills/daily-record-materials.testplan.yaml)。计划编写阶段只校验了 YAML 格式；本轮实际验证及未完成项见第 8 节。

顺序：A 服务合同 → B 分享及分类 → C 日报消费 → 整体回归与正式启用。A/B/C 各自有完成条件，任一步通过不代表整个功能完成。

实现时执行：

```bash
pnpm --filter @runweave/shared typecheck
pnpm --filter @runweave/suiji-server typecheck
pnpm --filter @runweave/suiji-server lint
pnpm --filter @runweave/suiji-server build
pnpm --filter @runweave/frontend typecheck
pnpm --filter @runweave/frontend lint
pnpm architecture:check
pnpm --filter @runweave/suiji-ios ios:build --simulator <已申请设备UDID> --configuration Debug
pnpm --filter @runweave/suiji-ios mapping:check
pnpm testplan:validate docs/testing/suiji/materials.testplan.yaml
pnpm testplan:validate docs/testing/skills/daily-record-materials.testplan.yaml
pnpm docs:check
git diff --check
```

`mapping:check` 使用保护环境中配置的隔离真实服务，新增素材 DTO 往返映射，不只验证编译。Simulator 按随记共享设备池申请；真机按 agent-device 工作流执行。Web 兼容交互按 playwright-cli 验证；需要 Dev Session 时使用对应 skill。不新增单元测试。

回归复用 [原生录入](../testing/suiji/ios-capture.testplan.yaml)、[服务记录](../testing/suiji/service-records.testplan.yaml)、[工作事实服务](../testing/suiji/work-records-service.testplan.yaml)、[日报上报](../testing/skills/daily-record-reporting.testplan.yaml)。选择受影响用例，不把整套不相关检查强加到提交阶段。

主要风险及失败判定：

- 扩展签名/App Group/Keychain 权限缺失：构建或真机启动失败，不能用主 App 保存代替分享验收。
- 进程中断或结果丢失：任何材料丢失、重复创建、误报成功均失败。
- 分类和日期：原待办入口消失、昨天材料被归到上传日、分页漏项均失败。
- 日报消费：读图未完成却已整理、旧版本被标记、重复事项、素材回流采集自身总结均失败。
- 不将采集、上传、模型处理、发布回读、自然调度视为同一个证据层。交付时逐项说明已通过和未通过项。

## 8. 本轮实施记录（2026-11-07）

- 服务 schema 13：追加素材、captureId 唯一身份和版本处理回执；复用记录修订/变化流及工作导入事务。
- iOS：独立 SuijiCaptureCore 与 SuijiShare target、App Group/Keychain 权限、跨进程锁、独立持久队列；素材分类、日期筛选、编辑和待发送入口。
- 日报：显式 materials 来源、完整变化流索引、实际图片下载与读取回执、旧日期重处理、稳定事实身份及导入后独立回读。
- Web：编辑保留素材 metadata，素材不能在旧编辑器直接转待办。
- 初轮未部署正式服务/App；后续用户单独授权的服务端升级已完成，见 8.3。正式 App、日报素材来源及定时任务未变更。

已取得的行为证据：

- 独立 PostgreSQL 迁移到 13；HTTP 15 项检查覆盖创建重放、capture 冲突、未来日期/类型拒绝、分类、日期分页/游标、旧客户端兼容、回执、过期版本整笔回滚、回收站和取消分类；另验证跨 owner 拒绝。
- 真实 HTTP → 生产 Swift Codable → JSON 往返验证含 material 字段及工作事实。
- Simulator 安装并实际操作分类、素材新增、日期筛选；HTTP 独立回读新建记录，昨天无素材显示筛选空态。
- 实际 Simulator 截图经上传、MCP 图片读取与 SHA256 校验，送入当前 Agent 读图后才确认消费；缺图片阅读回执时 validate 拒绝。隔离日报发布及素材回执回读成功。
- 素材从 11 月 6 日改为 10 月 22 日后，两天重处理；同一事实更新为版本 2、总数仍 1；再 prepare 无剩余日期。
- 最终服务代码在真实 PG 事务中拒绝将含其他来源证据的事实随素材整体改日期，检查后回滚验证事务。
- Shared/Server/Frontend 类型检查，Server/Frontend lint，Server 与 iOS Debug（含扩展）构建、架构及文档检查、两份 YAML 格式验证均通过；最终 Simulator 安装后重新打开成功。

证据目录：`.runweave/suiji/materials-20261107/`、`.runweave/mobile-qa/suiji-materials-20261107/`。
本轮隔离 HTTP/PG 已停止，模拟器 lease 已释放；开发连接地址和用户名已恢复，未删除验证数据。

未完成的验收：真机签名/App Group 权限、系统分享菜单保存、离线及进程中断、跨进程并发刷新、正式执行模型读图、自然调度。
初轮 Web 交互受 Browser resolver 无法连接阻塞；续跑恢复后已通过真实 UI 与独立 HTTP 回读验证，见 8.2。
Simulator 主 App 交互和扩展构建不能替代真机分享验收；本计划仍不标记整体完成。

### 8.1 真机验收续跑（2026-11-07）

- 已按 agent-device 核对 iPhonejackshen（iPhone 17），USB 连接、Developer Mode 已开启；首次锁屏，随后再次预检通过。未启动旧版 App 冒充当前源码验收。
- 使用该设备现有有效描述文件核对签名团队，执行当前 Suiji/SuijiShare Debug 真机构建（仅命令行注入签名团队，关闭本次包的 Clarity）。未修改产品 Bundle ID 或工程默认签名。
- 实际构建失败：Apple 返回 `Unable to process request - PLA Update available`，要求开发者账号接受新版 Program License Agreement；宿主与扩展的现有 profile 均缺少 App Groups capability 和 `com.apple.security.application-groups` entitlement。本机现有 profile 无可用的 App Groups 替代项。
- 因当前包无法签名安装，MATERIAL-003～010（真机系统分享、连续分享与普通草稿隔离、离线/进程中断、丢响应、身份切换、跨进程刷新）仍未通过，统一依赖签名解锁。设备预检不是这些行为的通过证据。
- 曾尝试将生产 CaptureCore 编译为本机双进程辅助工具，连接真实隔离服务；运行未取得完成证据，未将其列为 iOS 行为验证。未修改生产 Core 来绕过权限，未新增单元测试。
- 最小解锁动作：由开发者账号持有人审阅并处理新版 Apple 协议；之后重跑当前签名构建，生成宿主和扩展所需的 App Groups profile，再继续真机验收。协议接受不能由现有实现授权推定。
- Web resolver 阻塞无新恢复线索，本轮未重试该路径。未部署正式服务、未安装当前包到真机、未启用正式来源。

本轮证据：`.runweave/suiji/materials-device-20261107/build.log`、`.runweave/mobile-qa/suiji-materials-device-20261107/preflight.json`。临时 HTTP、故障代理及 PG 均已停止；真机未启动自动化 runner，没有遗留设备占用。

### 8.2 Web 兼容编辑验收（2026-11-07）

- 当前终端 Browser resolver 已恢复返回，已成功附着同终端 Profile/Group；旧超时原因未取得证据，不宣称修改了 resolver。没有切换独立浏览器、借用身份或重启 Stable。
- 使用当前 worktree 的 Dev Session `dvs-5f6be5`，planner 选择 `beta`，占用 `pool-01`；源版本 `6040ae96ba818355aa7f602f1416972612245d20` 加本轮未提交改动。通过 `dev:open --surface desktop` 返回的 CDP 验证真实 React Web 前端（Beta 桌面 renderer）。
- 隔离服务 CORS 原仅供本地验证，实际登录发现缺少 `runweave://app` 来源；仅补齐本次隔离服务的明确来源后登录成功，未修改正式服务配置。
- 实际操作：开发账户登录 → 随记 → 带截图的素材详情 → 编辑；归属日期显示 2026-11-05，待办按钮禁用；修改正文、返回再打开后草稿和素材限制仍保留；点击保存成功，网络 PATCH 省略 material，使用 expectedVersion=1。
- 独立 HTTP 回读同一记录：版本 1→2、正文逐字匹配；captureId、capturedAt、materialDate、inputType、sourceUrl 及全部附件保持一致；下载原图 SHA256 一致，浏览器实际打开图片并解码成功。
- 验证范围是本次 Web 编辑兼容，不代表 iOS 分享、纯浏览器全部环境、生产部署或定时消费已通过。

证据目录：`.runweave/suiji/materials-web-20261107/`（before/after JSON、独立回读结果、编辑器及图片截图）。

收尾：Playwright 已 detach，Dev Session `dvs-5f6be5` 已停止，pool-01 lease 已释放；隔离 Suiji HTTP 和 PG 已停止。文档检查与 diff 检查通过。

### 8.3 正式随记服务升级（2026-11-07）

用户追加授权更新随记服务端后，沿用 AWS 现有手工 Compose 发布流程完成升级；未扩展到手机安装或日报来源启用。

- 当前工作区服务构建输入冻结为源码归档，SHA256 `f76239f8b6052a220039e72501dc00fb9502f80e63643aad90ff1b69a3fbc669`，基于 HEAD `6040ae96ba818355aa7f602f1416972612245d20` 加本轮实现；没有提交或切换工作区。远端不可变镜像 `sha256:249f50e1400da71583cc705260fc0eddd3abe867e3e9c11a557da288c0d06cf1`。
- 先正常停止 API，保存数据库、附件与部署元数据，6 个备份文件及清单复制至独立 Mac 并逐一校验 SHA256。备份位置：`~/.runweave/server-backups/aws-18.140.158.81/suiji/f76239f8-materials-20261107/backup`。
- 同一静止备份在隔离容器恢复，116 个附件哈希一致；实际新镜像迁移 12→13，原有 24 张业务表、旧迁移摘要保持不变。正式迁移同样通过表摘要和三个受保护配置文件校验。
- 正式 HTTPS 升级前后全量鉴权读回均为 234 条记录、380 条跟进、116 个附件，服务与 owner 身份一致。API healthy、重启次数 0，原低内存覆盖、持久数据、AI 登录、配置和凭据保留。
- App HTTP 与现有 Mac MCP 凭据均验证 `materials/workMaterials=true`、素材日期过滤和原记录读取；MCP 发现 21 个工具（含 `get_material_result`）。旧分类、回收站、标签、工作事实及桌面 Origin 通过；未鉴权 401、未列入来源 403。
- 未为验收写入生产业务记录；未更新手机、未启用日报素材来源，正式模型读图与自然调度仍未验收。旧 schema 12 镜像不能直接回退到当前库。

证据：`.runweave/suiji/materials-deploy-20261107/`。远端发布目录 `/srv/suiji/releases/f76239f8/`；部署操作记录已同步。隔离恢复容器已移除，无遗留构建进程。本次服务端更新完成，不代表整体计划验收完成。
