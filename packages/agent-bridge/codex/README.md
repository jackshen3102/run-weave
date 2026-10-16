# Runweave 受管 Codex

可选的本机 Codex 终端适配。原生 `/side`、`/btw`、Ctrl+/ 和空输入 Ctrl+C 仍由 Codex 实现；不创建新的 Runweave 聊天运行时，也不把旁聊保存为可恢复终端。

## 构建与启用

在仓库根目录运行 `pnpm codex:build`。构建器下载官方 `rust-v0.160.1` 源码，校验固定 SHA-256，再应用 [context.patch](context.patch)。需要源码指定的 Rust 工具链、系统编译工具及足够的编译缓存空间；首次构建需要下载依赖。本地编译带补丁的 CLI，配套 `codex-code-mode-host` 使用 OpenAI 同版本官方发布资产并核对固定 SHA-256；不修改该工具进程。保留上游 release 优化与 LTO 配置。当前构建器只支持 macOS。

输出路径为 `~/.cache/runweave/codex/0.160.1-<bundleId>/bin/codex`。版本目录同时按补丁、启动器和 Hook 资产计算摘要，保存源码、版本清单和上游许可证。`pnpm codex:build --dry-run` 只打印版本与目标路径。构建不会改变 PATH、全局 Codex 或 Runweave 配置。

使用既有 `agents.codex.binary` 配置选择输出的可执行文件。遵守 `rw config explain/set/validate` 的 revision/digest 合同；该项需要重启对应实例的 Backend 和 App Server，之后新建终端或恢复会话。已有 Codex 进程不会热替换。还原配置到原来的路径或默认值，并重启该实例，即可退出受管模式。

入口是 [launcher.cjs](launcher.cjs)。仅在 Runweave 终端的交互启动中启用观测。准备入口提供 panel 和 operation；自动恢复或手动启动时，启动器从当前 tmux pane 的实际绑定取得 panel，并为本次启动生成 operation。等待绑定最多 5 秒，仍不可确认则报错退出，不静默降级。普通命令和嵌套 CLI 不接管父进程的观测。需已安装 Runweave Toolkit 的 Codex hooks；受管启动将其既有 `RUNWEAVE_TOOLKIT_PLUGIN_ROOT` 路由指向本版本打包的 Hook 资产，不更新用户全局插件。受管交互使用上游 `--no-daemon`，使原生 hooks 的环境属于该终端；因此不支持要求共享 daemon 的 `codex agents` 总览及 `--remote`。原生旁聊、审批、模型和权限配置保持上游行为。

## 身份与输入合同

- 原生 TUI 在事件循环边界原子发布 `primaryThreadId`、`displayedThreadId`、旁聊父子关系、输入就绪和当前显示会话的运行状态。数据位于实例配置目录 `codex-context/`，文件为 0600，目录为 0700。
- `generation` 区分启动，`revision` 随身份、输入状态或原生草稿变化递增。草稿只发布指纹，不把正文写入观测文件。关闭会发布 closed 状态；异常退出还由启动器和 Backend 的进程存活检查收敛。
- Backend 复用已有终端输出观察器读取状态并发布 panel 更新；主身份用于持久恢复、完成事件和监督。旁聊 hooks 在桥接器进入 Activity、完成和监督路径之前过滤；Backend 再校验主身份。
- 浮动输入、快捷回复和文本附件带目标身份与版本。Backend 将短期请求写入同目录，并通过原有 PTY 的粘贴事件发送请求标记。原生 TUI 在同一个事件中检查实际显示会话、草稿指纹、版本、弹层和期限，再执行原生编辑及发送，写回结果。切换竞态被拒绝，超时不自动重发。
- 图片仍按现有上传路径分段调用原生粘贴。直接在终端输入的按键继续走原来的原生路径。
- 浮动草稿以 terminal、panel、generation、displayed thread 隔离；原生草稿仍由 Codex 自己保存。旁聊关闭后没有恢复入口；CLI 丢失时只以持久主身份恢复。
- 受管终端不因原生输出延迟自动打开浮动输入或抢焦点；浮动输入由用户打开，关闭时保留本地草稿，只有明确发送或排队才写回原生输入。

共享协议：[codex-context.ts](../../shared/src/terminal/codex-context.ts)。Backend 观察与输入：[codex-context.ts](../../../backend/src/terminal/runtime/codex-context.ts)、[codex-input.ts](../../../backend/src/terminal/runtime/codex-input.ts)。

## 升级边界

只支持此固定补丁基线。修改上游版本时必须重新核对源码归属、补丁可应用性、身份与原生输入语义，并重新执行 [旁聊验收计划](../../../docs/testing/terminal/codex-side-chat.testplan.yaml)。不能通过匹配屏幕文字、截断标题、最近一次 hook 或延迟关闭事件推测旁聊身份。未启用适配的官方 CLI 沿用原来的接入行为，不宣称具备受管身份隔离。
