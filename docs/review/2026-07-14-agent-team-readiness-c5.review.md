# Agent Team Readiness C5 Code Review

## 结论

`case_25` 不通过，仍有 1 条阻断 P1。

C5 working-tree patch 固定为 C4 `90c3b1102a45d0e47702461c194d58c597a2846a` → tree `a38c3a4db2cd8046fb01e2c5098cd52a20ae7f30`，精确 3 文件、99 additions / 20 deletions，diff SHA-256 为 `b488672a3b4277b260900c37bf6b839f444821facffc06e24a7f1160b6548ea5`。这是提交 checkpoint 前的 working-tree review；等待主 Agent 更新 Stable 后由 Backend 正式创建 C5 checkpoint。本审查未修改、stage 或 commit 源码，也未执行 behavior 验收。

## P1 阻断

### Codex node-wrapper readiness 仍由历史/易变 UI 文案决定

`isAgentUiReady` 对 `codex_node_wrapper` 仍先调用共享 `hasStartedCodexUi`；该 detector 扫描完整 scrollback，历史 `OpenAI Codex`/model marker 即使后面已经出现普通 Node 输出仍会返回 true。新增窄屏 helper 又仅用最后两个非空行的 `› ...` 与 `gpt-... …` 文案判定，无法区分“当前 prompt”与仍留在屏幕尾部的历史 prompt；两者输入相同，函数没有 pane generation、provider lifecycle 或 thread lifecycle 状态可用于区分。

独立受控反例：

- 当前 15 列 `› Find and fix` + `gpt-5.6-sol …`：true（期望 true）。
- 同样两行只是历史尾部、前面已有旧 shell 输出：true（期望 false）。
- 历史 `OpenAI Codex` marker 后已出现 `node server started`：true（期望 false）。
- 普通 Node、仅 prompt、仅 status：false。

因此 UI 文案/scrollback 不能作为 authoritative readiness。应按用户指定方向复用或建立类似 TraeX 的 pane-scoped provider/thread lifecycle 状态，并绑定当前 pane/owner generation；状态缺失或不一致时 fail closed，UI 只作为辅助诊断证据。

定位：`backend/src/agent-team/agent-readiness.ts:380-398,575-605`。

稳定 invariant：`agent-team.codex-node-wrapper-authoritative-readiness`。

## 已关闭 P1

`agent-team.serial-dispatch-readiness-failure-state` 已关闭：session/pane/readiness 失败会进入 `need_human`，清空 active role/dispatch、冻结 workers，且发生在 repair attempt 增量之前。独立探针确认 attempts 2→2。

定位：`backend/src/agent-team/service-serial-dispatch.ts:120-212`、`backend/src/agent-team/service-support.ts:239-251`。

## 验证

- `pnpm agent-team:verify-review-checkpoints`：通过，但不覆盖上述历史 Codex marker 反例。
- `pnpm --filter @runweave/backend typecheck`：通过。
- `pnpm --filter @runweave/backend lint`：通过。
- `git diff --check C4 -- <3 paths>`：通过。
- `.runweave/evidence/dvs-8854aa/readiness-p1/*.json`：支持 failure-state resolved 结论。
- `.runweave/evidence/dvs-eb7b08/readiness-narrow-p1/*.json`：证明 15 列当前 prompt 正例和部分负例，但其 historicalPrompt 用例不足以覆盖“历史 marker 仍位于尾部”及共享 detector 扫历史的反例。

## 非阻断既有项

P2 `recheck-watchdog-clock-lifecycle` 仍为 informational，本增量未处理，也不提升为 P1。
