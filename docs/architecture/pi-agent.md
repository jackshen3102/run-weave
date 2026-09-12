# Pi Agent 接入

Pi 是独立的 CLI provider `pi`，模型 provider 可以是 `openai-codex`。首发支持
Pi 0.85.1 起的兼容 0.x 原生 TUI、日常输入、历史与精确恢复。Agent Team、Race、
模型目录 UI 和自定义 provider 的自动恢复不在此版本范围内。

## 插件与公共桥接边界

Pi 原生包位于 `plugins/pi`，其 `package.json#pi` 声明扩展与 skill。`packages/agent-bridge`
是 Node 公共桥接的权威源码，负责既有 Hook 的归一化、投递与完成处理，以及原生扩展的
顺序传输。Backend、App Server 与原生端协议仍位于 `packages/shared`。

`pnpm agents:build` 生成自包含的 `plugins/pi/dist`，将桥接脚本一起分发，运行时只有
Node 内置依赖。该命令也生成 Toolkit 和 Electron 的兼容 Hook 资源；禁止直接修改
生成副本。Electron 打包与 Toolkit 同步均调用这一入口，不需要先手工同步 Toolkit。
`pnpm pi:install` 仅构建并安装 Pi，不更新 Codex/Trae 的插件缓存。

Pi 默认使用扩展旁的 `bridge/`；调试覆盖使用 `RUNWEAVE_AGENT_BRIDGE_ROOT`。
Pi 不读取宿主为 Codex/Trae 注入的 `RUNWEAVE_TOOLKIT_PLUGIN_ROOT`，避免它覆盖自带桥接。
桌面安装器与 CLI 共用 `packages/agent-bridge/src/install-pi.mjs`，在读取完整分发资产后
更新托管扩展，保留一次旧版备份，并保护同名用户扩展与 skill。

宿主侧采用静态装配：Backend `runtime/agent-adapters.ts` 管理原生草稿替换和恢复目标
校验；未声明原生替换的 CLI 继续使用现有终端按键路径。App Server
`agents/thread-readers.ts` 统一两个历史接口的 provider 选择，文件读取实现留在各自
provider 目录。新增 CLI 时补充其原生入口、宿主 Adapter/Reader 和共享合同；不在
插件中复制终端状态、鉴权、历史存储和完成提醒，也不动态加载宿主代码。

## 生命周期与身份

`plugins/pi/extensions/runweave.ts` 是 Pi 原生扩展，仅在 Runweave tmux Pane 内的 TUI
启用。它从实际 tmux Pane 读取 Panel ID，并为每次扩展实例生成 instance ID 与递增
sequence。事件携带 Pi session ID、规范化 session 文件路径、当前 leaf 和活动 run ID。
运行事实先通过 `appendEntry` 持久化为 `runweave.lifecycle` custom entry，再按顺序
发送到既有 Hook bridge；custom entry 不进入模型上下文。

`agent_start`/用户消息对应 running；只有 `agent_settled` 且 Pi idle 才结束活动。
中间的 `agent_end`、工具完成、自动重试和压缩不产生成功完成。
Pi 不使用“无启动租约转 idle”或“中断 5 秒后强制 idle”的旧兜底；trust 阻塞保持
starting，中断保持 running 直到真实 settled 或持久化生命周期补偿。最终 error/aborted
回到 idle，并保留 failed/interrupted 结果。`ui_prompt_start/end` 只更新待处理信息；
等待交互时私有编辑器拒绝远程提交，避免业务草稿被确认框吞掉。

Backend 在现有 Terminal、Panel、tmux Pane、operation 与 provider 校验后，再校验
Pi 实例及 sequence。成功 completion 只接收当前匹配的 settled，接受标识写入 Panel
持久化记录；Pi 桌面/飞书提醒在 completion 接口确认接收后发送。重复、旧实例与乱序
事件不能重新完成当前活动。App Server 的历史补偿只校正状态，不重发成功提醒。

## 输入、准备与恢复

Web Composer、iOS `line` 和 `rw` 共用 Backend 输入路径。扩展提供 uid 私有目录下的
Unix socket（目录 0700、socket 0600），按当前 terminal/session/instance 校验请求，
调用 `ctx.ui.setEditorText` 完整替换草稿；Backend 再通过同一 Pane 的原生 Enter 提交（首发基线为默认键位配置）。
同 Pane 的结构化输入互斥；重复请求或不可用扩展返回错误，调用方保留草稿。原始按键
与 Escape 保留既有通道。Pi 的 Ctrl+U 仅删除当前行，不能用于完整替换多行草稿。

`rw --agent pi` 的新进程启动需等待该实例的 bootstrap 成功 settled，再发送业务
消息；启动命令已投递不等于 ready。认证/trust 阻塞或 bootstrap 失败不会被当作 ready。
Pi overwrite 使用 `/new`，等待新会话身份建立后再发送。命令细节见
[Terminal CLI](../cli/terminal-cli.md#pi-agent)。

恢复前校验登记文件的真实路径、v3 header 与 session ID，然后使用
`pi --session <精确文件>`。Pi 对不存在的路径会创建新文件，因此不允许跳过校验。
Pane respawn 后内部启动命令明确走 shell，不受旧的 Pi 前台命令缓存影响。
自动恢复仍要求当前 active provider；仅有 `lastThreadId` 不会在重开终端时自动复活
已经退出到 shell 的会话。

## 历史与安装

`app-server/src/pi/session-reader.ts` 只读取已登记的绝对 JSONL 文件，校验 v3 header，
按 parentId 与当前 leaf 读取选定分支。它展示用户/助手消息、工具调用及结果、压缩和
分支摘要；未知记录、追加中的半行不会破坏已有完整记录。工具记录以明确标签展示，
不假装具备 Codex 的工具卡片结构。单文件读取上限为 64 MiB。

Stable Desktop 的 Hook installer 与 Toolkit 同步脚本安装扩展和 Pi 原生 `runweave`
skill；Beta 按既有策略不自动写全局 Hook。安装器保留用户自建的同名文件并备份已管理
扩展。正在运行的 Pi 需要 `/reload`。安装不迁移 Codex 凭据，不修改默认模型；动态
扩展 provider 或通过临时 `-e` 参数加载的模型不保证能随自动恢复重建。

## 验证边界

[日常终端测试合同](../testing/terminal/runtime/pi-agent.testplan.yaml) 包含原生 TUI、
排队、重试、中断、UI prompt、身份隔离、Composer、iOS、历史和恢复行为。
真实验收需分别覆盖独立分发安装、Pi 原生生命周期、Web/CLI 输入、App Server
历史恢复和 iPhone 图文/Stop；具体运行结果与环境身份保存到本地
`artifacts/pi-agent-acceptance/`，不以构建或历史版本的通过记录替代候选版本验收。

iOS 未修改 Swift 协议或界面；现有 agent 字符串与 HTTP 输入通道可承载 Pi。
个人团队 Debug 签名不启用 APNs；图文与 Stop 验收不证明远程推送交付。

## 一手资料

版本行为以本机 Pi 0.85.1 安装包为准，同时参考官方
[Extensions](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/docs/extensions.md)、
[Session format](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/docs/session-format.md)
与 [RPC](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/docs/rpc.md)。
