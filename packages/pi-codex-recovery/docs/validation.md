# Pi Codex Recovery 实现与验证

日期：2026-09-13。实现完成，11 条本地故障验收及真实 OpenAI 服务验证均通过。本文记录当前版本的验证范围与证据入口，不保证未来网络可用性。

## 实现

代码与启动说明见[独立扩展](../README.md)。按已接受的折中范围保留 Pi 0.85.1 的工具执行、OAuth 与压缩算法，独立控制 WS/SSE 恢复。

- WS 初次加 5 次重试，耗尽降级后 SSE 初次加 5 次重试；不叠加原生外层或 HTTP 层重试。
- 426 直接降级，运行中会话保持 SSE，连接和会话状态隔离。
- 明确建连失败使用独立网络等待，默认 5 分钟封顶；取消作用于握手、读流及两种等待。
- 通过公开 partial 快照重绘替换未完成文字；失败尝试不提交工具调用，成功后由 Pi 调度工具。
- 保留公开请求转换、Responses 解析、OAuth、模型目录及 onPayload/onResponse 合同。必要的请求构造代码附 MIT 许可证。
- 专用目录和 TUI 模式守卫，配置必须关闭原生重试；日志仅包含脱敏恢复元数据。

初版独立配置验收时未改动全局 Pi 安装、普通配置或活动终端 26dc452f。下文另列普通配置兼容与用户级安装的后续变更；不把早期隔离结论当作当前安装状态。

## 验证环境与证据边界

独立执行[11 条 required 用例](../../../docs/testing/terminal/runtime/pi-codex-recovery.testplan.yaml)，使用真实 Pi CLI 运行在 tmux PTY 中，真实加载候选扩展；模型服务由本地 HTTP/WS fixture 提供。observer 只订阅公开 Pi 事件，临时工具只写 fixture 计数文件。没有调用恢复控制器的单元测试，没有故障注入真实上游。

验证用 Pi 与原全局 Pi 的 `dist/bundle/cli.js` SHA-256 相同：`e6d7fcf36a239cf3746e67ddf4222081ac01a601b85a3ee688bdfe9c161d754c`。迁移前源码和独立 npm 锁文件校验值见[验证时源码清单](../../../.runweave/pi-codex-recovery/source-manifest.json)。

探针命令为 `node packages/pi-codex-recovery/scripts/recovery-probe.mjs --case <ID> --output <独立输出目录>`。汇总见[机器可读结果](../../../.runweave/pi-codex-recovery/results.json)；以下目录均有 verdict、终端文本、服务记录、公开事件和恢复日志。原始证据位于忽略目录，仅在当前工作区可读取，不假定它们会随 Git 分发。

| 用例    | 结果与关键事实                                                                      | 证据                                                                     |
| ------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| PCR-001 | 通过。6 次 WS、6 次 SSE；两阶段共 10 次有界退避，一次最终失败                       | [记录](../../../.runweave/pi-codex-recovery/PCR-001-r4/verdict.json)     |
| PCR-002 | 通过。2 次失败后第 3 次 WS 建连成功；下一轮复用连接，0 次 SSE                       | [记录](../../../.runweave/pi-codex-recovery/PCR-002/verdict.json)        |
| PCR-003 | 通过。426 后当前会话继续 SSE，新建会话重新尝试 WS                                   | [记录](../../../.runweave/pi-codex-recovery/PCR-003/verdict.json)        |
| PCR-004 | 通过。真实 TUI 旧文字被替换，失败工具执行 0 次，成功工具执行 1 次，无废弃工具卡片   | [记录](../../../.runweave/pi-codex-recovery/PCR-004/verdict.json)        |
| PCR-005 | 通过。后续请求重试时，先前工具仍仅执行 1 次，call ID 与结果保留                     | [记录](../../../.runweave/pi-codex-recovery/PCR-005/verdict.json)        |
| PCR-006 | 通过。默认真实网络等待到终态为 300004 ms；到期后新调用在网络恢复后成功              | [记录](../../../.runweave/pi-codex-recovery/PCR-006/verdict.json)        |
| PCR-007 | 通过。握手、流读取、普通退避、网络等待均可 Escape；无后续请求，活动连接关闭         | [记录](../../../.runweave/pi-codex-recovery/PCR-007-final2/verdict.json) |
| PCR-008 | 通过。401/403、额度、非法请求均停止；临时限速实际等待 2006 ms；超过 60 秒则结束     | [记录](../../../.runweave/pi-codex-recovery/PCR-008/verdict.json)        |
| PCR-009 | 通过。错误配置、目录、print 模式 0 次请求；原配置 hash 不变，原模型目录及历史头可读 | [记录](../../../.runweave/pi-codex-recovery/PCR-009-r3/verdict.json)     |
| PCR-010 | 通过。手动触发的摘要模型调用首次断流、重试成功，压缩历史可读，期间没有提前 settled  | [记录](../../../.runweave/pi-codex-recovery/PCR-010-final/verdict.json)  |
| PCR-011 | 通过。未知 fetch 失败走有限预算；诊断不含假凭据或正文标记                           | [记录](../../../.runweave/pi-codex-recovery/PCR-011/verdict.json)        |

探针调试中修正了自身的 typebox 路径、OAuth 假凭据形状、fd 初始化、Pi 版本提示字段、print stderr 取证、压缩历史切分和握手服务半关闭处理。这些修正没有改变 YAML 合同；失败尝试证据仍保留，不使用旧失败记录冒充通过。最后的取消复核观察到了客户端关闭信号，并确认服务端活动连接归零。

静态检查：扩展 `npm run check`、探针/setup 的 `node --check`、`git diff --check`、`pnpm docs:check`、指定 YAML 的 `pnpm testplan:validate` 均通过。静态检查与本地故障用例不证明真实上游可用性。

## 真实 OpenAI 服务验证

用户通过 Pi 原生 OAuth 完成独立配置登录，未复制原配置凭据。随后在同一真实 TUI 使用 `openai-codex/gpt-6-astra` 执行三轮任务：

1. 不使用工具，返回 `LIVE_WS_ONE`：成功，8953 ms。
2. 不使用工具，返回 `LIVE_WS_TWO`：成功，3647 ms。两轮结束后的进程、socket FD、设备标识、本地端口和远端地址完全一致，确认复用了同一 TCP/WS 连接。
3. 仅使用 `read` 读取当前目录 `acceptance.txt`，返回文件内容：实际执行一次 read，工具结果和最终回答均为 `pi-codex-recovery-live-verified`，文件未变化。工具前后两次模型调用分别耗时 2722、2709 ms。

共 4 次模型调用，全部通过真实 WS 完成，0 次重试、0 次降级。记录见[真实上游 verdict](../../../.runweave/pi-codex-recovery/live/upstream-verdict.json)、[恢复时间线](../../../.runweave/pi-codex-recovery/live/upstream-recovery.jsonl)、[实际消息与工具结果](../../../.runweave/pi-codex-recovery/live/upstream-messages.json)及[最终 TUI](../../../.runweave/pi-codex-recovery/live/final.txt)。消息证据只包含本次明确的验收提示、结果及必要工具元数据，凭据没有写入证据。

故障恢复由前述本地 fixture 验证；本次真实网络未发生故障，因此不把真实成功请求当作弱网恢复实测。也不从这些少量请求推算长期失败率。

验证结束后退出独立 Pi 实例并释放连接。专用配置、登录和会话保留在 `.runweave/pi-codex-recovery/live/agent-codex-recovery`，普通 Pi 入口没有切换。在本工作区根目录可复用已验证配置启动：

```sh
PI_CODING_AGENT_DIR="$PWD/.runweave/pi-codex-recovery/live/agent-codex-recovery" node packages/pi-codex-recovery/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js
```

该配置属于当前工作区的本地文件；删除工作区前应自行保留需要的凭据和历史。需要新的长期独立配置时按 README 的 setup 与登录流程建立，不自动迁移或覆盖旧配置。

## 迁移到 pnpm workspace 后的验证

扩展迁至 `packages/pi-codex-recovery`，使用根 `pnpm-lock.yaml`。原独立 npm 锁文件移出包；补齐 Pi CLI 与 OpenAI 类型的直接开发依赖，增加 `typecheck` 入口。后续 Pi 扩展按 `packages/pi-<name>` 独立成包。

恢复逻辑的所有 `src/*` 文件迁移前后 SHA-256 一致。根锁文件原有 14 个 importer、1409 个 package 和 1409 个 snapshot 的内容保持不变，只增加本扩展及其所需依赖。已有专用配置只迁移扩展入口路径，登录凭据保持不变。

迁移后重新验证：

- pnpm 冻结锁文件安装、包 typecheck、脚本语法、文档检查、YAML 格式及 diff 检查通过。
- setup 在全新临时配置中生成新路径，打印的 CLI 为 0.85.1；再次运行会拒绝覆盖已有配置。
- PCR-001 通过：6 次 WS、6 次 SSE、一次最终失败；PCR-004 通过：真实 TUI 替换断流文字，废弃工具不执行，成功工具仅执行一次。
- 使用已有独立登录，由迁移后的配置加载扩展，真实 `gpt-6-astra` 完成一次 read 与最终回答，共 2 次 WS 模型调用，0 次重试、0 次降级。文件内容、登录凭据和普通 Pi 设置的校验值保持不变，验收后独立 TUI 已退出。

记录见[迁移清单](../../../.runweave/pi-codex-recovery/migration/manifest.json)、[setup 验证](../../../.runweave/pi-codex-recovery/migration/setup-verdict.json)、[PCR-001](../../../.runweave/pi-codex-recovery/migration/PCR-001/verdict.json)、[PCR-004](../../../.runweave/pi-codex-recovery/migration/PCR-004/verdict.json)、[真实请求](../../../.runweave/pi-codex-recovery/migration/live-verdict.json)。旧源码清单和 11 条故障证据保留原路径与时间，作为迁移前基线；本次只重跑上述 2 条故障用例，没有重跑包含真实 5 分钟等待的完整矩阵。

## 普通配置兼容与用户级安装

在 `recovery.json` 显式设置 `profile: "shared"` 后，普通目录可启用扩展。只有收到 TUI 的 `session_start` 时才注册恢复 provider；非 TUI 保留原生 provider 及资源清理。此方式不改写全局 retry 设置，其他 provider 沿用原行为。仍会被公开分类器识别为临时失败的最终错误，先展示原始原因，再返回明确终态；上下文溢出保留给原生压缩。

已部署至 `~/.pi/packages/pi-codex-recovery`，通过 `pi install` 安装到普通 `~/.pi/agent`。Pi 将本地包保存为相对路径 `../packages/pi-codex-recovery`。原有 `pi-web-access`、`pi-subagents`、模型、技能、子代理设置与登录均保留；只新增包条目和 `recovery.json` 的显式启用设置。安装前设置备份路径见[安装收据](../../../.runweave/pi-codex-recovery/global/installation.json)。无需保留 worktree 才能运行已部署的扩展。

普通配置兼容探针使用真实临时 Pi TUI，并保持 `retry.enabled=true`：

| 用例    | 结果                                                                                     | 证据                                                                              |
| ------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| PCR-001 | 6 WS + 6 SSE；故障文字会被原生分类器视为临时错误，仍只产生一次最终失败，没有额外外层预算 | [记录](../../../.runweave/pi-codex-recovery/global/PCR-001-final/verdict.json)    |
| PCR-004 | 断流文字替换、废弃工具不执行、成功工具仅一次                                             | [记录](../../../.runweave/pi-codex-recovery/global/PCR-004-final/verdict.json)    |
| PCR-008 | 鉴权、额度、非法请求及限速恢复与截止均通过                                               | [记录](../../../.runweave/pi-codex-recovery/global/PCR-008/verdict.json)          |
| PCR-009 | 独立配置的原有目录、retry、非 TUI 守卫仍通过；本条不用 shared 开关                       | [记录](../../../.runweave/pi-codex-recovery/global/PCR-009-isolated/verdict.json) |
| PCR-010 | 压缩调用断流后恢复，成功摘要可继续使用，没有提前 settled                                 | [记录](../../../.runweave/pi-codex-recovery/global/PCR-010/verdict.json)          |
| PCR-011 | 未知 fetch 失败预算有界，诊断无假凭据或正文                                              | [记录](../../../.runweave/pi-codex-recovery/global/PCR-011/verdict.json)          |

真实安装验收使用普通 `pi` 和已有登录：read 工具返回 `PI_GLOBAL_RECOVERY_OK`；重启后 `pi -c` 继续原会话，WS 返回 `PI_INSTALLED_FINAL_OK`。后台 scout 完成任务并经原生通知回到父会话。非交互 `pi --mode json --print --no-session --thinking off` 返回 `PI_NATIVE_JSON_OK`，随后自然退出，退出码 0、耗时 9.8 秒。证据见[最终安装验收](../../../.runweave/pi-codex-recovery/global/installed-verdict.json)与[非交互结果](../../../.runweave/pi-codex-recovery/global/native-json-final-result.json)。

首次非交互检查等待进程退出超时；实现随后收敛为只在 TUI 注册 provider，最终复验自然退出。不能将中间仅收到 `agent_end` 后主动终止的尝试算作退出验收通过。JSON 已实测，RPC 使用同一不注册恢复 provider 的分支，但本轮未单独执行 RPC 客户端验收。未重复真实五分钟网络等待矩阵；此前完整矩阵是独立配置的基线。

## 适用边界

恢复控制器本身不支持任意 RPC/JSON delta 消费客户端；普通配置的非 TUI 模式完全保留原生 provider 注册，不启用本控制器。不移植 Codex 远程压缩协议、不实现多阶段 401 自动恢复。已完成工具不会由控制器重放，但不保证模型不会在新请求中主动再次要求同一业务动作。失败尝试的服务端计费不一定包含在最终响应 usage 中。
