# Claude Code A：协议、安装、状态与会话

日期：2026-11-10。状态：部分实施，出口未通过。实际进度与未完成项见父计划的[实施记录](./2026-11-10-claude-code-parity.md#实施记录2026-11-10尚未完成)。
以下复选框表示完整验收出口，局部源码或 fixture 通过不勾选。
风险粒度：身份、配置迁移与并发按 L3；普通读接口接线按 L2。

## 用户结果与边界

用户可在现有 Terminal 手动启动 Claude，也可用 rw 精确准备；同一 panel 的真实 Claude 生命周期驱动状态，
桌面/Web/iOS 能阅读会话，退出后能恢复指定原生 session。外部终端和子 Agent 不污染当前面板或产生主任务完成通知。
本批不实现手机结构化回答、实时模型修改或后台任务；入口依赖能力声明，不能提前启用。

## A0：用现场 CLI 验证协议

- [ ] 在隔离项目、独立 pane 和专用测试 sink 中验证 `claude --version`、认证、一次只读真实模型请求；
      保留用户原有认证方式与网关，不向实际联系人发通知，不用新配置目录导致已登录凭据失效。
- [ ] 分别采集 startup/resume/clear/compact、prompt、工具成功/失败、Stop/StopFailure、SessionEnd、
      子 Agent 与权限等待的原生 payload；确认哪些事件为当前版本支持，哪些只存在于较新文档。
- [ ] 记录 session、transcript、message UUID/parent、turn 边界、进程归属和 hook 回传时序；确认 Stop 被其他 hook 阻塞后继续的行为。
- [ ] 验证 `--resume ID`、`--fork-session`、模型/effort 的读取与写入回执，以及 `-p --output-format stream-json`、
      `--json-schema`、问题/权限回传方式。只在隔离 fixture 内发起探测，不改常用项目规则。
- [ ] 将样本脱敏为现有 verify 脚本 fixture 与版本能力表；不提交原始用户 transcript、路径中的个人身份、token 或模型思考内容。
      无法证明的语义标为 unavailable，并阻止依赖该语义的能力启用。

出口：真实请求成功、身份来源可核对、已知支持/不支持项可复现；`--version` 或 auth status 单独通过不能作为出口。

## A1：身份、能力与配置合同

| 修改/新增路径                                                                                                              | 职责                                                                           |
| -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `packages/shared/src/terminal/runtime/state.ts`、`runtime/agent-preparation.ts`、`agent-resume.ts`                         | 增加 claude 类型及 `--resume` 参数语法                                         |
| `packages/shared/src/agent-capabilities.ts`（新增）及 package exports                                                      | 定义父计划的最小能力响应，不依赖运行时                                         |
| `backend/src/agent-capabilities/service.ts`、`backend/src/routes/agent-capabilities.ts`（新增）                            | 版本探测与登录态只读接口，接入现有 runtime/route owner                         |
| `packages/shared/src/configuration/fields.ts`、`services.ts`、`compatibility.ts`，`packages/config-node/src/validation.ts` | 注册 `agents.claude` 配置域、迁移及兼容版本                                    |
| `backend/src/terminal/state/terminal-state-service.ts`、`completion/source-gate.ts`                                        | 命令识别、来源与 active command/grace 门禁                                     |
| `backend/src/routes/terminal/state.ts`、`backend/src/app-server/handlers/terminal-agent-context.ts`                        | 传输校验与真实 provider 解析；移除把 Claude source 借认成其他 Agent 的兼容推断 |
| `packages/runweave-cli/src/commands/terminal-agent-preparation.ts`                                                         | rw 参数、prepare 以及等待/失败输出                                             |

- [ ] 配置增加实例级 `agents.claude.binary`、`agents.claude.configDirectory`，默认引用当前 Backend 的 PATH 与 Claude 原生配置目录；
      读取 `CLAUDE_CONFIG_DIR` 时遵循现有外部目录规则，不硬编码这台 Mac 的路径。会话根从配置目录的 projects 派生。
- [ ] 新字段、环境变量和文件访问进入 `scripts/quality/configuration-accesses.json` 分类；配置域按现有迁移机制演进，
      不直接提高全局 schema 绕开旧版本校验，不在 remote 配置 API 开放 binary 和任意文件路径修改。
- [ ] `GET /api/agent-capabilities` 使用现有登录鉴权；不接受客户端指定执行命令或 transcript 路径。
      capability 失败给出固定 reason code，不返回凭据、环境值或原始进程命令行。
- [ ] prepare 继续返回现有 `command_submitted/starting` 合同，业务方必须等待当前代次原生身份和就绪证据；
      trust、认证、版本不兼容或 hook 缺失明确失败/阻塞，不把业务 prompt 输入 shell 或选择菜单。

## A2：可维护安装与生命周期

| 修改/新增路径                                                                                       | 职责                                                               |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `packages/agent-bridge/hooks/runweave-hook-bridge.cjs`、`runweave-hook-payload.cjs`                 | Claude 原生事件转换与受控身份上报的权威源码                        |
| `plugins/toolkit/hooks/runweave-hook-dispatch.cjs`、`hooks.json`                                    | provider 分发；按支持事件生成 Claude 配置，不原样复制 Codex 事件集 |
| `plugins/toolkit/.claude-plugin/plugin.json`（新增）及 `scripts/toolkit/{sync,release,package}.mjs` | 同源 Toolkit 的 Claude manifest、版本资源、安装与升级              |
| `electron/src/hooks/hook-installer.ts`、`hook-installer-config.ts`                                  | 启用及迁移受管入口，兼容旧用户级 Hooks                             |
| `backend/src/terminal/application/agent-hook-processor.ts`、`backend/src/app-server/handlers/`      | 校验、绑定、去重与状态应用                                         |
| `app-server/src/state/{projector,reconciler,store}.ts`                                              | 原始事实投影及可证明的补偿                                         |

- [ ] Toolkit 插件为内容分发入口；旧用户级 Hook 迁移后每个事件只保留一个有效 Runweave handler。
      第三方 hook、Claude 原生模型与认证设置完整保留；无效 JSON 不覆盖，安装报告失败。
- [ ] 桌面和 `rw server toolkit install/update` 共用同源资产；单个入口负责生命周期上报。
      `pnpm agents:build` 生成 Toolkit/Electron 副本，禁止直接改分发副本；更新时不删除活跃会话仍引用的旧资源。
- [ ] 归属至少包含 provider、terminal、panel/pane、session、启动 operation 与进程代次；外部终端缺少有效上下文时静默不报。
      后台/旁聊/嵌套 Claude 继承 RUNWEAVE 环境时不能抢占父会话。新的 session 切换须由可信原生事件确认。
- [ ] 启动进入 starting；真实 prompt 进入 running；可信当前轮次 settled 才回到 idle；退出回到 shell_idle。
      Stop 进入结束候选，若后续 hook 要求继续则仍属原活动。仅助手文本、普通 stdout 或安静超时不能判定 settled。
- [ ] 子 Agent Stop、压缩、工具失败、中断和 StopFailure 分别表达，不制造主任务成功；权限等待维持主任务未完成，attention 与 completion 分流。
      本批沿用现有四态 TerminalState；等待/失败作为细分事实或 attention，不顺手重写全部 provider 状态机。
- [ ] completion 复用已有 canonical Backend feed，App Server 双写不得再次制造通知。使用当前代次与原生事件身份去重，
      同一事件重放只生效一次，新一轮同文消息仍能独立完成。
- [ ] 缺失 Hook 的补偿只接受已验证原生生命周期事实。若当前 CLI transcript 不具备可靠 settled 证据，明确 degraded，
      不根据最后一条 assistant 消息猜 idle。崩溃、断线和持久化重放不播放历史通知。

## A3：只读历史、预览与精确恢复

| 修改/新增路径                                                                                              | 职责                                              |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `app-server/src/claude/session-reader.ts`、`conversation-reader.ts`（新增）                                | 原生文件定位、身份与轮次读取                      |
| `app-server/src/agents/{conversation-reader,thread-readers,thread-previews}.ts`、`app-server/src/index.ts` | reader 组合、实时预览和服务 owner                 |
| `backend/src/terminal/application/{conversation,home-conversation,agent-preparation,agent-recovery}.ts`    | 目标匹配、准备与恢复                              |
| `backend/src/terminal/runtime/agent-adapters.ts`                                                           | Claude 原生命令及 host adapter                    |
| `packages/app-ios/Sources/RunweaveIOS/Contracts/` 及现有 Web conversation 消费者                           | 新 provider/可选字段兼容                          |
| `scripts/lib/app-server-event-center-client.mjs`、`scripts/toolkit/verify/`                                | 把 Claude 明确 unsupported 的既有断言更新为新合同 |

- [ ] transcript 路径由受验证 Hook 或受控 projects 根发现；HTTP 客户端不能传路径。核对源 session/provider 与归属，拒绝越界、
      symlink、身份冲突或替换，读取不修改源文件。进程上下文失去可信度时不使用猜测路径。
- [ ] 正文仅展示用户与助手可见文本，工具与生命周期供已有内部 reader 使用；不把 thinking、凭据、系统注入或子 Agent 消息混进正文。
      UUID/parent、分支、压缩与当前 leaf 以 A0 样本为准；稳定消息 ID 支持阅读位置和分页去重。
- [ ] 复用已有 64MiB 源窗口、8MiB 响应限制与 partial 标记；忽略追加中的半行，不将损坏、缺失和不支持混为一类。
      预览、详情、全文与补偿共享同一身份定位规则。
- [ ] resume 使用指定 ID 和原执行位置，启动后核对实际 session；缺失、歧义、认证或路径问题明确失败，绝不回退最近会话。
      Backend/tmux 重连刷新 hook endpoint/token，旧代事件不能覆盖新启动；不重发结果未知的业务 prompt。

## 验证与退出门禁

按改动执行现有检查：`pnpm agents:build`、`pnpm toolkit:verify-hooks`、`pnpm app-server:typecheck`、
`pnpm app-server:verify-state-sync`、`pnpm app-server:verify`、`pnpm architecture:check`，以及 shared/backend/cli/electron 的针对性 typecheck/lint。
配置变动按配置质量入口验证。verify 脚本可扩展，遵守仓库不新增单元测试的约束。

执行 [A 验收计划](../testing/terminal/runtime/claude-code-foundation.testplan.yaml)全部 required 用例；
真实 Claude、受控事件 replay、Web、iOS 与各安装平台分别保留 verdict。检查通过但未运行真实 CLI 时不得开放 ready。
失败回滚只撤销新增注册和受管资产；保留原 transcript、第三方配置及其他 provider 的工作状态。
