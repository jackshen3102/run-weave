---
name: daily-refactor
description: 仅当用户明确要求使用 daily-refactor skill 时使用；用于每天先确保 main 已更新到最新 origin/main，再审计 main 分支上一天 00:00 到当前的业务代码提交，执行架构防劣化检查、必要的行为保持重构和独立复核，最后调用 toolkit:github-pr 提交并合并 PR；没有安全且高价值的重构点时允许无代码结束。
---

# 每日重构

只有用户明确调用 `daily-refactor` skill 时才执行；未明确调用时不要使用这个 skill。

每天唤起后完成一次端到端防劣化审计：先确保本地 `main` 已更新到最新 `origin/main`，再基于 `main` 分支上一天 00:00 到当前的 commit 范围，量化架构变化、验证行为基线，只在存在安全且高价值的重构点时修改业务代码，最后调用 `toolkit:github-pr` 完成提交、push、PR、门禁跟进和合并。

目标是持续降低最近变更带来的架构熵，不是每天强制制造 diff。只有机械搬文件、包装巨型参数对象或迁移状态却形成双写时，视为劣化而不是重构。

## 范围

- 默认重构范围：`main` 分支从上一天 00:00 到当前的所有 commit。
- 计算时间窗口前，必须先 `fetch` 并让本地 `main` fast-forward 到最新 `origin/main`；如果无法 fast-forward，先停止并说明分叉状态。
- 只重构业务代码。
- 不重构框架代码、文档、配置文件、单测、集成测试、E2E 或其他测试文件。
- 默认时间窗口内如果存在超过 600 行的业务代码文件，必须优先选择该文件做重构拆分；拆分后单个业务代码文件不应继续超过 600 行，除非存在明确的框架或生成代码约束并在回复中说明。
- 架构硬门禁按全仓执行，选点和代码修改仍限定在时间窗口内受影响的业务代码；不要为修复窗口外或非业务代码债务扩大本轮范围。
- 没有高置信度目标，或无法证明行为保持时，不创建空洞重构 PR；直接按“无改动”发送总结。

## 防劣化完成定义

以下条件必须同时满足：

- `filesOver600`、runtime/type-only cycle、forbidden import、shared root import 和 architecture errors 在重构后全部为 0。禁止新增白名单、修改 baseline、降低阈值或加 lint disable 来绕过。
- `filesFrom500To600`、`propsAtLeast10`、`componentCallsAtLeast10`、`functionsAtLeast200` 不得比重构前增加；不得出现新的或更严重的对应热点。
- HTTP 服务端状态以 connection-scoped TanStack Query 为权威源；Zustand 只保存客户端拥有且同生命周期的 UI/选择状态；组件局部瞬时状态继续使用本地 hook；xterm、BrowserView、tmux、WebContents 等高频或外部资源由 controller/manager + refs 管理。
- 不把 Query 数据复制进 Zustand/组件 state，不用一个巨型 Context、viewModel、controller 或 options 对象隐藏 props 和回调数量。
- 拆出的模块必须有独立 truth owner、变化原因或依赖方向；只移动代码、继续由原父组件创建全部状态和动作，不算完成。
- 重构前后运行同一组行为验证；静态检查不能代替 Playwright 或真实运行时证据。

## 只读副 C 分工

如果运行环境和上层指令允许使用 sub-agent，启动两个只读副 C；主 C 是唯一代码写入者：

1. **侦察副 C**：只读取时间窗口 diff、before 架构报告和相关调用链，按“硬违规 → 临界文件 → props/长函数 → 状态双源 → 依赖方向”给出最多 3 个候选及证据，不改文件。
2. **审查副 C**：只读取最终 diff、before/after 报告和验证结果，检查行为漂移、假拆分、过度抽象、Query/Zustand 双写、资源生命周期和范围外改动，不改文件。

副 C 结论必须由主 C 回到真实代码核实，不能直接作为修改依据。环境不支持 sub-agent 时，主 C 串行执行同一套侦察与审查清单，并在总结中写明降级方式。

## 架构双快照

更新 `main` 后、改代码前执行：

```bash
run_dir="/tmp/runweave-daily-refactor/$(date +%F)"
mkdir -p "$run_dir"
pnpm architecture:report
cp artifacts/architecture-report.json "$run_dir/before-architecture.json"
pnpm architecture:check
```

重构后执行：

```bash
pnpm architecture:check
cp artifacts/architecture-report.json "$run_dir/after-architecture.json"
node plugins/toolkit/skills/daily-refactor/scripts/compare-architecture-reports.mjs \
  "$run_dir/before-architecture.json" \
  "$run_dir/after-architecture.json"
```

before 硬门禁失败时，先判断是否由默认时间窗口内的业务代码引入：能在本轮范围内安全修复才继续，否则停止并报告；不要在失败基线上叠加机会型重构。

## 默认流程

1. 看当前分支、远程和工作区状态，更新本地 `main` 到最新 `origin/main`，再查看 `main` 分支默认时间窗口内的 commit。
2. 对默认时间窗口内的 diff 做变更分析：列出受影响文件，过滤非业务代码，判断业务影响面。
3. 保存 before 架构报告并跑硬门禁；让侦察副 C 或主 C 的独立侦察阶段给出候选。
4. 只选择一个可验证重构点：优先修复硬违规，其次处理临界文件、新增复杂度热点、状态双源或反向依赖；没有目标则走“无改动”总结。
5. 重构前从 `docs/testing/command-matrix.md` 选择行为基线并实际执行。实现时应用 `toolkit:karpathy-guidelines`；涉及 React 时再应用 `toolkit:vercel-react-best-practices`，但不要为调用技能扩大范围。
6. 完成最小、行为保持的 vertical slice 重构，清理仅由本轮产生的孤儿。
7. 重跑同一组行为验证，保存 after 架构报告，执行架构报告比较器和 `pnpm quality:gate`。
8. 让审查副 C 或主 C 的独立审查阶段检查最终 diff；存在未解决的高风险结论时不发布。
9. 调用 `toolkit:github-pr`，由该 skill 负责提交、push、创建 PR、等待门禁和合并。
10. 发送一次飞书总结通知，随后回复重构内容、架构指标前后值、验证结果、副 C 结论、CI、commit、分支、PR 和合并状态。

## 验证回归

重构前：

- 完成 before 架构快照；记录本轮候选对应的文件行数、props/组件调用/函数长度和状态 owner。
- 基于 diff 分析结果，从 `docs/testing/command-matrix.md` 选择受影响路径对应的 E2E 命令。
- 前端业务代码变更至少跑一次相关 E2E；终端、Vim、Preview 等路径要跑对应专项 E2E。
- 涉及 UI、交互、布局或 Preview 展示时，保存 before 截图到 `/tmp/runweave-daily-refactor/<date>/before/`，不要提交截图。

重构后：

- 先重跑重构前选定的同一组 E2E。
- 如果变更影响 backend 或 packages/shared，再补充对应 default 测试。
- 涉及 UI、交互、布局或 Preview 展示时，保存 after 截图到 `/tmp/runweave-daily-refactor/<date>/after/`，并对比 before/after。
- 运行 after 架构快照比较、`pnpm architecture:verify` 和 `pnpm quality:gate`。
- 运行 `git diff --check`。
- 如果同组验证失败、架构比较器失败、审查副 C 有未解决高风险结论，先修复并重新验证；无法修复则停止，禁止提交、push 和创建 PR。

## 飞书总结通知

在最终回复前，必须发送一次飞书总结通知；如果本轮因为权限、冲突、验证失败、PR 门禁或人工评审无法完成，也发送一次阻塞摘要。不要调用
`runweave-hook-bridge.cjs`，因为它是 AI CLI Stop hook + Runweave terminal completion 上报链路，会依赖 `RUNWEAVE_*` 身份并可能产生额外副作用。这里直接复用现有飞书脚本的 webhook 配置、加签、日志和静默失败策略。

通知内容控制在 2500 字以内，至少包含：

- skill：`daily-refactor`
- 结果：成功 / 无改动 / 阻塞 / 失败
- 重构范围与核心改动
- 架构指标 before/after 与比较器结果
- 验证命令与结果
- 副 C 结论，或未启用 sub-agent 时的串行降级说明
- commit、分支、PR 链接、合并状态（如果已产生）
- 待人工处理项（如果有）

发送命令使用当前总结替换 `summary` 变量；脚本不存在、`jq` 缺失或飞书 env 未配置时不要阻塞最终回复，但要在最终回复里说明“飞书通知未确认发送”：

```bash
summary='本次 daily-refactor 总结...'
notify_script="${RUNWEAVE_FEISHU_NOTIFY_SCRIPT:-$HOME/.runweave/hooks/feishu_stop_notify.sh}"
if [ ! -x "$notify_script" ] && [ -x "plugins/toolkit/hooks/feishu_stop_notify.sh" ]; then
  notify_script="plugins/toolkit/hooks/feishu_stop_notify.sh"
fi
if [ -x "$notify_script" ] && command -v jq >/dev/null 2>&1; then
  jq -nc \
    --arg source "${RUNWEAVE_HOOK_SOURCE:-codex}" \
    --arg cwd "$PWD" \
    --arg session_id "${CODEX_SESSION_ID:-daily-refactor}" \
    --arg terminal_id "${RUNWEAVE_TERMINAL_SESSION_ID:-}" \
    --arg body "$summary" \
    '{
      hook_event_name: "Stop",
      source: $source,
      cwd: $cwd,
      session_id: $session_id,
      terminalSessionId: $terminal_id,
      last_assistant_message: $body
    }' | "$notify_script" || true
fi
```
