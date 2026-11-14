# 可视化方案评审两期实施计划

状态：二期已实现，VPR-003～014 的真实 Web/Electron 用例及旧 Browser 最小回归已通过；一期手机阅读 VPR-015～017 仍受真机自动化连接阻塞。两期未全部交付，暂保留本计划。

初稿源码基线：2026-11-13，HEAD 为 73ec552fddfba437d832f61513074372e8d26aa3。当前工作区已有进行中的一期及二期改动，以下源码表描述初稿调查事实，不能当作当前实现进度。本次讨论修订只更新本计划与配套 YAML，不覆盖进行中的产品代码、不启动运行环境、不发布插件。

## 1. 目标、两期交付与范围

让 Agent 把需要讨论的方案做成可阅读、可操作的 HTML；用户在现有预览中查看、反馈，Agent 更新同一份方案。两期独立交付：

| 阶段               | 用户得到什么                                                                                       | 实施范围                                                                                       |
| ------------------ | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 一期：可视化方案   | 电脑和手机均能阅读、导航及操作自包含方案；用普通对话反馈并更新同一文件                             | 替换原型技能、精简模板与引用规范；复用现有预览，手机真机阅读是必需验收，发现阻断时修复最小缺口 |
| 二期：元素圈选反馈 | 在电脑终端 HTML 文件预览中复用已有元素圈选和评论，加入明确输入框，由用户发送；Agent 修改后刷新复核 | Web/Electron 文件预览接入既有圈选核心和评论面板，补 iframe 连接、文件上下文及输入框回执        |

二期的“圈选”明确为鼠标选择 DOM 元素并高亮，包括方案段落、图中节点和 UI 原型控件；不包含自由矩形截图、画笔或多边形套索。

阅读覆盖 Runweave Web/Electron 和原生 iOS；手机阅读是一期核心交付，不能推迟到圈选完成后。电脑圈选在二期交付。手机通过现有对话输入意见，手机圈选、触摸标注手势及专用反馈入口留待后续，本次不提前建设。独立原型库仍作浏览入口；它没有终端上下文，二期不在该页面猜测反馈接收者。交付必须区分手机阅读与电脑圈选，不能宣称全端圈选。

不建设 Mozi 式完整研发工作流、四份强制规格、角色调度、聊天气泡渲染、产物数据库、版本历史、反馈工单、自动提交或自动后台投递。允许为真实的 Browser 与 HTML 两个消费者提取既有圈选核心；普通 Browser 的提交、截图和生命周期保持既有行为，不扩展成通用标注平台。

## 2. 原始源码核查与结论

以下结论来自本工作树实际调用链。历史原型和已有测试计划只作验收线索，不能覆盖源码事实。

| 来源与关键入口                                                                                                                                                                                                                     | 查到的事实                                                                                                              | 对设计的约束                                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 旧技能 `prototype-first-development`（已由新技能替换），核心规则、默认产物、工作流                                                                                                                                                 | 固定产品 UI 原型，默认四文件，要求产品画面不混入方案说明                                                                | 新技能承载方案文档；“产品画面不夹杂讲解”仅约束其中的 UI 视图，不约束整个方案页面                                                  |
| [插件清单](../../plugins/toolkit/.codex-plugin/plugin.json)                                                                                                                                                                        | skills 指向整个 skills 目录，无逐项技能清单                                                                             | 替换目录及引用即可，不新增技能注册服务                                                                                            |
| [架构说明技能](../../plugins/toolkit/skills/architecture-flow-prototyping/SKILL.md)                                                                                                                                                | 已负责当前系统、事件流、故障因果解释                                                                                    | 保留职责；新技能负责拟议变更的方案评审，不能无条件合并两者                                                                        |
| [原型发现](../../backend/src/terminal/preview/prototype-gallery.ts)，PROTOTYPE_ROOTS、INDEX_FILE、resolveTerminalPrototypePreviewFile                                                                                              | 扫描 docs/prototypes、docs/architecture-flows 的一级目录，以 index.html 为入口，核查实际路径                            | 一期沿用 docs/prototypes 的发现合同，不新增目录类别或 manifest                                                                    |
| [原型库](../../frontend/src/components/prototypes/prototype-gallery.tsx)，PrototypeGalleryProps、loadPreview                                                                                                                       | 仅有连接、项目、source、slug；申请票据后在 allow-scripts iframe 展示                                                    | 现有能力足以阅读方案，但不存在生成者或终端绑定；不声称能够自动回到生成它的 Agent                                                  |
| [原型库页面](../../frontend/src/pages/prototypes-page.tsx)，PrototypesPage；[工作区入口](../../frontend/src/components/terminal/workspace/header.tsx)                                                                              | 当前通过 /prototypes 路由阅读；部分旧用例仍写作 sidecar 内工具                                                          | 验收必须使用真实入口，不照抄过时步骤，也不为旧步骤改产品                                                                          |
| [文件预览](../../frontend/src/components/terminal/preview/files/view.tsx)，HTML 分支；[HTML renderer](../../frontend/src/components/terminal/preview/renderers/html.tsx)，TerminalHtmlPreview                                      | HTML 分支已有 savedContent、mtimeMs、path、onInsertSelection、canInsertSelection；当前通过票据 iframe 阅读，可切 Source | 二期接在当前 HTML renderer；不增加另一套预览页面                                                                                  |
| [HTML 票据](../../backend/src/routes/terminal/preview/html.ts)；[HTML 静态路由](../../backend/src/routes/prototype/html-preview.ts)                                                                                                | 票据绑定项目/文件；静态响应有 CSP sandbox allow-scripts、connect-src none、frame-src none、base-uri none 等约束         | 现有普通预览原样保留；新增评审模式必须维持隔离，不能靠 allow-same-origin 打通 DOM                                                 |
| [文件读取与 HTML 限额](../../backend/src/terminal/preview/preview.ts)、[HTML 资源解析](../../backend/src/terminal/preview/html-preview.ts)                                                                                         | 文本文件及 HTML 入口上限均为 1 MiB；响应含完整 content、sizeBytes、mtimeMs；HTML 相对资源另有目录与大小限制             | 一期产物不超过 1 MiB；二期对已读完整正文建立快照，不另加无限量读取接口                                                            |
| [Browser DOM runtime](../../electron/src/browser/annotation/runtime.ts) 与 [样式](../../packages/browser-annotation/style.js)；[评论面板](../../frontend/src/components/terminal/browser/annotations/panel.tsx)                    | 已有 DOM 点选、高亮、selector、目标采集、评论编辑、编号标记和定位；runtime 主体是 DOM 脚本，面板由回调连接宿主          | 复用已有核心与交互，抽离传输依赖；HTML 不另写一套选择器、高亮或评论面板，Electron 轮询和截图不搬入 iframe                         |
| [Browser 标注宿主](../../electron/src/browser/annotation/index.ts)；[提交 hook](../../frontend/src/components/terminal/browser/annotations/use-annotations.ts)                                                                     | Electron executeJavaScript/capturePage；提交通过 prompt_paste 发送，当前 hook 没传显式 panelId；截图需要独立保存        | 该链路不能直接用于 Web iframe；本次不顺手修复普通 Browser 或增加截图依赖                                                          |
| [文件引用动作](../../frontend/src/components/terminal/markdown/use-actions.ts)，insertCode                                                                                                                                         | onInsertSelection 最终调用 requestInsertion，指定 destination=composer 和 panelId                                       | 复用“加入输入框”，不新增直接发送 API                                                                                              |
| [插入队列](../../frontend/src/features/terminal/input/prompt-store.ts)；[消费器](../../frontend/src/components/terminal/surface/composer-insertion.ts)；[终端消费位置](../../frontend/src/components/terminal/surface/surface.tsx) | 队列按 terminalSessionId 查找；目标 pane 不匹配时现有 consumeComposerInsertion 仍消费请求；没有调用者回执               | 不能把排队等同于已加入草稿；二期需为新调用者补最小、进程内的插入结果回调                                                          |
| [终端输入 DTO](../../packages/shared/src/terminal/runtime/input.ts)；[分发器](../../backend/src/terminal/application/input-dispatcher.ts)                                                                                          | inputAccepted 表示输入排队；operationId 不是通用 exactly-once 保证；expectedThreadId 在当前路径针对空闲 Codex 会话校验  | 不把浏览器评论接成自动投递或泛化的跨 Agent 续接系统；沿用用户手动发送                                                             |
| [iOS 文件入口](../../packages/app-ios/Sources/RunweaveIOS/Features/Preview/FilePreview.swift) 与 [HTML 宿主](../../packages/app-ios/Sources/RunweaveIOS/Features/Preview/HtmlPreview.swift)                                        | 文件入口申请 HTML 票据，WKWebView 启用 JS、非持久数据、仅放行等于原 URL 的导航；没有圈选桥                              | 一期必须真机验证实际打开、排版、必要交互及更新重读；尤其验证章节锚点，不能假设 URL 严格相等允许页内导航。只修阅读阻断，不加圈选桥 |

Mozi 参考依据是前序调研中安装的 0.2.21 随包代码与技能，不是仅从飞书宣传描述推断：render_html 接收 content/file，绑定 active turn 后交给 artifact service；前端使用 iframe、DOM 点选和结构化 annotation。原始调研材料保存在本机归档 mozi-analysis-20261113（不随仓库分发）；其 binarySha256 为 8a23b8bb827d09f920feddb73679cc2239e06b194067dafcb7341d21cecaf5b0。这里只借鉴“可视化表达和结构化反馈”，不移植其产物服务及任务系统。

## 3. 选定的最小方案

### 3.1 沿用文件作为事实源

一期只产出自包含 index.html 与简短 README。二期只对这份已保存、完整读取的 HTML 开启评审。既有票据阅读、Source、保存和文件路径解析保持原状。

二期进入评审时，宿主用已读 savedContent 构造隔离 srcDoc，并在最前方安装限制性 CSP、复用的圈选 runtime 及 iframe 适配。该模式不依赖外部 JS/CSS/JSON/图片；无需为资源重写、跨域抓取或 Backend HTML 注入建设服务。普通多文件 HTML 继续按现有票据 iframe 阅读，不承诺在本次圈选范围内。

与原设想相比，反馈目标改为“用户开始评审时明确所在的终端/pane”，不承诺自动识别文件最初生成者。这个边界消除了原型库到 Agent 的持久绑定服务，仍能完成用户在原终端看方案、标注、反馈和修改的主流程。

### 3.2 不在一期提前建设二期框架

一期仅预留可读文档结构：HTML 元标记和稳定元素 id。没有未启用按钮、消息通道、持久反馈字段、Backend 接口或二期运行时依赖。

二期的局部 HTML review feature 只管理 iframe 适配、文件快照、目标与输入框插入；圈选核心和评论面板使用现有实现的共同来源。共用代码组织遵循现有构建与包边界，不把 DOM 实现放进 packages/shared，也不把 Browser 业务塞进 packages/common；不得由 frontend 直接依赖 Electron 主进程模块。提取范围仅覆盖当前两个消费者所需代码，不建设插件系统或通用标注平台。内部模块拆分留给执行者，验收必须核查两个调用方实际共用源码，而非复制一份后称为复用。

## 4. 一期：替换技能并形成可读方案

### 4.1 技能入口与兼容决策

- 新技能 id 为 visual-plan-review，显示名称为“可视化方案评审”。用于用户要求把方案、交互设计或改动路径做成 HTML 供讨论、评审的任务。
- 替换并删除 prototype-first-development 旧技能目录；不同时暴露两个内容重复的技能，也不长期保留 alias 路由。
- 普通实施计划仍由 write-plan 负责；解释当前架构/故障因果仍由 architecture-flow-prototyping 负责。新技能可调用这些技能，不抢占所有“计划”“HTML”关键词。
- 更新架构说明技能中指向旧技能的两处路由；检查当前插件说明与 Agent 配置中全部活跃引用。历史原型 README 中记录的旧技能来源属于历史，不做全库文字替换。
- 插件清单已支持目录发现，无需改技能注册代码。源码修改不代表安装缓存已更新；实施验收必须明确使用新源码技能，安装态验收使用用户现有的插件更新入口并重新开始会话。不要手工改插件缓存或顺便修改全局 Agent 配置。

### 4.2 产物合同

默认目录沿用 docs/prototypes/<feature-slug>/，包含：

- index.html：方案正文、内联 CSS、必要的内联 JavaScript、内联 SVG；默认无需任何构建或外网资源。
- README.md：原始目标、源码基线、打开路径、采用的决策、未决问题、模拟边界和验证结果。不是第二份完整方案正文。

HTML 包含 meta 标记 name=runweave-visual-plan、content=1，用于声明评审产物合同。方案中的重要章节、流程节点和 UI 区域采用普通且稳定的 id，修改内容时优先保留；不为所有 DOM 自动产生业务标识。

整份 HTML 不超过现有 1 MiB 上限。禁用 CDN、远程字体、外部脚本/样式、fetch mock-state.json 和依赖另起服务的方案。图片确有必要时使用有界 data URL；不为了装饰堆入大图。

正文按需求选用以下内容，不强制凑齐：

1. 要解决的问题、用户目标、范围和关键取舍。
2. 用户路径；有界面变化时展示可操作 UI 视图和关键状态。
3. 与真实源码对应的改动链路、协议或状态流；说明当前已有与本次拟新增部分。
4. 可验证的结果、尚未确定的事实和具体决策入口。

方案导航与讲解属于文档；UI 视图内部保持拟落地的产品文案和操作，不混入演示脚手架。静态或行为 mock 必须有明确边界，不能作为产品已实现的证据。小改动允许只用一页，不强制四视角、四份 spec 或多角色流程。

手机阅读同属产物合同：设置正确的 viewport，窄屏正文自然换行且默认字号可读，不通过整页缩小适配桌面固定宽度。宽表格、流程图只在自身区域横向滚动，不能带动整页横向溢出；导航和必要交互可触摸操作，不依赖 hover。手机与电脑读取同一份方案，不另生成容易分叉的手机版。必须在真实 iPhone 的 Runweave 文件预览中验证，桌面窄视口或模拟器只可辅助排查。

### 4.3 使用流程

用户提出需求 → Agent 阅读原始代码与相关合同 → 生成方案 → 在回复中给出项目内 index.html 文件链接 → 用户从终端打开现有 Preview，或从原型库选择同一目录 → 普通对话反馈 → Agent 更新同一文件 → 用户刷新预览。

一期不宣称“生成后自动弹出”“内嵌会话产物卡片”“自动刷新”或“已支持圈选”。不因现有预览足够而另起 python HTTP 服务；在 Runweave 内优先使用现有入口。独立阅读才使用静态服务，且不能把独立浏览器阅读当作产品入口验收。

### 4.4 任务拆分与文件落点

| 任务                  | 文件与职责                                                                                                          | 完成条件                                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| P1-1 重写技能         | 拟新增 plugins/toolkit/skills/visual-plan-review/SKILL.md；删除旧技能及不再使用的 references                        | 触发边界、源码调查、两种视图、产物合同、反馈循环、停止条件清楚；不强制 UI 原型先行后才能写任何方案                 |
| P1-2 精简参考资产     | 拟新增该技能下 references/visual-plan-template.html、references/review-checklist.md；实施交接内容合并为简短参考段落 | 一个自包含示例足以启动；模板不自动带入无关章节，不再强制 app.js/mock-state.json                                    |
| P1-3 处理路由与旧引用 | 修改 architecture-flow-prototyping/SKILL.md；按真实搜索结果修改活跃引用                                             | 新旧职责不互相矛盾；插件只发现一个新入口；旧产物仍能按现有路径打开                                                 |
| P1-4 验收与交付       | 执行配套 YAML 的 VPR-001、VPR-002、VPR-015～017；更新技能内验证说明                                                 | 电脑两个现有阅读入口和原生 iPhone 文件入口实际可用；手机完成阅读、导航交互与更新重读，不以桌面窄视口或静态检查替代 |

若实施 P1-4 才发现现有预览不支持一个必需行为，先复现并归因；产物排版问题修技能模板，原生导航或加载阻断才修改 FilePreview.swift / HtmlPreview.swift 的必要行。原生修改遵循其就近 AGENTS 与更新流程；不借机扩建 gallery、CLI 或发布服务。真机环境不可用应记验收阻塞，不能删掉手机门禁或推到二期。

## 5. 二期：隔离圈选与输入框反馈

### 5.1 唯一主入口和使用行为

终端内打开一期 index.html，HTML Preview 工具栏显示“评审”。只有文件满足自包含合同、正文完整且无未保存修改时可进入。无有效 Agent 输入框时仍可阅读，反馈加入动作禁用并显示具体原因。

用户开启评审后：沿用已有元素选择、高亮与评论编辑交互 → 添加到既有评论列表 → 可编辑、删除或定位评论 → 在宿主点击“加入输入框”。不为 HTML 再造不同的圈选操作。正文通过既有 composer 插入路径加入明确的 terminal/pane，保留原草稿；用户点击现有发送按钮。按钮成功只表示已经加入草稿，不表示 Agent 已收到或完成修改。

独立原型库保持阅读模式；技能说明需要在终端文件预览中评审。不新增“随便找一个终端”或默默选当前全局 Agent 的行为。工作区文件 HTML 是本期入口；Git 旧侧/变更快照仍保持只读预览，不对历史版本的圈选反馈做额外承诺。

### 5.2 预览隔离与 guest 通道

frontend/src/features/terminal/html-review/ 保存 document.ts、iframe 连接适配、protocol.ts、use-review.ts 和 prompt.ts 等 HTML 专属职责；复用已有 Browser runtime/style 与 annotations/panel.tsx。当前进行中的 guest-runtime.ts 和 comments.tsx 应检查并收敛重复职责，不能保留第二套选择器、高亮和评论 UI；本计划修订不直接覆盖这些进行中的代码。文件数量不作为验收目标。

- document.ts 使用 DOMParser 重建文档，在任何用户脚本前写入 CSP 和 bootstrap；不使用正则任意替换 HTML，不把原文拼进未转义 script 字符串。评审使用解析后重新序列化的文档，原始 savedContent 不被修改。
- srcDoc iframe 继续仅 allow-scripts，不开放 allow-same-origin、top-navigation、popup 或 Node bridge。CSP 至少限制 default-src none、connect-src none、frame-src none、object-src none、base-uri none、form-action none；只放行必需内联样式/脚本及 data/blob 图片。自包含能力与隔离必须在浏览器实际验证。
- 对标记、完整大小及资源引用作合同检查：存在外部资源依赖、base 或不受支持嵌套文档时，不悄悄执行成残缺方案；显示不可评审原因，普通票据预览保持可用。实现只检查本合同相关属性，不建设通用 HTML 清洗器。
- guest 运行复用的点选、高亮、编号、定位与评论编辑逻辑；必要状态通过 iframe 适配同步给宿主面板。用户可在已有页面编辑器中写评论，guest 传来的评论与页面证据均按不可信载荷校验；最终目标、版本核对及加入动作由宿主持有，用户在宿主检查后加入草稿。
- 宿主在本次 iframe 加载后创建 MessageChannel，将专用 port 交给该 iframe。每次模式开启生成临时 generation；host 核对 window/source、generation、消息 kind、字段类型及长度。沙箱消息 origin 可能为 null，不能只用 origin 判断身份，也不能为避开限制开放同源。
- guest 提供 ready、选择及评论状态变更；host 提供 selecting/focus/remove/stop 等既有圈选操作。按实际复用接口定义最小有界协议，不强制另造评论模型。页面消息无权选择文件路径、连接、项目、terminal、pane，不能触发文件写入、HTTP 调用或自动发送；既有页面提交按钮在文件评审模式中只能请求宿主展示待检查评论，加入输入框必须来自宿主按钮的真实用户动作。
- 每次刷新、切 Source、退出评审、切文件或卸载，关闭 MessagePort、释放事件监听并使旧 generation 失效。不引入 500ms 状态轮询或后台常驻服务。

### 5.3 内存数据与版本语义

ReviewContext 固定 connection scope、projectId、absolutePath、terminalSessionId、panelId、Agent 可用状态以及本次 review generation。它来自终端宿主，不从 HTML 中读取。若来源上下文改变，停止当前可提交状态；用户返回原上下文或重新开始评审前不能发往新目标。

ReviewSnapshot 固定进入评审时的完整 savedContent、mtimeMs 和本地 snapshotId。snapshotId 只关联本次 UI，不是服务端版本号；mtimeMs 仅供展示，不作为内容相等证明。

每条评论仅保留 id、目标稳定 DOM id（若有）、selector、目标原文摘要、rect/viewport 和用户评论。建议边界为每次最多 20 条、每条用户评论 2,000 字符、目标摘录 500 字符、总生成反馈不超过 64,000 字符；达到边界明确阻止，不静默截掉用户评论。可按实际现有输入上限进一步收紧，不能扩大后端全局上限。

点击“加入输入框”前，复用现有 getTerminalProjectPreviewFile 读取当前同一项目/路径；将完整 content 与 ReviewSnapshot.savedContent 作字符串全等比较，并重新核对连接、项目、terminal/pane 和 Agent 输入资格。请求失败、401、文件消失、正文变化、输入框有未保存的 HTML 源码修改时均不加入、不清空评论。由用户刷新文件并重新开始评审；不自动把旧 selector 重贴到新 DOM。

无需 hash API、历史快照库或新数据库。字符串全等覆盖相同大小、相同 mtime 但内容变化的情况。比较只证明本次读取时与所评正文相同，不能锁住随后发生的文件写入；生成反馈必须包含所评路径、读取时间、mtime 和原始摘录，并要求 Agent 修改前再次读取与核对。不要声称文件系统与消息投递原子。

在用户保留当前评审页时，评论保存在该 feature 的内存状态；退出、换文件、刷新含评论的评审前提示将丢弃草稿，用户取消则保留。关闭应用后的恢复不在范围内，不为此建立持久化表。普通窗口关闭遵循既有宿主行为，不能保证强制退出前一定弹窗。

### 5.4 反馈内容及输入框结果

反馈按“评审文件与依据 → 元素原文/定位 → 用户意见”组织。路径、mtime、scope 等宿主事实与页面采集内容分区；page text、selector、HTML 内容明确标记为不可信证据。评论保留用户所写内容，但不把 guest 传来的字段当成可信宿主指令，宿主列表供用户核对。只携带必要摘录，不把整份 HTML 重复塞进输入框；不强制截图，不把“截图文件路径”描述成模型图片附件。

复用 onInsertSelection 到 requestInsertion 的 composer 路径，同时为本功能增加可选的进程内结果回调：inserted、target-changed、cancelled。只有消费器在目标 pane 实际执行 insertDraft 后才返回 inserted。已排队、目标不匹配、目标失效均不能显示成功或清理评论。旧调用方不提供回调时保持当前行为，不增加持久状态或后端 receipt。

新调用方需能取消自己尚未消费的请求；取消和消费竞争以队列内一次移除为准，回调至多一次。收到回执时再次核对本地 generation，旧回执不能修改新评审状态。成功后保留原评审列表用于复核，标记本批次已加入；没有新修改时禁用重复加入。用户编辑评论后可再次显式加入。任何分支均不自动触发 Enter、sendTerminalInput 或后台重试。

插入的目标是用户选择的输入框，不承诺 TUI thread 的持久身份；加入后用户可以检查、编辑或删除再发送。这个显式边界避免把现有 Codex 专用 expectedThreadId 误用为所有 Agent 的通用保证。

### 5.5 任务拆分与文件落点

| 任务                        | 文件与职责                                                                                                                                                                                          | 完成条件与配套用例                                                                                         |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| P2-1 复用圈选与连接适配     | 从 electron/src/browser/annotation/runtime.ts、style.ts 提取共用核心，原 index.ts 保留 Electron 适配；html-review/document.ts 与连接模块负责 iframe                                                 | Browser/HTML 实际消费同一圈选源码；srcDoc 隔离与有限协议成立；VPR-003、VPR-005、VPR-011，加旧 Browser 冒烟 |
| P2-2 复用面板与文件评审状态 | 复用 frontend/src/components/terminal/browser/annotations/panel.tsx，参数化必要文案和动作；html-review/use-review.ts、prompt.ts 与 renderers/html.tsx 处理文件上下文                                | 保留既有评论交互；刷新/退出清理、内容比较与错误提示；VPR-003、VPR-006、VPR-009、VPR-010、VPR-012、VPR-013  |
| P2-3 传递真实目标           | 修改 frontend/src/components/terminal/preview/panel/index.tsx、frontend/src/components/terminal/preview/files/view.tsx 以及 frontend/src/components/terminal/markdown/use-actions.ts 的必要回调扩展 | 向 HTML 宿主传递实际 scope、项目、文件、terminal、pane 和可用性；VPR-007、VPR-014                          |
| P2-4 最小插入回执           | 修改 frontend/src/features/terminal/input/prompt-store.ts、frontend/src/components/terminal/surface/composer-insertion.ts、frontend/src/components/terminal/surface/surface.tsx；旧调用兼容         | 实际插入与失败可区分；不丢原草稿，不误投 pane，成功不重复加入；VPR-003、VPR-007、VPR-008                   |
| P2-5 联调和说明             | 修改新技能的反馈说明及 docs/architecture/terminal-code-preview.md，描述已验证入口和平台限制                                                                                                         | Web 主链、Electron 冒烟、旧预览与旧 Browser 标注不回归；VPR-004 及最小回归集                               |

表中现有文件使用仓库相对路径；共用核心和 feature 内部 helper 可按实际构建边界拆分。允许 Electron 圈选内部适配及必要的既有合同复用，不增加 Backend/CLI 服务接口；不建设 iOS 圈选桥。若需要新增服务或扩大协议，先以实际阻断证据比较最小路径，不能直接加入新服务层。

依赖顺序为 P2-1 → P2-2/P2-3 → P2-4 → P2-5；允许局部开发并行，但不需要固定多 Agent、额外 worktree 或编排系统。

## 6. 验收策略：验证必要、充分、合理

配套新增 [可视化方案评审验收](../testing/terminal/visual-plan-review.testplan.yaml)。它补充新技能、srcDoc 消息通道、版本与目标隔离；不复制所有既有 HTML、Browser 或终端测试。

| 验证层            | 一期                                                                 | 二期                                                                                                    | 为什么需要及到哪里停止                                                           |
| ----------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 文档/资产静态核对 | 新技能路由、相对引用、模板自包含、1 MiB 限额、旧入口清理             | 补充反馈和平台说明                                                                                      | 证明合同可执行，不能证明 UI 或 Agent 实际执行效果                                |
| 真实 Agent 样例   | 用明确读取新技能的会话生成一个结合源码的跨层方案，人工对照关键事实   | 复用同一份方案，经评论明确要求一处修改并核对结果                                                        | 验证技能遵循与内容价值；成功一例后不额外跑大量付费模型对比                       |
| Web/Electron UI   | 真实文件入口和原型库读同一文件                                       | Web 执行 VPR-003、005～014；Electron 执行 VPR-004                                                       | Web 覆盖主要状态和隔离，Electron 只补宿主差异，不机械重复全部矩阵                |
| 原生手机阅读      | 真机执行 VPR-015～017：正文布局、导航交互、更新重读                  | 同一方案做一次阅读冒烟，只有模板或 iOS 阅读链变动时重跑对应案例                                         | 手机阅读为一期门禁；缺设备或登录记阻塞，不能用桌面窄视口代替                     |
| 原有 HTML 回归    | 复用 HTP-001；gallery 采用 PGP-004/005/006 中仍符合源码的路径        | HTP-001、HTP-003；PGP-005；普通 Browser 最小点选/取消/加入原链路冒烟                                    | 保护本次接触的预览和引用行为；不全跑 Browser 20 条性能、代理、设备模式或历史原型 |
| 类型与构建        | 仅技能/模板不跑产品构建；若修手机阅读阻断，执行 iOS 就近规则对应检查 | frontend typecheck、触及文件 lint、Frontend build；提取圈选核心涉及 Electron 构建与依赖方向时补对应检查 | 证明编译和导入；不把构建通过写成用户验收通过                                     |

既有 [HTML 预览计划](../testing/terminal/html-preview.testplan.yaml)、[原型库计划](../testing/browser/prototype-gallery-preview.testplan.yaml)存在历史入口或字段描述不完整之处。执行者先以第 2 节源码确定操作入口；案例正确结果仍适用时保留，不为了让旧步骤原样可跑而修改产品。新增测试计划描述本次新行为，格式通过不表示这些未来行为已实现。

本轮只执行文档与 YAML 格式检查：

```bash
pnpm testplan:validate docs/testing/terminal/visual-plan-review.testplan.yaml
pnpm docs:check
git diff --check
```

实施一期后执行以上静态检查，并完成 VPR-001/002/015/016/017。实施二期后，再执行：

```bash
pnpm --filter @runweave/frontend typecheck
pnpm --dir frontend exec eslint <本次修改的前端文件列表>
pnpm --filter @runweave/frontend build
```

尖括号处由实施者填入最终 git diff 文件列表，不是新增全仓 lint。真实 Web/Electron UI 使用 toolkit:playwright-cli；iOS 真机交互使用 toolkit:agent-device。实际启动/停止 Dev Session 必须先使用 toolkit:runweave-dev-session。手机优先复用可访问本任务项目的已安装实例；若确因阅读缺陷修改原生代码，按 toolkit:update-runweave-ios 及目标设备约定更新并重新验收，不能只凭安装启动宣布通过。不额外更新 Stable 桌面、发布 npm 或生成 Windows 包。

所有本期 required 用例取得独立 verdict 后即可收口。未实现的第二期用例记 not_run；环境无法启动、缺少目标 Agent 或登录态记验收阻塞；有实际反例才记失败。发现失败只重跑修复影响面；没有新改动、失败或疑点，不重复构建和整套用例。

不新增单元测试、TDD、截图全页像素比对、通用测试 runner、持久日志平台或性能基准。以 DOM/输入框后置状态、必要请求结果、方案文件内容及 1～3 张相关截图作足够证据。

## 7. 迁移、回退与风险控制

- 一期是技能源码替换，历史 docs/prototypes 目录及旧链接不迁移。若新技能效果不合格，回退该技能提交即可；不得删除用户已有方案文件。
- 二期对一期标记且满足自包含合同的文件增加显式评审模式。普通票据预览、Source、编辑/保存、历史 HTML 与 iOS 路径保持原行为。回退前端后仍能阅读同一文件，无数据库回滚。
- srcDoc 绕开了原 HTML 响应 CSP，因此必须主动重建同等或更窄的策略，先落 CSP 后执行任何用户脚本。这是本期真正的安全风险，不能只检查 iframe 属性就放行。
- 页面脚本可改变 DOM；圈选针对用户当时看到的 DOM，Agent 根据稳定 id、原文和源码复核。canvas、跨域 iframe、shadow DOM 深层选择不承诺；不为极端元素创建通用定位引擎。
- 父页面状态切换与输入消费存在竞态，靠固定目标、一次回执与 generation 处理；不把异步排队当成插入完成，也不为此升级为跨进程投递账本。
- 文件比较后的外部写入仍可能发生。明确“所评版本”并要求 Agent 修改前复读，是本次合理边界；不引入文件锁、自动合并和长期版本追踪。
- HTML 原文、文件路径和终端凭据不发给第三方；guest 获得的只有 DOM 交互和专用 port，Backend bearer token 不进入 iframe 或生成文件。

## 8. 完成标准与交付材料

一期完成：一个新技能替换旧入口；能基于真实源码生成自包含、可读、必要时可操作的方案；电脑现有两个阅读入口及原生手机文件入口可用；手机真机正文、导航交互与更新重读通过；普通对话修改同一文件。交付新技能路径、实际样例、源码事实核对和阅读截图，手机截图注明真机来源。圈选不是一期完成条件。

二期完成：在 Web 与 Electron 的终端 HTML 文件预览完成元素选择、评论编辑、正确目标输入框插入、用户发送、Agent 修改和刷新核对；过期正文、旧 iframe 消息、目标变化及插入拒绝均不误投或误报成功；旧阅读与普通 Browser 路径经过所列最小回归。交付用例 verdict、有限截图、实际修改后的文件及剩余限制。

执行者可以调整内部 helper 与组件命名；不能静默扩大到自动投递、手机圈选、独立原型库圈选、任意多文件网页或新的产物平台。手机阅读已在一期范围，不得误归入后续。两期均交付后按文档治理删除本临时计划，把仍有效的使用与边界说明留在技能和现有架构文档。
