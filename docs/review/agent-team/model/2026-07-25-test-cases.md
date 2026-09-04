# Agent Team 模型配置测试用例评审

## 结论

建议补充两条独立 required Case，编号为 `AGT-MC-014` 和 `AGT-MC-015`。不建议把它们并入现有 `AGT-MC-008` 或 `AGT-MC-011`：两条新增契约分别需要隔离 ambient 配置和构造冲突 API 请求，前置条件、失败定位与副作用检查都不同。

## 发现

- **P1 严重：关闭 Fast/Max 的 ambient 覆盖没有被真实场景验证。** 计划明确要求关闭状态也编译显式 `standard/false` 参数，防止用户级 CLI 配置改变 Run 的实际行为；现有 `AGT-MC-008` 只检查启动参数包含 `fast 或 standard`，没有先建立“ambient 已开启、Runweave 已关闭”的冲突条件，也没有明确检查 `features.fast_mode=false`。实现即使遗漏关闭参数仍可能通过当前 Case。定位：`docs/plans/agent-team/2026-07-25-global-role-model-config.md:242`、`docs/testing/agent-team/configuration/agent-team-role-model-config.testplan.yaml:108`。修复方向：独立新增 `AGT-MC-014`，同时检查 Run 快照中的编译参数和实际 pane 启动参数；测试应使用隔离配置目录或测试账号，不直接改写开发者现有配置文件。
- **P2 一般：`retryOfRunId` 与 `terminal` 互斥的 400 契约没有 Case。** 计划已把两者同时出现定义为非法输入，并要求在生命周期第一步校验；`AGT-MC-011` 只覆盖合法 Retry 的快照继承，`AGT-MC-012` 只覆盖合法显式 `terminal`。如果实现错误地选择其中一个来源，现有用例不会失败，可能产生来源不明确的新 Run。定位：`docs/plans/agent-team/2026-07-25-global-role-model-config.md:193`、`docs/testing/agent-team/configuration/agent-team-role-model-config.testplan.yaml:152`。修复方向：独立新增 `AGT-MC-015`，提交同时带两个字段的创建请求，断言 400、稳定错误详情，并对 Run JSON、pane、checkpoint 分支做零副作用对比。

## 推荐 Case 边界

### AGT-MC-014：关闭 Fast/Max 时显式覆盖 ambient 配置

- 在受控隔离环境中把 Codex Fast 与 TraeX Max 的 ambient 配置设为开启。
- 保存 Fast/Max 均关闭且同时包含两个 Provider 的角色配置。
- 启动能实际覆盖两个 Provider pane 的 Run。
- Codex 断言同时存在 `features.fast_mode=false` 和 `service_tier="standard"`。
- TraeX 断言存在 `model_backend_variant="standard"`。
- 同时核对 `roleRuntimes.roles[*].terminal.args` 与 pane 实际启动命令，避免只验证快照或只验证 UI。

### AGT-MC-015：Retry 来源与显式 terminal 冲突

- 准备同 Project、同 Terminal 的 failed source Run。
- 调用创建接口，同时提交合法 `retryOfRunId` 与合法 `terminal`。
- 断言 HTTP 400，错误能够指出两个 runtime source 互斥。
- 对比请求前后的 Run 集合、pane 集合与 checkpoint 分支，确认没有副作用。
- 确认 failed source Run 本身没有被修改。

## 更小方案与权衡

最小改法是把 A 追加到 `AGT-MC-008`、把 B 追加到 `AGT-MC-011`，不增加 Case 数。但这会让单个 Case 同时承担正常启动与相反配置、合法 Retry 与非法输入两组 fixture；其中任一步失败都会让后续证据无法独立取得。新增两条 Case 只增加 2 个 required Case，却能保持一条 Case 对应一个行为不变量，失败定位更直接，因此推荐总数从 13 调整为 15。

## 残余风险

- TraeX ambient Max 的实际配置字段需要在实现时以当前 CLI 行为确认，测试计划不应猜测用户配置文件内部键名；验收契约应落在 Runweave 最终显式传出的 `model_backend_variant="standard"`。
- 测试过程不得直接覆盖真实用户的 `~/.codex/config.toml` 或 `~/.trae/traecli.toml`；应使用隔离 HOME、CLI 支持的配置根目录或专用测试环境，并保留恢复证据。
