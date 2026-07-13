# Codex / TraeX capability parity 增量代码复审（Round 15）

## 结论

`case_14` **PASS**。本轮以 index tree `87e5a8a84ea992c59f70a56140e96eef05dcf749` 为唯一审查对象，完整阅读相对 `253d97c9703323939a4275497d6251e3fec8dcb4` 的 2 个 staged path，沿 tmux 丢失后的恢复调用链核对 current / Recent Thread 的写入与清空语义，并独立复跑 resolver 矩阵、实际 `ensureTerminalRuntime` 恢复分支和仓库门禁。Round 14 暴露的 completed TraeX Recent Thread 无法恢复 P1 已修复，未发现仍开放的 P0/P1。

## Review checkpoint

- scope: `incremental`
- base commit / HEAD: `253d97c9703323939a4275497d6251e3fec8dcb4`
- target tree / index: `87e5a8a84ea992c59f70a56140e96eef05dcf749`
- requestedAt: `2026-07-13T08:31:22.811Z`
- staged paths: `backend/src/terminal/runtime-launcher.ts`、`scripts/verify-toolkit-hooks.mjs`
- diff 规模: 62 insertions、7 deletions
- `git diff --cached --check`: 通过
- prompt、run package、HEAD、index tree 与 staged path 完全一致

## 根因与修复闭环

Round 14 的真实失败现场不是 provider 或 threadId 未持久化，而是完成态语义改变了身份所在字段：Stop 路径清空 current `threadId/threadProvider`，同时保留 `lastThreadId/lastThreadProvider/lastThreadStatus`。失败现场因此为 `activeCommand=null`、current identity 为空，但 Recent Thread 明确保存真实 TraeX ID 与 `traex` provider。旧 resolver 强制要求 active provider 与 current identity 同时存在，最终进入 `terminal.tmux.session-missing.rebuild`，创建 fresh shell，resume 注入次数为 0。

当前 resolver 的恢复优先级为 active provider → current provider → 显式 Recent Thread provider；解析到预期 provider 后先采用匹配的 current identity，再采用 provider 精确匹配且非空的 Recent Thread。它不从 cwd、时间、日志文件或缺失 provider 推断身份，因此：

- completed TraeX：active/current 均空、Recent Thread 为 `traex + threadId` 时可恢复；
- active provider 与 Recent Thread provider 不一致时返回 `null`；
- Recent Thread ID 为空或 provider 缺失时返回 `null`；
- 旧数据只有 current threadId 时继续按 Codex 兼容语义恢复；
- current identity 与 Recent Thread 同 provider 时优先 current identity。

调用方边界保持收敛：只有 tmux session 实际缺失、未启用 `allowMissingTmuxSession`、原 launch 为交互式 shell 时才计算恢复目标；`sendInput` 只位于新建 detached session 的 `!hasSession` 分支。独立整链路 mock 证明首次恢复只创建 1 个 session、只注入 1 次 `traex resume thread-trae-recent`，第二次 attach 直接复用 runtime，不会重复注入。

## 独立复验

- Resolver 矩阵：7/7 通过，另含 TraeX / Codex 两条 exact command 断言。
- 整链路 missing-session harness：通过，结果为 `one rebuild, one resume injection, cached second attach`。
- 整链路 harness 第一次调用因 `tsx -e` 的 CJS 模式不支持 top-level await，在 esbuild transform 阶段退出，未执行产品代码；改为 async IIFE 后在同一 target tree 原样复跑通过。这不是产品失败，已保留以区分 harness 入口错误与目标行为。
- `pnpm toolkit:verify-hooks`: 通过，包含 completed Recent Thread、provider mismatch、空 ID、缺 provider及既有 Hook/provider/pane fixtures。
- `pnpm typecheck`: 通过。
- `pnpm lint`: 通过。
- `pnpm app-server:verify-state-sync`: 通过。
- `pnpm agent-team:verify-review-checkpoints`: 21 项通过。

## Findings

### Resolved P1

**完成态 TraeX 只保留 Recent Thread 时，tmux 丢失恢复错误创建 fresh shell。** 当前实现可从显式、匹配的 Recent Thread 恢复真实 TraeX thread，负向 provider / ID 门禁保持 fail-closed，且恢复命令只在新建 tmux session 后注入一次。

### Remaining

无 P0/P1；`remainingFindings=[]`。

本轮只新增此 review 文档与 pane outbox；未修改源码、测试、Git index 或 HEAD。真实 Dev Session tmux 销毁/重建属于后续 behavior_verify，不以本次只读代码评审的 mock 替代。
