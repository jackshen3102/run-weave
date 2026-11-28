# 快捷指令双后台模式方案（纯后台 + 临时终端）

打开 [index.html](./index.html)，或从当前项目的 Files 以 HTML Preview 打开同一文件；也可从 Runweave 的 `/prototypes` 选择当前项目下的 `quick-input-terminal-mode`。修改后请手动刷新或重新打开。

## 原始目标

为快捷指令提供两种互补的后台运行方式：

1. **纯后台方式（`headless`）**：沿用现有非交互 CLI/SDK 调用，静默运行、不创建终端。
2. **临时终端方式（`terminal`）**：针对依赖真实终端身份、终端 Browser 附着或原生 TUI 环境的快捷指令，在原项目 / Worktree 新开一个专用 `tmux` 终端执行；顺利完成后自动关闭该终端，遇到受阻或人工介入时保留终端不关闭。

## 源码基线

基于当前仓库 `d1ec2fa8` 核对：

- 快捷指令模型与路由：[input.ts](../../../packages/shared/src/terminal/runtime/input.ts)、[quick-input-run.ts](../../../backend/src/scheduled-tasks/quick-input-run.ts)、[quick-input-popover.tsx](../../../frontend/src/components/terminal/input/quick-input-popover.tsx)、[quick-input-editor.tsx](../../../frontend/src/components/terminal/input/quick-input-editor.tsx)、[TerminalQuickCommandsView.swift](../../../packages/app-ios/Sources/RunweaveIOS/Features/Terminal/TerminalQuickCommandsView.swift)。
- 调度路由与执行/判定能力：[runtime.ts](../../../backend/src/scheduled-tasks/runtime.ts)、[codex.ts](../../../backend/src/scheduled-tasks/providers/codex.ts)（纯后台 `codex exec`）、[codex-terminal.ts](../../../backend/src/scheduled-tasks/providers/codex-terminal.ts)、[codex-options.ts](../../../backend/src/scheduled-tasks/providers/codex-options.ts) 与 [agent-preparation.ts](../../../backend/src/terminal/application/agent-preparation.ts)（免升级检查、免审批、跳过 Hook 信任、短脚本拉起参数链）、[classifier.ts](../../../backend/src/task-supervision/classifier.ts)、[assessment.ts](../../../backend/src/task-supervision/assessment.ts)（带 `--output-schema` 的旁路三分类与置信门禁）、[attention-service.ts](../../../backend/src/attention/attention-service.ts)（轮次内提问/权限/`OSC 7501` 硬阻塞识别）。
- 已保留终端的接管与防并发：[terminal-attachment.ts](../../../backend/src/scheduled-tasks/terminal-attachment.ts)、[quick-input-run-panel.tsx](../../../frontend/src/features/scheduled-tasks/quick-input-run-panel.tsx)、[types.ts](../../../packages/shared/src/scheduled-tasks/types.ts)。
- 现有快捷指令后台验收合同：[core.testplan.yaml](../../testing/background-commands/core.testplan.yaml)。

## 已选决策与待确认小项

- **已确认决策（完结 vs 受阻判定 —— 路线 B）**：
  - 临时终端**原样发送快捷指令**（不向 TUI 注入 `<scheduled_run_context>` 裸 JSON 要求，保持自然语言可读性与 `/slash` 兼容）；
  - 轮次进行中通过 Hook（提问/权限）、`OSC 7501 state=blocked` 及人工按键（`takenOver`）确定性识别挂起与接管；
  - 轮次到达 `agent_idle` 后调用旁路只读 `TaskSupervisionClassifier` + `assessClassification`：**仅高置信 `completed`（或确认中断的主动停止）自动关闭终端；`continue` 在同一临时终端内续跑（最多 3 次）；`blocked`、`hold`（置信不足）及运行报错一律遵循「宁留勿删」原样保留终端（`terminalBinding = ready`）**。
- **已确认决策（启动参数完全对齐定时任务终端）**：
  - 直接复用 `prepareTerminalAgent(..., { stageResumeCommand: true })` + `codexScheduledArgs(request)` 参数链，自动携带 `-c check_for_update_on_startup=false`（不检查升级）、`--dangerously-bypass-hook-trust`（不卡 Hook 信任确认）、`--sandbox danger-full-access --config 'approval_policy="never"'`（按运行快照策略免交互审批）、显式 `--model` / `model_reasoning_effort` 及 `-c 'tui.resume_cwd="current"'`。
- **其余默认推荐项（确认即可进入实施计划 / 开发）**：
  1. 在每条快捷指令上保存可选 `backgroundRuntime: "headless" | "terminal"`（旧指令默认 `"headless"`），列表保持一键点「后台」启动。
  2. 新建临时终端默认 `activate: false`（静默挂在原项目 / Worktree 下，不抢当前活跃终端焦点）。

## 模拟边界与验证记录

- 页面中的会话增删、完成/受阻/人工接管流转均为纯本地前端模拟，不调用真实 Backend API，不代表产品已实现。
- **静态检查**：已通过 `pnpm docs:check`；`index.html` 约 60 KiB，含 `runweave-visual-plan` 标记与稳定锚点，全部资源内联无外链。
- **浏览器交互验收**：已附着当前终端绑定的 Runweave Terminal Browser（`profile-1`），通过 Backend 真实 `/prototype-preview/` 端点验证：
  - 纯后台（`headless`）启动与完成全程不新增左侧终端会话；
  - 临时终端（`terminal`）启动时静默挂入当前 Worktree，顺利完成后自动关闭并回到 1 个终端，受阻或运行中人工输入接管时保留原终端且点击看板直达现场；
  - 编辑器模式切换、运行详情保留态、章节锚点跳转及桌面（1280×900）与移动窄视口（390×844、320×700）均无整页横向溢出。本轮未指定 iPhone 真机，手机真机阅读未执行。
