# 验收源文件生命周期代码评审

## 结论

“验收源文件生命周期不稳定”的 P1 已修复。

Agent Team 的正式输入和解析链路仅接受 `docs/testing/**/*.testplan.yaml`。`refresh_acceptance` 现在优先解析显式传入的新 YAML；未显式替换、且 run 记录的原 YAML 已被删除时，使用 run 内持久化的结构化 acceptance 与 SHA 继续刷新，不引入 Markdown 兼容路径。

## 发现

- **P1 已解决：删除原 YAML 不再阻断未显式替换的 refresh。** loader 对缺失文件提供结构化错误；服务仅在该错误对应 run 记录的 `generatedTestCaseFilePath`、且全部业务 Case 都能追溯到该来源时，重置持久化 acceptance 的执行状态并继续刷新。文件存在但内容漂移、YAML 非法，或显式替换路径不存在时仍严格失败，不会静默回退。
- **P2 一般：仓库并未字面完成“所有测试 case 都是 YAML”的迁移。** 当前 17 份 `*.testplan.yaml` 共 149 个 required case 均通过校验，但 `docs/testing/agent-team/agent-team-framework-repair-recovery-test-cases.md` 仍包含 ATFR-001～010，并被对应计划作为详细验收入口引用。当前 loader 明确拒绝 Markdown，因此这份文档不能作为 Agent Team 可追溯验收来源。定位：`docs/testing/agent-team/agent-team-framework-repair-recovery-test-cases.md:1`、`docs/plans/2026-07-17-agent-team-framework-repair-recovery.md:143`、`docs/README.md:57`、`backend/src/agent-team/acceptance-case-loader.ts:61`。修复方向：迁移为符合最小 schema 的 `.testplan.yaml` 并更新引用；若它仅是历史设计材料，则移出 `docs/testing` 并取消“测试 Case”定位。
- **P2 已解决：现有行为验证已覆盖源文件删除。** `repair-integration.mjs` 现在验证缺失来源分类、持久化合同执行状态清理、删除 YAML 后的实际回退，以及显式缺失路径仍失败。

## 已确认的缓解能力

- `rw agent-team intervene ... --generated-test-case-file <新 YAML>` 会把新路径传给后端；只要该文件仍位于当前项目 `docs/testing/`、以 `.testplan.yaml` 结尾并包含全部既有可追溯 Case，旧路径已删除也不要求继续使用原文件。
- 未显式传入新路径时，原 YAML 删除后可直接使用 run 内持久化合同继续授权刷新。

## 验证摘要

- `pnpm testplan:validate`：通过；17 份 YAML、149 个 required case。
- 定向 repair integration：14 项通过；其中 3 项覆盖持久化合同状态清理、删除来源分类和删除 YAML 后回退。
- `pnpm --dir backend typecheck`、`pnpm --dir packages/shared typecheck`、涉及文件 ESLint、`git diff --check`：通过。
- `pnpm agent-team:verify-review-checkpoints`：未通过，失败在与本问题无关的 `agent-team-thread-resume-preserves-fixed-worker-pane` 源文本断言；该结果不影响上述 loader 实测，但意味着不能把整套 Agent Team 校验报告为全绿。
