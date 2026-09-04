# Agent Team Sidecar 当前 Terminal Scope Code Review

## 结论

通过。未发现阻断上线的 P0/P1 问题，`AGT-REVIEW-GATE` 判定为 `pass`。

## 审查范围

- Dispatch：`101e5d47-709d-400b-ae64-80010c756e40`
- Run：`atr_74ffec53_20260719090329`
- Code Agent 声明：`implementation.status=already_present`、`changedPaths=[]`
- 当前运行态 `reviewTarget=null`，因此以 Code Agent 指向的基线实现提交 `090eaf58565abed1501621b4b2dd53794868a03d` 为产品代码审查对象，核对范围为 `090eaf5^..090eaf5`
- 同步核对本轮生成的 `docs/testing/agent-team/lifecycle/agent-team-sidecar-current-terminal.testplan.yaml`
- 工作区中未提交的 `backend/src/agent-team/service-recheck.ts` 不在 Code Agent 声明范围，且与 Sidecar scope 用例无关，已排除并保持不动

## Findings

无 P0/P1/P2/P3 finding。

## 关键核对

1. `useAgentTeamScopeGuard` 使用请求发起时的 `projectId + terminalSessionId` 与当前 scope 比较；旧 scope 的结果直接拒绝，当前 scope 收到身份不匹配 Run 时清空展示并报告 fail-closed 错误。
2. 初始查询及 framework recovery 在每个异步提交点前重复核对 scope；旧 Terminal 的 success、error 和 loading finally 不会回写当前 Terminal。
3. Run action 与 framework recovery action 在 success、catch、finally 前核对 scope；旧 Terminal 的响应不会覆盖当前 Run、busy 或 error。
4. Terminal 切换时同步清空 Run、error、busy、loading、retry、framework recovery、worker drafts 与 active-run presence，避免旧内容残留。
5. 抽出的 header/gate 组件保持原有状态徽标、finding/acceptance 决策卡与 attention 展示顺序；新增身份行暴露当前 project、Terminal、Run 的 DOM data 属性。

## 独立验证

- `pnpm --dir frontend typecheck`：exit 0
- `pnpm --dir frontend exec eslint src/components/terminal/terminal-agent-team-panel.tsx src/components/terminal/terminal-agent-team-panel-model.ts src/components/terminal/terminal-agent-team-panel-summary.tsx src/components/terminal/terminal-agent-team-scope.ts`：exit 0
- `pnpm testplan:validate docs/testing/agent-team/lifecycle/agent-team-sidecar-current-terminal.testplan.yaml`：exit 0，识别 1 个 required case
- `git diff --check 090eaf5^ 090eaf5`：exit 0
- 测试计划 SHA-256：`eb5c0b1fcbbdf38e32357fb29933df97956e2cad65c1f26e05713ef55acbafce`，与 run JSON 一致

## 残余验证边界

本轮是只读代码审查，未执行 Dev Session 或真实页面行为验证。Terminal A/B/C 快速切换、迟到响应、无 Run 与身份不匹配响应的真实 DOM 行为仍由已分配的 `behavior_verify` worker 独立判定；该边界不构成本轮 P0/P1 finding。
