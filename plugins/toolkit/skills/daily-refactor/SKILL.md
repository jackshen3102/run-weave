---
name: daily-refactor
description: 仅当用户明确要求使用 daily-refactor skill 时使用；用于每天先确保 main 已更新到最新 origin/main，再按 main 分支上一天 00:00 到当前的业务代码提交范围执行重构、验证，然后调用 toolkit:github-pr 提交并合并 PR。
---

# 每日重构

只有用户明确调用 `daily-refactor` skill 时才执行；未明确调用时不要使用这个 skill。

每天唤起后直接完成一次端到端重构交付：先确保本地 `main` 已更新到最新 `origin/main`，再基于 `main` 分支上一天 00:00 到当前的 commit 范围，分析业务代码变更，做重构前基线验证，重构业务代码，做重构后回归验证，然后调用 `toolkit:github-pr` 完成提交、push、PR、门禁跟进和合并。

## 范围

- 默认重构范围：`main` 分支从上一天 00:00 到当前的所有 commit。
- 计算时间窗口前，必须先 `fetch` 并让本地 `main` fast-forward 到最新 `origin/main`；如果无法 fast-forward，先停止并说明分叉状态。
- 只重构业务代码。
- 不重构框架代码、文档、配置文件、单测、集成测试、E2E 或其他测试文件。
- 默认时间窗口内如果存在超过 600 行的业务代码文件，必须优先选择该文件做重构拆分；拆分后单个业务代码文件不应继续超过 600 行，除非存在明确的框架或生成代码约束并在回复中说明。

## 默认流程

1. 看当前分支、远程和工作区状态，更新本地 `main` 到最新 `origin/main`，再查看 `main` 分支默认时间窗口内的 commit。
2. 对默认时间窗口内的 diff 做变更分析：列出受影响文件，过滤非业务代码，判断业务影响面。
3. 从受影响的业务代码中选择一个重构点；如果有超过 600 行的业务代码文件，必须选择其中一个进行拆分。
4. 重构前先跑基线验证。
5. 完成代码重构。
6. 重构后跑同一组回归验证，确认原受影响行为没有被破坏。
7. 调用 `toolkit:github-pr`，由该 skill 负责提交、push、创建 PR、等待门禁和合并。
8. 发送一次飞书总结通知，内容与最终回复保持一致但更短。
9. 回复本次重构内容、验证结果、CI 结果、commit、分支、PR 链接和合并状态。

## 验证回归

重构前：

- 基于 diff 分析结果，从 `docs/testing/command-matrix.md` 选择受影响路径对应的 E2E 命令。
- 前端业务代码变更至少跑一次相关 E2E；终端、Vim、Preview 等路径要跑对应专项 E2E。
- 涉及 UI、交互、布局或 Preview 展示时，保存 before 截图到 `/tmp/runweave-daily-refactor/<date>/before/`，不要提交截图。

重构后：

- 先重跑重构前选定的同一组 E2E。
- 如果变更影响 backend 或 packages/shared，再补充对应 default 测试。
- 涉及 UI、交互、布局或 Preview 展示时，保存 after 截图到 `/tmp/runweave-daily-refactor/<date>/after/`，并对比 before/after。
- 运行 `git diff --check`。
- 如果验证失败，先修复并重新验证，再提交、push 和创建 PR。

## 飞书总结通知

在最终回复前，必须发送一次飞书总结通知；如果本轮因为权限、冲突、验证失败、PR 门禁或人工评审无法完成，也发送一次阻塞摘要。不要调用
`runweave-hook-bridge.cjs`，因为它是 AI CLI Stop hook + Runweave terminal completion 上报链路，会依赖 `RUNWEAVE_*` 身份并可能产生额外副作用。这里直接复用现有飞书脚本的 webhook 配置、加签、日志和静默失败策略。

通知内容控制在 2500 字以内，至少包含：

- skill：`daily-refactor`
- 结果：成功 / 阻塞 / 失败
- 重构范围与核心改动
- 验证命令与结果
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
