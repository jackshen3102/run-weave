# 测试层级与命名

## 当前策略

- 本仓库只允许 Playwright E2E 作为正式自动化测试；当前 `frontend/tests/` 没有受 Git 管理的
  `*.spec.ts`，因此 `pnpm test:e2e` 会以 `No tests found` 非零退出，不能作为通过证据。
- 新增或重写的测试计划使用 `docs/testing/**/*.testplan.yaml`，格式见 `test-plan-format.md`；
  Agent Team 只解析该 YAML，不解析 Markdown 测试案例；单个计划最多 20 条 case。
- 后续若恢复 E2E，只能放在 `frontend/tests/*.spec.ts`，并同步更新本文件和命令矩阵。
- 架构约束由 `pnpm architecture:check` 的集成检查负责，不属于单元测试。
- 不维护 backend、Electron、CLI、`packages/shared` 的单元测试、Vitest 测试、Node test 测试、live test 或 coverage 门槛。
- 不新增 `*.test.*`、`*.ui.test.*` 或非 `frontend/tests` 下的 `*.spec.*` 测试文件。
- YAML 测试计划是可追溯的验收合同，不是自动化测试替代品。涉及浏览器页面的计划，仍须使用
  `$toolkit:playwright-cli` 在真实目标页面取证；涉及桌面端时先用 `$computer-use` 准备环境。

Terminal、Agent Team、Browser、Activity、App、Electron、CLI 和平台路径，按
`docs/testing/**/*.testplan.yaml` 中对应计划在真实服务上验收；不要引用或补造不存在的 spec。

探索性 Agent 或模型可以选择下一步操作，但必须保留原案例的输入、必需步骤和通过条件。
候选动作须受当前工具和目标状态约束；模型声称完成、一次 Demo 跑通或回退到主 Agent 后完成，
都不能替代独立的 UI 与业务后置状态核对。自由探索另记路径，不计作既有案例通过；
设备、服务或凭据不可用时记为阻塞，不计作通过或产品缺陷。Jev 在本仓库的浏览器与 iOS
执行收益尚未实测，不能据此宣称已接入或节省成本。

## 验证替代

- 文档门禁：`pnpm docs:check`
- 架构门禁：`pnpm architecture:check`
- YAML 格式：`pnpm testplan:verify`；新增或重写计划后执行
  `pnpm testplan:validate <path>`。
- 浏览器 E2E：当前无可执行 spec；恢复前使用对应 YAML 计划与 `$toolkit:playwright-cli`
  获取真实页面证据，不把 `No tests found` 报告为通过。
- 浏览器行为：按对应 YAML 计划使用 `$toolkit:playwright-cli`；桌面端联动先用
  `$computer-use` 准备目标实例。
- 前端类型：`pnpm --filter ./frontend typecheck`
- 原生 iOS 构建：`pnpm ios:doctor`、`pnpm ios:build -- --simulator <UDID>`
- 后端/Electron/CLI/shared：使用对应 package 的 `typecheck`、`lint`、`build` 或手工冒烟验证。

## 原生 iOS

`packages/app-ios` 的构建和运行命令见 [包入口](../../packages/app-ios/README.md)。
原生 UI 使用 Simulator / 真机实际操作；Playwright 只用于配套 Web 客户端，不能验证 SwiftUI。
日常排查和修复后的交互验收使用 [`toolkit:agent-device`](../../plugins/toolkit/skills/agent-device/SKILL.md)，
固定版本、独立设备会话并记录真实后置状态；录制回放只作辅助，不作为唯一的无人值守门禁。
验收合同为 `app/ios-native-terminal.testplan.yaml`、`app/ios-native-session.testplan.yaml` 和
`app/ios-native-features.testplan.yaml`。三种配置编译通过和 YAML 格式校验都不代表运行用例通过。
固定真机套件的预检与批执行使用 `packages/app-ios/scripts/device/runner/BatchRunner.swift` XCTest UI 执行器，
对应 `app/ios-device-preflight-reuse.testplan.yaml`。这是实际控件树、操作和附件的取证基础设施；
不新增单元测试或独立 live-test 框架绕过原生 UI 取证要求。
