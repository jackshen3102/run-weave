# 终端页面一键独立代码 Review 实施计划

状态：待实施。粒度：L2，身份与回传部分按执行级约束。本文和配套 YAML 仅定义方案，不表示功能已实现或验收通过。

## 1. 已确认的产品目标

在桌面 / Web 和原生 iPhone 的终端页面，统一通过现有「更多（…）→ 代码 Review」菜单项发起评审，不新增独立顶栏按钮。用户点击菜单项后直接开始，系统创建一个普通、可见的独立 Reviewer 终端；系统负责启动、交办、观察和结果回传，来源终端中的 Agent 无需执行命令或承担调度。

审查对象是点击时当前工作区变更页所对应的变更。**Reviewer 不接收来源终端的对话、用户需求摘要、历史任务、分析、结论、任务标题或会话身份。** 来源绑定仅由 Backend 保存，用于状态展示和结果回传。用户无需确认审查范围。

第一版完成后保留 Reviewer 终端与报告，不自动隐藏或删除。每次新的 Review 创建新任务和新对话，避免上次评审结论影响下一次；未结束的同源请求复用当前运行，避免重复启动。

### 非目标

- 不实现隐藏终端、自动销毁终端或专用 Review 管理中心。
- 不按来源对话猜最后一个任务，不回顾该终端的历史任务，也不默认审查整个分支。
- 不判断实现是否符合原对话里的需求；只根据代码、仓库规则和通用正确性标准评审。
- 不自动修复、提交、合并、发外部消息或写随记；点击 Review 不授予这些权限。
- 不把普通代码 Review 自动升级为三模型投票、辩论或 `review-with-runtime-evidence` 专属流程。
- 不新增单元测试代码；不把本轮工具探测通过当作新功能的端到端验收。

## 2. 当前代码事实与复用边界

| 当前入口                                                                                                                                                                                          | 已有能力                                                                                   | 本次处理                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| [任务 CLI](../../packages/runweave-cli/src/commands/terminal-task.ts)、[任务服务](../../backend/src/terminal/tasks/service.ts)                                                                    | create/start/send/observe，固定终端、面板、thread 与启动代次，派发去重                     | Backend 直接调用服务；来源 Agent 不调用 CLI                            |
| [任务存储](../../backend/src/terminal/tasks/store.ts)                                                                                                                                             | 持久化 dispatch/review，重启交回 human                                                     | 保留原安全语义；新增 Review 编排记录，不把通用任务服务改成隐式自动恢复 |
| [工作区变更](../../backend/src/terminal/preview/git.ts)、[内容读取](../../backend/src/terminal/preview/change-content.ts)                                                                         | staged 为 HEAD→index，working 为 index→working；含未跟踪文件、重命名、内容版本和不可读状态 | 复用同一范围与读取规则，冻结成审查输入                                 |
| [输入准入](../../backend/src/terminal/runtime/input-admission.ts)、[输入投递](../../backend/src/terminal/application/input-dispatcher.ts)                                                         | 输入版本、草稿保护、短时互斥、目标校验                                                     | 回传复用，不清空或提交用户草稿                                         |
| [生命周期装配](../../backend/src/bootstrap/terminal-task-monitoring.ts)                                                                                                                           | 统一资源清理与任务服务                                                                     | 在同一生命周期下注册 Review owner                                      |
| [Web 终端头部](../../frontend/src/components/terminal/workspace/header.tsx)                                                                                                                       | 当前连接、终端、面板、工作区上下文及 MoreHorizontal 下拉菜单                               | 在现有更多菜单增加入口，固定点击菜单项时的目标                         |
| [iOS 终端](../../packages/app-ios/Sources/RunweaveIOS/Features/Terminal/TerminalScreen.swift)、[操作菜单](../../packages/app-ios/Sources/RunweaveIOS/Features/Terminal/TerminalActionsMenu.swift) | ellipsis 原生终端操作菜单与状态模型                                                        | 在现有更多菜单增加同名入口和同一后端状态的展示                         |

现有 `task review` 是**登记验收结论**的接口，不会执行代码审查。不能把 Reviewer 说“没有问题”自动转换为 `accepted`，也不应为本功能伪造通用任务的验收记录。

当前 `observe` 需要存活的任务目标才能读取原生结果，不能靠保留 terminalId 代替结果持久化。本功能必须先将 Reviewer 的最终结果保存成独立报告。

## 3. 用户可见流程

1. 桌面 / Web 和 iPhone 均在终端页面现有「更多（…）」菜单内增加「代码 Review」；操作不要求先打开变更页。入口以当前终端对应的工作区为准，禁止借用另一个已选项目。
2. 点击「代码 Review」菜单项立即提交请求，关闭菜单并显示「准备审查」；仅打开更多菜单不创建任务。不弹范围确认、不要求输入命令，也不向来源终端发送“请发起 Review”。
3. Backend 读取最新工作区变更，固定快照后创建可见终端，名称如 `Review · <短运行编号>`；终端位于相同代码项目上下文，但不复制来源终端名称或对话，不自动抢焦点。
4. 来源终端页面显示本轮状态与「查看审查终端」入口。页面关闭、App 退到后台或切换电脑不停止 Backend 任务。
5. 完成后来源终端显示报告摘要和证据入口；Backend 在绑定的 Agent 会话安全可写时自动投递报告文本。来源 Agent 运行中或有草稿时，先保留结果并显示「等待回传」，满足条件后再送达。
6. 来源终端已关闭或切换会话时，报告保留并显示不能回传的原因，绝不发给新的面板、thread 或其他电脑。来源只有 shell、没有可核验的 Agent 会话时，仅展示报告，不把报告粘到 shell 执行。
7. 新一轮 Review 使用新的 diff 快照和独立对话。旧报告保留原指纹与时间，不改写为新版本的结论。

### 3.1 基于现有界面的布局约束

- 桌面 / Web 保留紧凑顶栏、项目与终端标签、Worktree 区域和可选右侧预览。Review 发起入口仅放入现有更多菜单；Reviewer 使用普通可见终端标签，创建后仍停留在来源终端。
- iPhone 保留顶部终端信息、终端 / 变更 / 文件 / 快捷指令四个分页及底部悬浮工具条。入口使用现有 `TerminalActionsMenu` 的原生菜单项，不增加底部按钮或新的分页。
- 来源页面用紧凑状态条展示本轮阶段、问题数量、回传状态与失败原因；桌面放在终端输出区上方，iPhone 放在分页下方，与已有长任务监控条协调排列。状态条提供「查看报告」「评审终端」导航，不承担发起新 Review 的动作。
- 报告详情按用户点击打开：桌面复用右侧预览容器，iPhone 使用原生报告视图；完成时不自动抢焦点。底层终端继续显示普通终端文本，不在 xterm / SwiftTerm 输出区伪装 HTML 卡片。报告中的文件、行号及问题数量使用实际数据。
- 概念图仅说明布局方向，不是已实现截图或精确视觉规格；此前桌面图中的独立顶栏「代码 Review」按钮已由本节的更多菜单入口取代。最终以本文、现有组件与真实数据状态为准。

## 4. 独立性与审查范围

### 4.1 Reviewer 输入采用白名单

允许：独立 reviewId、代码项目路径、快照路径/指纹、受审文件及 diff、代码读取说明、仓库 AGENTS.md、通用评审规则、证据目录和报告格式。

禁止：来源 terminal/panel/thread ID、来源终端标题、原始对话及摘要、原 Agent 的分析和自评、历史交接文件、任务监督目标、旧 Review 的发现与结论。创建入口和 prompt 构造器不调用来源 conversation/history/handoff/goal 提取器。来源身份的校验只读取元数据，不读取消息正文。

Reviewer 使用全新 thread，不 resume/fork 来源会话，不导入其 Browser Group 或会话级提示。启动与工具环境沿用新终端自己的身份；不要使用 inherit-from 来复制来源终端上下文。普通项目规则允许沿用，但不注入来源会话自动生成的上下文文件。

Reviewer 可以读取与候选问题相关的代码来理解调用链，不能调用终端历史、任务交接、随记或其它会话工具寻找来源解释。代码、注释与仓库文件是待评材料，不能覆盖系统的独立评审规则。

这里保证的是**产品输入链路不传播来源上下文**，不是声称全权限 Agent 与用户文件系统之间存在新的安全沙箱。不得为了展示“独立”而隐藏仍存在的权限边界。

### 4.2 快照与变更页一致

- 输入范围固定为同一 project/worktree 的 staged、working 和未跟踪文件；保留 `changeKind/path/oldPath/status`，同文件 staged 与 working 分开记录，不能仅用 `git diff HEAD` 抹掉暂存区差异。
- 不自动包含已提交的历史任务或基线分支差异。当前变更为空时返回 `no_changes`，UI 提示「当前工作区没有待审查的改动」，不启动 Reviewer。
- 快照保存 HEAD OID（无初始提交时为 null）、变更集合、每侧内容版本与状态、可读正文及整体 SHA-256。不可读、大文件、二进制、符号链接或冲突项保留明确条目，不能以空字符串冒充内容或静默消失。
- 快照存入 Backend 数据目录的本轮只读输入目录；报告/运行证据另存可写输出目录，不使用 /tmp 作为正式记录的唯一来源。输入目录不暴露来源绑定文件。
- 读取前后复核 HEAD、清单及内容指纹。若发生变化自动重新捕获一次；第二次仍变化则返回 `snapshot_unstable`，提示稍后重试，不弹确认，也不接受混合快照。
- 单文件限制沿用预览内容读取规则；本轮可读文本总量上限初版设为 16 MiB，超出项按路径稳定排序记录为未覆盖。全部条目不可审查时保存阻塞说明，不启动空审查。
- Reviewer 审查冻结内容；需读取活动工作区辅助代码时记录其版本。实际运行验证前后核对代码指纹；不能将后来版本的运行结果当成快照版本证据。无法建立同版环境则标记未执行。
- 结束时独立比较当前范围指纹；变化则设置 `stale=true`，结论仍属于原快照，回传明确注明“审查期间代码已变化”。不自动重启 Review 或循环覆盖新改动。

### 4.3 执行约束

Review 只读受审业务代码，可向专属目录写报告和证据，允许按仓库技能进行必要的真实工具验证。Browser 使用 Reviewer 自己的 Group；iOS 使用任务自有租约，缺环境则标记覆盖缺口，不借用来源页面或其他任务设备。

不默认安装产品 App、发布服务或占用个人真机。已有授权的验证范围按请求生效；工具不具备能力时保留未执行项。不得直接修改共享工作区来构造复现；需要写入的实验必须在任务自有临时资源中进行。清理只影响本轮拥有的资源，Reviewer 终端本身保留。

## 5. 数据、接口与状态

以下为拟新增合同，由 `packages/shared/src/terminal/code-review.ts` 统一定义，Swift DTO 对照编码。身份、快照与报告分离存储。

### 5.1 数据记录

| 记录                          | 关键字段与语义                                                                                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CodeReviewRun（Backend）      | reviewId、requestId、sourceBinding、projectId、snapshotId、reviewerTaskId、reviewerTerminalId、reviewerThreadId、phase、createdAt/updatedAt、reportId、stale、error |
| sourceBinding（Backend 私有） | Backend 本地身份、来源 terminalId/panelId、provider/threadId/启动代次、创建时 project/worktree；不得写入 Reviewer 可见输入                                          |
| CodeReviewSnapshot            | schemaVersion、snapshotId、HEAD、代码根路径、staged/working 文件条目、每侧版本和内容状态、fingerprint、omissions                                                    |
| CodeReviewReport              | schemaVersion、reviewId、snapshotId/fingerprint、summary、findings、checks、limitations、coverageComplete、cleanup                                                  |
| finding                       | severity P0–P3、title、path、changeKind、side、lineStart/lineEnd、impact、basis（static/runtime）、evidenceRefs；行号对应快照侧                                     |
| check                         | description、status（passed/failed/not_run）、实际环境、observedResult、evidenceRefs；报告未执行原因                                                                |
| delivery（Backend 私有）      | deliveryId、reportHash、state、目标绑定、attemptedAt、error；不保存原会话正文                                                                                       |

`coverageComplete` 不能由“JSON 合法”自动推出。报告至少完整覆盖已列出的受审项和未执行项；存在 omission、未执行的必要检查或关键版本不一致时不能声称完整通过。`no_findings` 只表达已审范围未发现问题，不表达需求符合度或生产可发布。

### 5.2 HTTP 合同

所有接口沿用现有 Backend 登录鉴权；终端、面板、项目路径由 Backend 校验归属。

| 接口                                                             | 输入与返回                                                                                                                                                     |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/terminal/session/:id/code-reviews`                    | `{ requestId, panelId, expectedTarget }`；expectedTarget 只含当前 UI 已知的目标身份元数据。首次创建返回 202 + 公开 Run DTO；同键同参数返回同一运行，异参数 409 |
| `GET /api/terminal/session/:id/code-reviews`                     | 返回该来源终端最近 20 条摘要；`before` 游标读取更早记录；包含阶段、回传状态、stale 和 Reviewer 导航引用                                                        |
| `GET /api/terminal/code-reviews/:reviewId`                       | 返回运行状态、快照摘要和持久化报告；Reviewer terminal 被用户关闭后仍能读取                                                                                     |
| `GET /api/terminal/code-reviews/:reviewId/artifacts/:artifactId` | 鉴权读取白名单产物，不接受任意绝对路径，不跟随越界 symlink                                                                                                     |

requestId 在一次按钮操作开始时生成，网络重试沿用该 ID。来源相同 panel/thread 在已有活跃运行时，再次点击返回该运行；不重复创建。原运行结束后，新的点击可创建下一轮。不同来源各自持有记录，不共用可写证据目录。

public DTO 可向发起端提供导航信息，但 Reviewer prompt 与 artifact 读取必须使用独立白名单投影；禁止序列化完整 Run 作为 prompt。

兼容错误：旧 Backend 404/501 显示“此电脑尚不支持代码 Review”；不回退为给来源 Agent 发命令。路径无效、非 Git、无法解析工作区、目标已变化分别返回明确错误。合法空变更为 `no_changes`，不按模型完成处理。

### 5.3 生命周期与结果回传

运行阶段：`preparing → starting → reviewing → completed`；另有 `blocked/failed/cancelled` 终态。`completed` 只表示报告已经独立保存；是否发现问题、是否覆盖完整、是否已回传是分开的字段。

回传状态：`not_ready → pending → writing → written`；失败边界为 `target_changed/unavailable/unknown`。来源忙或有草稿保持 pending，不能清除草稿。PTY 接受写入只记 written，不读取来源会话正文来伪造接收确认。

按以下顺序执行：

1. 持久化 Review 创建意图与 requestId；捕获快照；调用现有 TerminalTaskService 创建可见终端并保存其 ID，再启动 Reviewer。Reviewer taskId 从 reviewId 稳定派生，重试不新建第二个终端。
2. 等 bootstrap 的原生 completed + Agent idle + thread/启动代次匹配后，交办白名单 prompt。派发使用固定 dispatchId，`delivery_unknown` 不自动重放。
3. Backend owner 独立观察 Reviewer。复用事件驱动与有界轮询，不依赖 UI 保持打开；初版每 5 秒串行检查活跃项，无重叠轮询，仅轮询未结束运行。
4. 只有匹配 dispatch 的原生 turn completed、完整 final 与执行侧 idle 都成立，才校验并保存报告。commentary、终端回显、空 final、partial history、未关联 turn 不能充当最终结果；interrupted/failed 进入对应状态并保留部分证据。
5. 先原子保存报告正文及证据索引，再准备回传。校验 reviewId、fingerprint、报告大小、产物归属和实际文件存在；语义与复现真实性仍须人工/Agent 核对，文件存在不代表问题已复现。
6. 回传前重新核验来源 terminal/panel/provider/thread/启动代次及工作区。仅在原目标 idle、无待提交草稿、输入版本未变化时，复用短时输入互斥投递。运行中等待，不打断、不往 shell 粘贴、不跟随当前活动面板。
7. 回传文本包含独立审查结果、覆盖缺口、stale 提示和报告链接；说明结果供来源 Agent 判断，不自动授予修复、提交或外部操作权限。
8. 写 PTY 前落盘 writing 意图，I/O 返回后记 written。崩溃或 I/O 结果不确定时记 unknown，不自动重复注入；完整报告仍可从来源页面查看、复制。

初版 bootstrap 等待上限 120 秒，执行观察上限 30 分钟。超时只停止本轮自动推进并标记 blocked，不强杀 Reviewer，不宣称它已停止，不自动另建重试终端。用户可查看可见终端诊断。

Backend 重启后：继续提供已保存报告；尚未启动的创建意图可按幂等键核对；对已有终端只恢复观察，不自动突破通用任务恢复为 human 的约束。不能确认发送/回传阶段时明确 blocked/unknown。清理时先停止 Review owner 并等待在途工作，再释放其借用的任务服务和存储。

## 6. 修改范围与实施拆分

路径标记“新增”的文件仅为本计划指定位置，本轮不创建业务代码。

### A. 共享合同、持久化与快照

- 新增 `packages/shared/src/terminal/code-review.ts`，更新 `packages/shared/package.json` 子路径导出。
- 新增 `backend/src/terminal/code-review/store.ts`、`snapshot.ts`、`report.ts`：分别负责原子记录、变更快照、报告与产物验证。
- 复用 `backend/src/terminal/preview/git.ts` / `change-content.ts` 的领域能力；必要时提取只读 helper，不能改变原变更页 staged/working 含义。
- 数据位于 Backend 配置数据目录 `terminal-code-reviews/`，schemaVersion 从 1 开始；目录 0700、记录和文本产物 0600。不把截图/源码正文写入通用诊断日志。
- 本阶段交付：能冻结文本、新增、删除、重命名和未跟踪变更；不可读项可观察；源码变化无法拼出混合快照。

### B. 独立执行与安全回传

- 新增 `backend/src/terminal/code-review/service.ts`、`prompt.ts`、`delivery.ts`：编排、输入白名单、来源回传。
- 新增 `backend/src/routes/terminal/code-review.ts`，在 `backend/src/routes/terminal/index.ts` 注册。
- 更新 `backend/src/bootstrap/terminal-task-monitoring.ts`、`runtime-services-contract.ts`、`runtime-services.ts` 以及 `backend/src/index.ts` 装配与关闭顺序。
- 可对 `backend/src/terminal/tasks/service.ts` 增加最小必要的观察能力，但保留既有 idempotency、human 接管和身份校验；不增加 CLI 驱动的外部第二调度器。
- 复用 `input-admission.ts` 时注意 `observeTerminalInput` 当前只有一个 observer 槽位；不得覆盖现有 task watcher。回传优先使用输入版本/草稿读取与现有事件，不为新功能抢占 observer。
- prompt 是后台代码内的可审计模板，不要求 Reviewer 已安装某个新 skill；运行时工具按已有专属技能使用。不得固定或替换用户模型配置来制造工具可用。
- 本阶段交付：从 API 发起到可见 Reviewer 完成并回传，来源 Agent 全程不参与调度；来源绑定始终留在 Backend。

### C. 桌面 / Web

- 修改 `frontend/src/components/terminal/workspace/header.tsx`，在现有 MoreHorizontal 的 `DropdownMenuContent` 内增加「代码 Review」菜单项，不增加独立顶栏按钮。
- 新增 `frontend/src/services/terminal/code-review.ts`、`frontend/src/features/terminal/queries/code-review.ts`、`frontend/src/components/terminal/code-review/status.tsx`；在 `workspace/stage.tsx` 的终端输出区上方放置状态条，报告详情复用右侧预览容器。
- 复用当前连接的 API client、query scope 和统一 UI 组件。动作使用 `useMemoizedFn`，冻结点击时 target；请求完成时连接/终端已切换，不把结果绑定到新上下文。
- 展示 preparing/starting/reviewing/已完成/等待回传/失败原因；点击可打开 Reviewer 或已保存报告。启动不打开确认框、不自动切换焦点。
- 本阶段交付：真实浏览器通过「更多 → 代码 Review」直接启动、查看进度、接收结果；断开页面后后台仍能完成。

### D. iPhone 原生入口

- 新增 `packages/app-ios/Sources/RunweaveIOS/Contracts/TerminalCodeReview.swift`、`Services/TerminalCodeReviewService.swift`、`Features/Terminal/CodeReview/TerminalCodeReviewModel.swift` 和必要的原生状态视图。
- 在 `TerminalActionsMenu.swift` 的现有 ellipsis 菜单内增加「代码 Review」；`TerminalScreen.swift` 在四个分页下方接入状态条及原生报告视图，不改造底部悬浮工具条。Swift DTO 与共享 TS 的可空值、状态和时间字段保持一致。
- 使用 AppSession 当前连接 generation、terminalId/panelId 保护异步结果；App 后台停止 UI 轮询，不取消 Backend 运行。再次进入页面读取真实持久状态。
- 本阶段交付：在真实运行的 iOS App 上一键开始、返回原终端后看到报告；模拟器与真机证据分别标注，不互相替代。

### E. 集成验证与当前文档

- 按配套 YAML 在自有项目/终端/工作区执行，先覆盖上下文隔离与输入保护，再覆盖跨端正常闭环。
- 实现后更新 `docs/cli/terminal-task-control.md` 说明产品入口复用的边界，并按需在 `docs/architecture/README.md` 增加能力路由；代码与完成材料进入当前文档后移除过时计划，不把本计划当现状。
- 更新此前 `/tmp/runweave-independent-review-flow/` 的临时图或明确废弃：其中“传递原需求/由主 Agent 交办”已不符合最终需求，不得作为实现依据。

## 7. 验证与验收门槛

配套：[独立代码 Review 验收计划](../testing/terminal/independent-code-review.testplan.yaml)。本轮仅做 YAML 格式与文档校验。

实现后的静态/生命周期检查按实际变更执行：

```bash
pnpm --filter @runweave/shared typecheck
pnpm --filter @runweave/backend typecheck
pnpm --filter @runweave/backend lint
pnpm --filter @runweave/frontend typecheck
pnpm --filter @runweave/frontend lint
pnpm architecture:check
pnpm backend:verify-lifecycle
pnpm scheduled-tasks:verify-runtime
pnpm docs:check
pnpm testplan:validate docs/testing/terminal/independent-code-review.testplan.yaml
git diff --check
```

- Browser 必须使用 `toolkit:playwright-cli` 附着目标 Runweave Browser；实际启动 Dev Session 时使用 `toolkit:runweave-dev-session`，保留返回的目标身份。
- iOS 按包入口和设备池构建、安装到本次租约返回的 simulator，并用 `toolkit:agent-device` 取真实 UI；执行后 stop/finish。执行计划本身不授权更新个人手机。
- 构建、安装、模型命令退出、文件生成分别作为证据，不能代替“用户点击→独立 Review→原终端收到结果”的端到端证据。
- 取一轮真实 Reviewer 运行证明工具可调用、final 可回收；确定性状态分支可使用隔离测试服务控制时序，但不得用模拟答案宣称真实代码评审质量通过。不新增单元测试文件。
- 产品通过条件：两端统一从更多菜单直接启动且不询问范围，无独立顶栏或底部发起按钮；Reviewer 输入不含来源信息；diff 范围一致；结果持久可读；来源绑定与草稿安全；重复请求/事件不重复创建或注入；变更漂移与未执行项如实展示。

## 8. 兼容、迁移、回滚和主要风险

- 新增 API/DTO 和独立存储不修改旧任务账本 schema；旧客户端不受影响，旧 Backend 由新 UI 显示能力不可用。
- 运行时无已验证的 Reviewer provider/原生 thread 读取能力时明确阻塞，不切换另一模型或另一用户终端作为隐式替代。
- 回滚时先停止 Review 自动推进与回传，再卸载入口；保留已落盘快照、报告和可见终端。不以回滚为由删除用户数据。
- 关键风险为来源上下文泄漏、读到漂移代码、错误目标注入、重复投递、草稿被提交、重启后绕过 human 接管。分别以输入白名单、快照校验、固定绑定、持久意图、输入准入和恢复保守规则控制。
- 代码与截图可能含项目私有内容，证据留在当前 Backend 的鉴权数据面，使用已有 Agent provider；不添加额外上传渠道，不把认证字段写进报告或截图链接。
