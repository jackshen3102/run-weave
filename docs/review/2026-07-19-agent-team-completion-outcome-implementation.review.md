# Agent Team Completion Outcome 实现自证

## 目标与边界

本次只解决一个问题：当产品 Acceptance Case 因明确环境问题无法执行，或 Case 本身不合理时，允许人工作出有审计证据的裁决，使它不再阻塞 Run 完成。

明确不做：

- 不把模型的 `fail` / `skipped` 改写成 `pass`。
- 不提供无条件 force complete。
- 不在本阶段创建或管理 follow-up work item。
- 不改变 `failed`、`cancelled`、Work History、Activity 等相邻语义。

## 最终语义

- 模型事实保留在 `latestObservation`。
- 人工裁决独立记录为 `acceptanceDecision`，包含类型、原因及所绑定的 observation。
- 自动路径保持严格；显式人工裁决可以解除已经由 pass 或人工决定解决的 Case 所关联的 repair/framework 阻塞。
- 仅允许两类裁决：`accepted_environment_skip`、`invalid_case`。
- 环境裁决只接受结构化的 `skipped + skip.code=environment`。
- Case 被裁决后仍显示原始 observation；Run 以 `completed_with_exceptions` 完成。
- 新 observation 与裁决绑定的 observation 不一致时，旧裁决自动失效。
- final review 仍必须通过；人工裁决不能绕过 review、active dispatch、framework blocker 或 finding gate。

## 风险复核与修正

自审发现 read projection 可能被 mutation 路径重新落盘，从而把兼容投影伪装成真实 observation。该 P1 已修正：completion/recheck mutation 路径统一读取原始 `runStore`，专项 verifier 同时增加结构门禁。

这项修正保证人工裁决绑定的是实际持久化 observation，而不是 GET 时合成的数据。

## 自证结果

以下检查全部通过：

- `pnpm typecheck`：9 个项目通过。
- `pnpm lint`：9 个项目通过。
- `pnpm agent-team:verify-completion-outcome`：13/13。
- `pnpm agent-team:verify-control-plane`：19/19。
- `pnpm agent-team:verify-fixture-lifecycle`：13/13。
- `pnpm testplan:validate docs/testing/agent-team/completion/agent-team-completion-and-intervention.testplan.yaml`：10 条 required Case。
- `git diff --check`：通过。

真实隔离 Dev Session `dvs-176dfc` 中调用新增裁决接口，结果为：

- HTTP `200`
- Run `status=done`
- 原 observation `outcome=skipped`
- Case 持久化状态仍为 `pending`
- completion `result=completed_with_exceptions`
- exception kind 为 `acceptance_disposition`

这证明裁决只改变“是否阻塞完成”，没有篡改模型事实。

## 未通过项

桌面 UI 行为未完成最终验收。Dev Session 日志构建的新前端入口引用 `index-LRfZ2mtb.js`，但 Beta pool-01 安装包实际仍加载旧的 `index-CLmreunH.js`；页面内容也包含当前源码不存在的旧功能。`web` surface 同时返回 `runweave://` 地址，无法按项目门禁通过 loopback Web surface 替代验收。

因此没有把旧 UI 当作新实现通过。该阻塞属于 Dev Session/Beta 安装资源不一致；继续修复会扩大到打包和安装链路，超出本次需求边界。Session 已停止，临时运行 fixture 已删除。

## 结论

核心状态机、接口和数据不变量已通过自动与真实 Backend 行为自证，未发现需要撤回方案的高副作用。前端源码已完成并通过静态检查，但桌面 UI 仍需在 Beta 资源同步问题修复后补一次真实页面验收。
