---
name: daily-refactor
description: 仅当用户明确要求使用 daily-refactor skill 时使用；用于每天先确保 main 已更新到最新 origin/main，再按 main 分支上一天 00:00 到当前的业务代码提交范围执行重构、验证、提交、push 并创建 GitHub PR。
---

# 每日重构

只有用户明确调用 `daily-refactor` skill 时才执行；未明确调用时不要使用这个 skill。

每天唤起后直接完成一次端到端重构交付：先确保本地 `main` 已更新到最新 `origin/main`，再基于 `main` 分支上一天 00:00 到当前的 commit 范围，分析业务代码变更，做重构前基线验证，重构业务代码，做重构后回归验证，提交、push，并创建 GitHub PR。

## 范围

- 默认重构范围：`main` 分支从上一天 00:00 到当前的所有 commit。
- 计算时间窗口前，必须先 `fetch` 并让本地 `main` fast-forward 到最新 `origin/main`；如果无法 fast-forward，先停止并说明分叉状态。
- 只重构业务代码。
- 不重构框架代码、文档、配置文件、单测、集成测试、E2E 或其他测试文件。

## 默认流程

1. 看当前分支、远程和工作区状态，更新本地 `main` 到最新 `origin/main`，再查看 `main` 分支默认时间窗口内的 commit。
2. 对默认时间窗口内的 diff 做变更分析：列出受影响文件，过滤非业务代码，判断业务影响面。
3. 从受影响的业务代码中选择一个重构点。
4. 重构前先跑基线验证。
5. 完成代码重构。
6. 重构后跑同一组回归验证，确认原受影响行为没有被破坏。
7. 提交代码。
8. push 到远程。
9. 创建 GitHub PR。
10. 回复本次重构内容、验证结果、commit、分支和 PR 链接。

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
