# 当前终端的长任务监控

用户从 Web / Electron 终端右侧「任务监控」手动开启监听。原 Agent 负责实现、测试与验收；独立 Codex 只理解原任务、计划与最终报告，返回 completed、blocked、continue 三项评分。Backend 取最高项，并列按 continue、blocked、completed 排序。评分表示相对选项倾向，不是统计正确率。

## 运行边界

监听绑定 terminalSessionId、panelId、threadId、executorGeneration。初期只开放通过标准终端 Agent 入口启动、加载新版 Hook 的普通 Codex 0.160.0 任务。自定义 commandLine、无法确认配置的执行器、旧 Hook 和其他 provider 给出能力缺口，不创建替代执行任务。

开启前和最终回复处理时，使用原执行器的 binary、CODEX_HOME、实际工作目录与配置参数启动只读配置探测，调用 `thread/goal/get` 和 `hooks/list`。探测不创建或恢复执行轮次。活动或暂停的 Goal、其他启用的 Stop Hook、未受信任的 Hook 或不足 120 秒的 Stop 等待时间均拒绝自动续接。原执行器显式采用一次性 Hook trust bypass 时，沿用其既有选择；监听器不会添加 bypass 或批准原任务权限。

后台只通过主任务原生 Stop 接收完整 final。commentary、工具输出、普通 completion、SubagentStop、静默与 UI 轮询均不调用分类器。权限和问题 Hook 仅更新等待展示；用户在原终端自行处理。原生 Interrupt 或新的 UserPromptSubmit 使计算中的旧判定失效。

## 上下文与分类

输入保留有来源 ID 的原始用户任务、当前目标、计划正文及 digest、按时间排列的用户范围修改、最近相关对话和完整当前 final。会话阅读协议扩展 rawTurnId / phase；普通阅读保持兼容。当前 final 必须能在原始会话中定位。

用户可提供当前项目内的 Markdown 或 `.testplan.yaml` 相对路径。留空时从原对话的 `docs/plans/`、`docs/testing/` 引用读取；后续新增引用随 final 补入。读取会验证 realpath，拒绝跨项目、非计划类型与超过 10 个引用。每个判定保存当次完整快照，后续编辑不会改写旧快照。

输入上限为 180,000 UTF-8 字节。超限时只减少最近对话，不能截断原目标、用户范围修改、计划义务或本轮 final。必要材料仍超限、任务起点缺失或会话不完整时显示监听异常并等待补充，不生成业务判定。

分类复用现有 Codex provider 和登录链，在独立临时目录以输出 schema 调用受限 Codex exec。MCP、shell、浏览器、Hook 与子 Agent 功能关闭；出现非判断 provider 事件会拒绝输出。严格验证三项有限评分、总和、解释和来源 ID。调用结束或取消后删除临时输入/输出文件。

## 状态、额度与投递

| 结果 / 操作               | 行为                                             |
| ------------------------- | ------------------------------------------------ |
| completed                 | ended，允许原任务停止                            |
| blocked                   | ended，等待用户解决依赖，不能代审批              |
| continue，已使用少于 3 次 | 持久化决定并预留一次额度，当前 Stop 返回原生续接 |
| continue，已经使用 3 次   | paused / continuation_limit，不发送第四条追问    |
| 用户暂停或中断            | 取消当前分类，保留额度与历史结果                 |
| 模型失败、上下文缺口      | error；保留旧判断并明确显示其为上次结果          |
| thread / 执行器变化       | 旧绑定暂停，不能向新任务投递                     |

续接使用 Codex 原生 Stop `decision: block`，固定追问包含唯一 decisionId。它在同一原 thread / 执行器里继续，不清除、粘贴或提交 TUI 草稿。同一原生 turn 可以产生多条 final，因此去重同时使用原始消息 ID、回答 digest 和本次 Hook 身份，不能仅用 turn_id 去重。分类开始前持久化已处理的原消息游标；取消、失败或暂停的旧 final 也不会在恢复后重新执行。恢复先核对当前身份和最新 final，只等待后续新 final。开启请求在异步读取和能力探测之后再次复核目标身份，避免将旧任务绑定提交到新执行器。

持久记录的 `offered` 只表示已预留并返回续接，原会话中出现对应 decisionId 的监督输入才标记 `observed`。不能确认消费时保留已占次数并暂停为 `delivery_unknown`，不自动重放。暂停、恢复与 Backend 重启都保留次数。

只有用户明确确认「重新开启一轮监控」才能原子替换旧 watch，取得新的 0/3 额度。普通恢复不能绕过上限。Backend 重启只恢复身份仍一致、无不确定投递的 watching；paused / ended 不自动恢复。原终端被恢复成新 pane 或新执行器时，旧 watch 不会跟随。

Backend 持有监听生命周期，面板查询每 5 秒只读刷新；关闭监控面板不关闭监听。Backend 自身退出期间不执行分类，恢复也不补发旧指令。

## 配置与接口

实例 `settings.yaml` 的 `backend.taskSupervision` 域：

| 字段                    | 默认  | 说明                                        |
| ----------------------- | ----- | ------------------------------------------- |
| enabled                 | false | 实例开关；开启之后仍需逐任务确认            |
| model                   | unset | 使用原执行器报告的可用模型                  |
| classificationTimeoutMs | 90000 | 1,000–90,000 毫秒，受本次 Hook 截止时间约束 |

字段只能在所属实例本地配置，沿用统一配置重载和 owner 注册。Codex binary 与登录复用既有配置，没有 Jev endpoint 或 key。关闭开关或重载域会取消旧分类。

受既有认证保护的 `/api/task-supervision`：

- GET 根路径：terminalSessionId、panelId 与可选 expectedThreadId；发现绑定、任务起点和能力，不创建监听。
- POST 根路径：目标身份、任务起点、目标、计划相对路径及 requestId；同一请求幂等。新一轮携带 replacesWatchId / expectedRevision。
- GET `/:watchId`：状态、历史决定与输入快照。
- PATCH `/:watchId`：pause / resume / update-context，携带 expectedRevision；冲突返回 409。

内部 `/internal/task-supervision` 沿用实例 Hook token 与 Tunnel 边界，复核原目标及截止时间；`/validate` 在 bridge 输出续接前再次校验 watch / decision / revision。旧决定、身份变化或过期结果不能投递。

## 入口与验证

- 共享协议：[task-supervision.ts](../../packages/shared/src/task-supervision.ts)
- Backend 状态机：[service.ts](../../backend/src/task-supervision/service.ts)
- 公共 Hook 源码：[runweave-task-supervision.cjs](../../packages/agent-bridge/hooks/runweave-task-supervision.cjs)；执行 `pnpm agents:build` 生成分发副本。
- 前端入口：[panel.tsx](../../frontend/src/components/terminal/task-supervision/panel.tsx)
- 行为合同：[上下文与三分类](../testing/terminal/task-supervision-classification.testplan.yaml)、[原终端续接](../testing/terminal/task-supervision-runtime.testplan.yaml)。格式校验、类型检查与原型截图不代替行为验收。
