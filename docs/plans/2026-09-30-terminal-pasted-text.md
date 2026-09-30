# 终端长文本粘贴为 txt 附件实施计划

日期：2026-09-30。状态：实现已落盘，验收尚未闭环。用户已授权实施；本地长文本链路已实测，剩余生命周期门禁及回归阻塞见[验证记录](../review/2026-09-30-terminal-pasted-text-verification.md)。当前有效合同已迁入 [Frontend](../../frontend/docs/terminal-text-attachments.md) 与 [Backend](../../backend/docs/terminal-text-attachments.md)，本计划暂保留用于跟踪未完成验收。

## 目标与范围

用户复制内容时仍得到普通文本；在 Runweave 粘贴长文本时，由终端所属 Backend 保存真实 txt，避免全文挤进输入区。**不打开浮动输入框，直接在 TUI 粘贴也要支持。**

首版覆盖 Web / Electron renderer 中由 Runweave 管理、能确认当前 panel、Codex thread 和本机执行归属的 Codex 空闲输入状态。当前实现先限于已实测 macOS Backend 的 loopback 直接连接；远端或代理连接保持关闭。浏览器与 Backend 可以在不同机器，但 Agent 和保存文件的 Backend 必须共享可读文件系统。远端 Backend 必须通过独立远端验收后才启用该能力。

普通 shell、Vim、其他 Agent、Agent 正在运行、未确认线程、手动进入的 SSH / 容器保持原生粘贴。不根据 session 中另一个 panel 的 Agent 类型开启功能。不修改复制菜单、iOS、快捷指令、程序调用 `terminal.paste()`、图片附件，也不建设通用文件管理平台。不承诺节省模型 token；Agent 仍可能读取全部正文。

## 依据与证据边界

- 已检查本机 Codex Desktop 26.924.22138 发布代码：阈值为 JavaScript `String.length >= 5000`，创建受管理的真实 txt，附件可预览、移除、恢复正文。CLI 的长文本折叠不是本方案依据。
- 已用仓库 xterm 6.0.0 做隔离实验：容器 capture 能覆盖根元素及隐藏 textarea；必须同时调用 `preventDefault()` 和 `stopImmediatePropagation()`。只监听 textarea 会漏入口；程序化 paste 不经过 DOM paste。
- 已用本机 Codex 只读执行验证路径文件消费，17226 字节及首尾标记一致。这不等于 Runweave 完整集成通过，不证明其他 Agent 或远端沙箱可读。
- [现有原型](../prototypes/terminal-pasted-text/README.md)仅覆盖浮动输入框，14 项交互断言已通过，文件和发送均为模拟。用户本次明确要求写计划，因此可制定实施步骤；补充 TUI 状态原型后仍需按实现授权推进产品代码。

实现前入口：`use-emulator.ts` 仅拦图片；`floating-composer.tsx` 是纯 textarea；图片上传结束后直接调用 `sendTerminalInput`，没有完整异步目标保护。WS input 仅有 type/data，会写入当时选中 pane。现有 `input-admission.ts` 有 session 级 revision / writers / returning，可扩展并发保护；不能直接照搬图片链路。

## 用户行为合同

| 场景                        | 首版行为                                                                                                        |
| --------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 文本长度 < 5000 UTF-16 单元 | 保持原生粘贴和光标/选区语义                                                                                     |
| 文本长度 ≥ 5000             | 取 `text/plain` 原文创建 UTF-8 txt；不转换 HTML、不裁剪、不归一化 CRLF、不去首尾空白                            |
| 含图片或文件的剪贴板        | 保留既有附件分支，不重复提取文本创建 txt                                                                        |
| 浮动输入框                  | 保留现有文字；附件按粘贴次序显示名称、长度、保存状态；可预览、移除、在当前选区放回全文；仅附件也能发送          |
| 直接 TUI                    | 不展开浮动输入框；保存成功后在 TUI 当前编辑位置粘贴一次带空格边界的绝对路径引用；不清空已有草稿、不附加提交回车 |
| TUI 附件提示                | 在独立于浮动输入框的区域显示保存中、已插入或未插入；支持预览、复制原文、关闭提示；关闭不撤回 TUI 路径、不删文件 |
| 保存中                      | 浮动输入框禁止发送/排队；TUI 仍允许继续输入，但输入使本次待插入失效，不将延迟路径追加到新草稿                   |
| 失败或目标变化              | 保留原文和明确原因；允许用户复制原文或在原目标重新发起；不自动把长正文塞进 TUI，不自动重发                      |

长度上限为每份 1 MiB UTF-8；每 session 已保留附件总量上限 100 MiB；同一客户端草稿最多 20 份（包括 pending）。这些是首版产品限制，不是 Codex 的限制。超限给出原因并保留原文，禁止截断。不得以自动删除已引用附件腾空间。

普通粘贴通过现有 xterm 路径。TUI 文本拦截只覆盖本 terminal 容器内、已确认可用的用户 DOM paste；浮动 textarea 单独处理并避免父容器重复拦截。销毁 surface 时移除监听，多个终端之间不共享正文状态。

TUI 引用格式固定为前后各一个空格包围的 JSON 字符串形式绝对路径（例如 `"/path with spaces/pasted-text.txt"`），由服务端生成，避免与相邻草稿粘连；不含 shell 执行语法。浮动提交在原指令后追加独立的“文本附件，请读取文件内容：”及逐行引用路径；原文字不改写。

## 文件与状态合同

Backend 使用现有实例数据根目录下的 `terminal-text-attachments/<sessionId>/<attachmentId>/pasted-text.txt`；不得写入浏览器所在机器，也不放在会被系统任意清理的临时目录。目录 0700、文件 0600，以服务端生成的 UUID 命名，临时文件写完再原子 rename。路径只能由服务端构造，拒绝任意客户端路径、路径穿越及符号链接逃逸。

每份附件保存最小元数据：schemaVersion、id、sessionId、panelId、threadId、创建 operationId、UTF-16 长度、UTF-8 字节数、SHA-256、创建时间及引用状态。正文只存文件，不写诊断日志、快捷输入历史或分析事件。metadata 按原子写入维护，不为本能力新增数据库。

- `draft`：浮动输入框保存成功但从未交付。移除/恢复正文后可释放；删除失败不阻塞恢复，进入清理重试。
- `referenced`：准备向终端写入前先持久化此状态。已经发送、排队、TUI 插入及结果未知的文件均保护；关闭提示、清空草稿、终端退出或 Backend 重启都不得删除。
- 已引用文件随 session 保留；session 明确删除后保留 7 天再清理。仅 exited 不算删除。磁盘满时拒绝新写入。
- 从未引用且无客户端活动续期的 draft 保留 7 天；客户端挂载期间每 24 小时续期一次。重新访问过期 draft 时提示失效，不能发送悬空路径。写入中断的临时文件超过 24 小时可清理。
- 清理任务由 Backend runtime owner 注册、停止和等待；重启仅扫描受管理根目录；元数据损坏或归属不明时不删除文件。

前端附件集合随现有 apiBase / session / panel 草稿作用域隔离。首版不新承诺跨页面刷新恢复草稿；同一次页面生命周期中保留待处理正文，未保存内容离开页面前提示。Backend 已保存文件不会因刷新消失。恢复正文从认证内容接口读取并校验长度/哈希；本地 pending 原文直接恢复。

## HTTP 与共享类型

新增合同进入 `packages/shared/src/terminal/runtime/text-attachments.ts`，通过 `@runweave/shared/terminal/text-attachments` 显式导出。以下路径相对已有 Terminal router；共享类型和接口已实现。

| 接口                                                        | 请求与结果                                                                                                                                                                      |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET `/session/:id/text-attachments/capability?panelId=…`    | 返回 enabled、provider、threadId、executionHost、限制值及不可用原因；由实际目标 pane 状态和已验证执行环境判定，UI 不自行猜测                                                    |
| POST `/session/:id/text-attachments`                        | `{operationId, panelId, expectedThreadId, purpose: 'composer' 或 'tui', text}`；返回附件描述、服务端路径和 TUI 插入操作 ID；创建时采集服务端输入 revision，不接受客户端任意路径 |
| POST `/session/:id/text-attachments/:attachmentId/insert`   | `{operationId, panelId, expectedThreadId}`；只用于 TUI，检查创建时绑定的目标及 revision；返回 `accepted`、`rejected` 或 `unknown`，不把写入队列当作 Agent 已读取                |
| GET `/session/:id/text-attachments/operations/:operationId` | 只读查询 create / insert / composer 交付结果；网络失败后可查询，不自动重放                                                                                                      |
| GET `/session/:id/text-attachments/:attachmentId/content`   | 认证后返回原始 text/plain UTF-8，预览以纯文本渲染                                                                                                                               |
| POST `/session/:id/text-attachments/:attachmentId/retain`   | 续期仍被打开草稿持有的 draft；不改变 referenced 生命周期                                                                                                                        |
| DELETE `/session/:id/text-attachments/:attachmentId`        | 仅释放未引用 draft；referenced 返回冲突，不能撤销 TUI 输入                                                                                                                      |

已有 `/session/:id/input` 增加可选 `textAttachmentIds`。只允许在已有浮动输入器使用的受支持提交模式携带；服务端校验所有文件归属/可读、按 ID 次序组合正文与路径说明，并在终端写入前保护附件。客户端不拼任意路径冒充附件。无附件的旧请求保持兼容。

同一 session + operationId + 同一 payload 返回已保存结果，换 payload 返回 409。插入前持久化 `dispatching`；写入明确成功变为 accepted；进程中断后的 dispatching 变为 unknown，不能再写一次。这里保证不盲目重复，不承诺跨进程与 PTY 的事务性 exactly-once。所有输入失败都必须区分「确认未写」与「结果未知」。

沿用现有 Terminal 身份鉴权和 session 权限；content、状态查询和释放使用相同边界。未知 ID / 非当前授权作用域不能读取正文。400 参数错误，409 目标或输入冲突，413 大小超限，507 磁盘不足；失效附件用 410。错误只带 ID/原因，不回显全文。能力接口不存在的旧 Backend 维持普通粘贴；创建接口一旦接收过请求，失败不能退回自动原文发送。

## TUI 并发与投递：上线前必须满足

1. 粘贴发生时固定 apiBase、sessionId、panelId、provider、threadId、客户端输入 generation。先保留原文，再截断 DOM 传播并创建文件；服务端在任何异步写盘之前采集 admission revision。
2. 创建结束时客户端复核固定目标和 generation；切 panel、切 Backend、退出 Agent、失去目标资格、继续输入或提交都会取消待插入。响应属于旧 scope 时仅更新旧 scope 的恢复项。
3. 只有复核成功才调用 insert。Backend 检查创建时 revision、session/panel/thread 生命周期和资格；其他客户端 WS/HTTP 输入同样推进 revision。目标变更事件也必须使待操作失效；校验与取得短时投递独占权之间不能有 await。
4. 扩展现有 session admission，保存文件期间不持锁，仅实际投递期间互斥。投递始终显式定位原 panel，不使用 WS selected pane 回落；独占期间收到的正常输入必须按原绑定目标保序等待，不能无提示丢键。切换操作不能使已排队输入漂移到其他 pane。
5. 正式提交点为服务端取得投递资格。提交前变更拒绝；提交后即使前端切走也只向已固定的旧目标完成一次投递，状态回执归旧 scope。取消 HTTP 请求不等于取消已提交投递。无法确认目标仍存活则停止并保留恢复项。
6. 服务端走 `input-dispatcher.ts` 的显式目标粘贴能力；保留 bracketed-paste 语义和 tmux 退出 copy mode 行为，禁止 `prompt_replace`、Ctrl-U、附加 Enter。退出 copy mode 后还需复核绑定，不得在延迟窗口向新目标写入。
7. 这是一个投递入口：客户端收到 accepted 后只更新输入 generation 和浮动草稿镜像，不再调用 `terminal.paste()` 或 WS 重发。镜像不能可靠同步光标编辑时应标记不可靠并禁用破坏性覆盖发送，不能伪造已同步。unknown 不更新为成功，不自动补发。

本能力不能可靠观察用户绕过 Runweave、直接操作同一 tmux 的所有输入；首版不把这种共享外部编辑环境标为已支持。若现有来源不能提供可靠资格或输入顺序，保持普通粘贴，不能靠延时猜测修补。

## 实施步骤与文件范围

### 1. 补齐可评审交互

- [x] 修改 `docs/prototypes/terminal-pasted-text/{index.html,styles.css,app.js,mock-state.json,README.md}`：补 TUI 未打开输入框、保存中、成功路径、上下文变化未插入及复制原文状态。
- [x] 保留现有浮动输入框行为；明确 TUI 提示关闭不能撤回路径。用真实浏览器验证两个入口状态，不将 mock 结果算产品验收。

交付：两种入口及恢复状态的原型已补齐，并独立验证模拟交互；模拟结果不计入产品验收。

### 2. 共享合同与 Backend 文件服务

- [x] 新建 `packages/shared/src/terminal/runtime/text-attachments.ts`，修改 `packages/shared/src/terminal/runtime/input.ts` 及 `packages/shared/package.json` 的公开导出。
- [x] 新建 `backend/src/terminal/attachments/text-attachment-service.ts`：写入、metadata、配额、内容读取、归属校验和清理；新建 `backend/src/terminal/attachments/text-attachment-delivery.ts`：资格、操作回执和引用保护。
- [x] 新建 `backend/src/routes/terminal/input/text-attachment.ts`，在同目录 `index.ts` 注册；修改 `backend/src/routes/terminal/sessions/helpers.ts` 的输入 schema。
- [x] 在 `backend/src/bootstrap/runtime-services.ts` 装配服务与清理 owner；复用实例数据目录，不新加环境变量入口。

验证对应 TXT-009、010、012、013、014 的服务端条件；这些用例的完整行为结论在前后端集成后取得，不把 API 静态存在视作通过。

### 3. 带目标与输入代际的安全投递

- [x] 修改 `backend/src/terminal/runtime/input-admission.ts`、`backend/src/terminal/application/input-dispatcher.ts`、`backend/src/ws/terminal-input-handler.ts`，补充短时互斥与有序处理；所有现有调用方必须保持既有行为。
- [x] 查明 panel 切换/Agent thread 生命周期的现有更新入口，接入 revision 失效；从 `backend/src/routes/terminal/panels/index.ts` 和 `backend/src/terminal/state/terminal-state-service.ts` 追踪，不仅监听 Web 当前组件。
- [x] 确认服务器可证明执行主机和 Agent 沙箱读取权限；本地 Codex 验证通过才返回 capability。远端环境在 TXT-016 单独通过后开放。

验收：TXT-005、006、007、008、011；冲突不能出现正文与路径双写、错 pane、丢键或隐式提交。

### 4. 前端双入口接入

- [x] 修改 `frontend/src/services/terminal/sessions.ts`，加入类型化 API 与只读结果查询。
- [x] 新建 `frontend/src/features/terminal/input/text-attachments.ts`，保存附件状态和 scope；将 UI 放入 `frontend/src/components/terminal/input/text-attachments.tsx`，复用现有 Dialog/浮层规范。
- [x] 修改 `frontend/src/components/terminal/input/floating-composer.tsx`、`use-floating-composer-controller.ts`、`frontend/src/features/terminal/input/floating-composer.ts`：paste、附件列表、选区恢复、仅附件发送、pending 及失败保留；发送/排队统一提交 IDs。
- [x] 修改 `frontend/src/components/terminal/surface/use-emulator.ts`、`surface.tsx`：容器 capture、独立 TUI 提示、scope/generation 取消和一次性镜像更新；监听不得吞掉短文本、图片或程序注入。

验收：TXT-001 至 008、015、017 至 020；实际浏览器粘贴及键盘提交和网络回执能相互对应。

### 5. 完整验收与交付

执行 [长文本附件验收计划](../testing/terminal/runtime/text-attachments.testplan.yaml)。该文件保留原始验收合同，执行结果见验证记录；格式检查与行为验收分别记录。沿用 [浮动输入与活动状态回归](../testing/terminal/runtime/activity-composer.testplan.yaml)；不新增单元测试。

实现阶段静态门禁：

```bash
pnpm --filter @runweave/shared typecheck
pnpm --filter @runweave/backend typecheck
pnpm --filter @runweave/frontend typecheck
pnpm --filter @runweave/backend lint
pnpm --filter @runweave/frontend lint
pnpm architecture:check
pnpm backend:verify-lifecycle
pnpm testplan:validate docs/testing/terminal/runtime/text-attachments.testplan.yaml
pnpm docs:check
git diff --check
```

真实环境使用 `runweave-dev-session` 取得本次代码的隔离会话，再按 `playwright-cli` 和 `run-test-cases` 执行 required 用例；记录源码 revision、Backend/renderer 版本、目标 panel/thread、文件字节与 Agent 读取证据。TUI 输入成功、文件创建成功和 Agent 读取成功分别给证据。不得以静态检查或原型截图替代。

任一必测出现错目标、丢原文、重复插入、自动回车、无法读取、未授权读取或提前删除，均不发布。远端选测未执行时远端能力保持关闭，不声称支持。所有 required 通过才算首版本地闭环验收通过。

## 兼容、发布与回滚

无附件旧 API/客户端行为不变，新能力显式协商；不迁移图片或已有用户文本。服务端保存格式 version 1，旧版本忽略该新目录，不让回滚脚本删除它。

上线先启用已验收的本地 Codex 执行环境；支持矩阵随真实验收扩展，不按 Agent 名称扩大。回滚代码会停止新附件转换，已有 TUI 引用文件继续保留可读；回滚前提示并处理仍打开的浮动附件草稿，不能把未提交附件当作已发。

实现完成后，将有效的输入与附件生命周期合同迁入 `frontend/docs/`、`backend/docs/` 对应文档并提供入口，删除本临时计划；历史原型保留其模拟属性。提交、部署和随记完成状态均按用户后续明确指令执行。
