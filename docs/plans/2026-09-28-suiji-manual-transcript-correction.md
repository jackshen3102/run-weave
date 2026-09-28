# 随记手动纠正语音输入方案

> 实施基线：采用[当前原型](../prototypes/suiji-manual-correction/README.md)的显式点词收录。纠错结果应用与词库写入分离；默认勾选和自动学习已取消。

## 目标与范围

用户通过系统输入法语音输入随记正文后，主动点击“纠正文字”，让已登录的服务端 Codex 修正误识别的词、错别字、语法和口语重复。专有名称优先按用户词库纠正。输出必须尽量保持原意、顺序、语气和信息量；不得扩写、总结或补造事实。纠错结果先预览，用户确认“应用到草稿”后才改变本机草稿，仍需另行点击“保存”才写入记录或跟进。预览中可点改正的词，编辑正确写法及可选误识别写法，明确点击“加入词库”后才保存词条。应用纠错结果不会自动学习。

首轮覆盖原生 iPhone 与 Web／桌面随记编辑器的正文和跟进内容。两端共享同一账号词库、服务端纠错规则和 API。用户仍使用熟悉的系统语音输入；本方案不录音、不转写音频、不调用 Codex 的语音输入、不自动监听输入或自动纠错。AI 回顾仍专用于检索记录和回答问题，不承担文字编辑。

本方案依据随记记录 `eeb49b13-fd11-470c-bebc-edd505037e37` 的当前原文“检查一些错别字、前后文的不一致”及本轮补充；该记录当前无跟进和附件。现有编辑器分别位于 `frontend/src/features/suiji/editor.tsx` 与 `packages/suiji-ios/Sources/SuijiIOS/Features/RecordEditorSheet.swift`，草稿保存在 IndexedDB / `DraftStore`；服务端 `reviews/` 是只读回顾任务，不能把它的记录检索提示词直接用于纠错。

交互参考为 [手动纠错可运行原型](../prototypes/suiji-manual-correction/README.md)。原型展示入口、预览、词库和草稿应用的用户意图；其中的替换结果、等待时间和保存状态均为本地模拟，不能证明真实 API、Codex 或同步已存在。

## 用户可见行为

1. 正文非空、草稿可编辑且服务 `info` 声明纠错可用时，显示“纠正文字”。按钮旁说明本次文本和专有词库会经 Codex CLI 发送给模型提供方；只在点击时发请求。服务未启用时显示明确的不可用原因，原输入和普通保存照常工作。
2. “纠错词库”管理专有词条。每条包含一个标准写法和 0–5 个常见误识别写法；例如标准写法 `Runweave`，误识别 `Runwave`。允许仅保存标准写法供 Codex 参考。词库按随记 owner 在服务端保存，两端同步。词库变更不自动改写旧记录或当前草稿。
3. 提交纠错时冻结**本次文本快照**和词库版本；模型只收到文本和该 owner 的词库，不读取其他记录、附件或网页。服务返回候选全文以及最多 10 个仍不确定的原文片段。不确定时保留原词并提醒用户，不能自行猜一个私有名称。
4. 预览显示候选与不确定项，并可展开原文对照。用户可点候选中的改正词，编辑正确写法和可选误识别写法后明确加入词库；也可选中正文短词新增标准词。点击“应用到草稿”仅持久化本机草稿；正文写入云端仍需单独保存。
5. 生成、取消或应用候选，手动修改正文，以及保存记录均不学习词条。已明确加入的词条可撤销；词库版本冲突不能覆盖另一设备，词库写入结果未知时保留同一次幂等请求供用户手动确认。正文变化导致旧候选不可应用。
6. 纠错失败、超时、取消、Codex 未登录或服务重启时，原文及附件、标签、记录版本不变；用户可以手动重新请求。切换连接、登出或关闭编辑器时，旧响应不得进入新连接或新草稿。

## 合同与约束

### 词库

- 新增 schema 7 表 `correction_lexicons`：`owner_id` 主键，`version` 正整数，`entries` JSONB，`updated_at`。没有行等价于版本 0、空词库。新增迁移文件，不修改已执行迁移。后端只接受当前 App Bearer 对应 owner；MCP 不暴露词库。
- `GET /api/suiji/v1/correction-lexicon` 返回 `{ version, entries }`。`PUT` 使用现有 `Idempotency-Key` 与 `mutate()`，请求 `{ expectedVersion, entries }`，整份替换，返回新版本及条目。版本不符返回 `VERSION_CONFLICT` 和当前版本；同键同请求返回相同结果，同键不同请求拒绝。客户端冲突时重读并让用户决定，不静默覆盖另一设备修改。
- 显式收录复用上述 `PUT` 和版本检查：点候选词或选中正文短词后，由用户编辑并确认；已有标准词追加用户确认的别名，新标准词也须用户明确确认。提交前校验别名占用、每条 5 个别名及总量限制。冲突时不自动覆盖或生成新幂等键重试。
- 最多 200 条；标准写法 1–80 个 Unicode 标量，别名最多 5 个、各 1–80 个标量；去首尾空白，禁止控制字符和空项；标准写法与别名在整个词库内不得重复。`[]` 清空词库。输入和响应上限随服务端校验，不能依赖 UI 限制。

### 纠错任务

- `info.features.correction` 为可选布尔值；旧服务未提供时客户端隐藏入口。`SUIJI_AI_PROVIDER=codex-cli` 表示功能已配置；实际 CLI 登录或可执行状态在请求时检查并明确报错，不新增第三方模型密钥。
- `POST /api/suiji/v1/corrections` 接受 `{ text }`、`Idempotency-Key`，文本为 1–20,000 个 Unicode 标量且不能全空白。返回 `202` 的 `{ id, status, createdAt }`；同 owner、同键、同输入复用任务，复用键但更换输入返回冲突。`GET /corrections/:id` 查询进度和成功结果 `{ correctedText, uncertainTerms, suggestedTerms, lexiconVersion }`；`suggestedTerms` 仅用于标记可点词，不执行写入。每项 `{ variant, canonical }` 的 variant 必须逐字出现在请求原文中，canonical 必须出现在候选中。`DELETE` 取消。任务仅在当前服务进程内保留 30 分钟，查询和取消均按 owner 隔离，服务重启后旧 ID 失效。限制同 owner 同时一个任务并设置全局容量、超时与输出长度上限。
- 服务从数据库读取词库快照后启动受限 Codex CLI：无随记 MCP、无 shell/浏览器/文件读取或写入工具，不传数据库/App/MCP 凭据；临时输出文件权限 0600，任务结束清理。提示词只允许保守订正错词、语法、标点和相邻重复，保留原语言、语序、事实、数字、URL、Markdown 结构；词库只是校正依据，原文和词库中的指令均作为数据。结构化输出校验 `correctedText` 非空且不超过正文上限，`uncertainTerms` 最多 10 项且每项必须出现在原文中。无法保证语义等价时不自动应用，最终判断在预览。
- 不把正文、词库、候选、CLI 原始 stderr 写入日志。错误响应只给安全的失败类别；无论成功与否，纠错接口不执行记录写入。为避免请求结果不明时重复启动模型，客户端保留同一任务请求键直到用户确认重试或结束等待。

### 兼容与发布

先部署 schema 7 兼容服务，再发布两端入口；旧客户端忽略 `info` 新字段。`packages/suiji-server/src/index.ts` 当前严格要求 schema 6，发布包要与新迁移一起更新为 7。升级前按 `deploy/suiji/README.md` 做静止备份；旧 schema 6 镜像不能直接运行 schema 7，回退需兼容镜像或从备份恢复，不删除词库表。服务端功能关闭时词库仍可读取，记录和跟进保存不依赖 Codex。

## 实施顺序

1. **共享合同与词库。** 在 `packages/shared/src/suiji/` 增加词库和纠错任务 DTO，扩展 `auth.ts` 的可选能力；新增 `packages/suiji-server/migrations/` 的 schema 7 迁移、`src/corrections/lexicon.ts` 及 `src/http/app.ts` 的 owner 鉴权路由；更新 `src/index.ts` 的 schema 门禁。用隔离 PostgreSQL 验证首次空库、整份替换、版本冲突、同键重放、跨 owner 隔离及迁移后旧记录可读。
2. **受限 Codex 纠错任务。** 新建 `packages/suiji-server/src/corrections/{service,codex,schema}.ts`。复用 `reviews/service.ts` 的任务生命周期和 `reviews/codex.ts` 的受限 CLI 约束，但不复用只读检索桥；不要把两类提示词混成一个模式。检查取消、超时、失败、输出校验、任务归属、服务关闭和日志脱敏。使用真实已登录 CLI 做一组中英混合、专有词、重复口语及数字/URL 样本的结果核对。
3. **Web／桌面编辑器。** 在 `frontend/src/features/suiji/editor-model.ts` 保存纠错请求的原文快照与任务 ID；`editor.tsx` 增加触发、轮询/取消、原文与候选预览、点词确认收录及手动应用；新增词库管理组件，通过 `frontend/src/services/suiji.ts` 的现有连接请求。沿用 `SuijiDraftStore` 与现有编辑锁；候选不进入服务端记录，正文变化或连接变化时拒绝应用旧结果。词库写入使用独立、持久化的请求意图，未知结果沿用原键手动确认。
4. **原生 iPhone 编辑器。** 在 `packages/suiji-ios/Sources/SuijiIOS/Contracts/` 对齐 DTO，在 `State/EditorModel.swift` 管理快照/任务/取消，在 `Features/RecordEditorSheet.swift` 加入口、预览、点词确认收录及词库管理视图。复用 `APIClient` 与 `DraftStore`；`editable` 为 false 时不能应用，响应必须核对当前 client、编辑会话与原文快照。词库写入意图同样先落盘，不能因前台恢复而自动重试。
5. **文档与发布。** 更新 `packages/suiji-server/README.md` 的 API/词库/任务说明和 `deploy/suiji/README.md` 的 schema 7 升级与恢复步骤；发布顺序按上文执行。不得把部署成功、构建成功当作用户界面验收。

## 验收

产品实现后按 [手动纠错验收计划](../testing/suiji/manual-correction.testplan.yaml) 与 [显式收词验收计划](../testing/suiji/manual-correction-learning.testplan.yaml) 在隔离服务、真实 Web 页面和 iPhone App 分别取证。最低门禁：

- `pnpm --filter @runweave/suiji-server typecheck`、`lint`、`build`；`pnpm --filter @runweave/frontend typecheck`、`lint`；原生构建按 `packages/suiji-ios/README.md` 的当前入口执行；`pnpm docs:check`。
- 服务端真实 HTTP/DB/CLI：词库 owner 隔离与版本冲突、同键重放、任务取消和超时、Codex 不可用时普通记录保存、无自动记录写入。模型样本逐条人工判断“只订正、不扩写”；统计通过样本数，不以提示词存在代替效果。
- Web 页面使用 `$toolkit:playwright-cli`，iPhone 使用 `$toolkit:agent-device` 操作真实编辑器：不点击不启动、候选仅预览、原文变化拒绝旧候选、应用仅更新本机草稿、单独保存才更新云端。没有真实交互证据时不宣称 UI 验收通过。

## 风险与处理

- **模型过度改写。** 用保守提示词和结构化输出缩小风险，仍必须让用户对照原文确认；无法以模型自述证明语义不变。
- **私有名称泄露。** 词库仅按 owner 授权，由随记服务经 Codex CLI 发送给模型提供方；不进日志、MCP、外链或公开搜索。UI 在手动触发处说明发送范围；发布前确认实际 CLI 账号及其数据使用边界符合用户预期。
- **草稿覆盖。** 异步任务仅保存快照；客户端比对当前正文、连接和编辑会话后才允许应用，现有冻结/版本冲突机制继续负责云端保存。
- **schema 升级。** schema 7 与旧镜像不兼容，先备份再按服务部署流程迁移；恢复验证必须包含词库行数和样本内容，同时核对记录、跟进与附件。
