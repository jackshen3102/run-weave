---
name: write-test-cases
description: 当需要为需求或改动编写、补全、迁移或规范化测试用例时使用。把真实代码行为写成 docs/testing/**/*.testplan.yaml 的最小标准结构，并在生成时按行为不变量、fixture 与资源生命周期边界拆分不可独立取证的组合 Case，供 Agent、Agent Team 和可视化程序直接读取；不执行用例。
---

# 编写测试用例

只负责编写用例。执行与取证交给 `run-test-cases`。

## 格式硬约束

新增或重写测试计划时：

1. 只生成 `docs/testing/**/*.testplan.yaml`。
2. 使用 `assets/test-plan-template.yaml`，并遵循项目内
   `docs/testing/test-plan-format.md`（如果存在）。
3. 顶层字段只能是 `version`、`name`、`description`、`cases`。
4. 每条 case 只能是 `id`、`name`、`required`、`description`、
   `preconditions`、`steps`。
5. 不新增变量、selector、assertion、expected、failure、evidence、executor、tags、
   dependencies、commands 或 priority 等字段。
6. 不生成 Markdown 测试案例。遇到旧 Markdown 用例时，保留原文件并在同级生成
   `<原文件名去后缀>.testplan.yaml`，不要继续扩展旧格式。

case ID 使用统一的大写前缀，从 `001` 按文件顺序连续编号。至少一条 case 使用
`required: true`；`required: false` 只表示显式全量回归时才执行。

## 内容要求

先读取相关实现、接口和现有文档，再写用例，不凭需求描述猜当前行为。使用等价类、边界值、
判定表、状态迁移、场景法和错误猜测检查覆盖；需要细节时读取
`references/design-techniques.md` 和 `references/coverage-checklist.md`。

保持自然语言完整：

- `description` 写清验证目标以及什么结果算正确。
- `preconditions` 只写执行前必须成立的事实，每项独立可读。
- `steps` 每项直接写动作和可观察结果，例如“点击登录；确认进入首页并显示当前用户”。
- 浏览器行为在步骤中明确使用 `$toolkit:playwright-cli` 操作真实页面；桌面联动使用
  `$computer-use`；静态检查不能冒充行为结果。
- 命令门禁如果需要，写成普通 case 或步骤，不新增字段。
- 动态 URL、Session ID、账号等由执行上下文提供，不为它们设计变量字段。

每条 case 聚焦一个行为、前提自足、结果可复现。不要写“功能正常”“适当校验”“测试一下”
等无法判定的句子。

## Case 原子性硬门禁

原子性的判断单位不是步骤数，而是“一个可独立取证、独立判定、独立恢复的行为不变量”。
每条 case 落盘前必须同时满足：

- 只有一个主不变量；等价输入和围绕同一状态迁移的 before/after 可以放在同一 case。
- 前置条件可由本 case 的执行者自行建立，不依赖上一条 case 的遗留状态或证据。
- 从建立前置到收集 verdict 都处于同一归属明确的 fixture 生命周期；若重启本身就是被测行为，
  必须由同一 case 完成重启前取证、重启、重新取得 fresh endpoint/UI ref 和重启后取证。
- 任一步失败时，整条 case 指向同一种行为或同一个最小恢复边界，不会掩盖另一条可独立通过的需求。

出现以下任一情况必须拆分：

- 一个 case 同时包含两个或以上可独立通过、失败或恢复的生命周期轴，例如设备模式、
  WebContents 重建、进程重启与 user-data 清理。
- 前半段已经形成可复用的 pass 证据，但后半段可能因另一项环境能力缺失而 blocked。
- 中途销毁或替换核心资源，导致后续步骤必须重新建立与主不变量不同的 fixture、surface、
  endpoint、target 或 UI ref。
- fail-fast 停在前半段时，会让另一个独立 required 不变量永远没有 verdict。

不要机械拆散同一不变量下的等价档位、边界值或一次状态迁移；cleanup 也不是独立 case。
例如，不要写“缩放状态同时遵守导航、设备模式、新 WebContents 和桌面重启边界”，应至少按
“同一 WebContents 内导航/重连”“与设备模式组合”“新 WebContents 默认值”“进程重启边界”
分别成 case。需要系统检查时读取 `references/coverage-checklist.md`。

## 工作流

1. 探测仓库约定与相关代码事实。
2. 先为候选 case 列出主不变量、必需环境能力、资源主体与生命周期、破坏性边界、证据来源和
   最小恢复动作；应用 Case 原子性硬门禁后再确定 case 列表，去掉重复或无关场景。
3. 按最小 YAML schema 落盘；同主题旧 Markdown 存在时在同级创建 YAML。
4. 运行项目提供的格式校验。Runweave 仓库使用：

   ```bash
   pnpm testplan:validate <测试计划路径>
   ```

   如果仓库没有校验命令，至少用标准 YAML 解析器读取文件，并检查字段、ID 唯一性与连续性。

5. 只汇报产出路径和格式校验结果，不执行用例。

## 落盘前自查

- 文件后缀是 `.testplan.yaml`，且位于 `docs/testing/`。
- 顶层和 case 没有额外字段。
- 每条 `description` 与 `steps` 已包含可观察的正确结果。
- 每条 case 只有一个主不变量，能在一次归属明确的 fixture 生命周期内完整取证。
- 不存在“前半段可 pass、后半段因独立环境能力 blocked”却仍绑定在一起的组合 case。
- 涉及重启时，重启是该 case 的主不变量，且步骤明确重新取得 fresh endpoint/UI ref。
- 所有 ID 使用相同前缀并从 `001` 连续编号。
- 至少一个 case 为 `required: true`。
- YAML 解析与项目格式校验通过。

必须使用中文编写测试计划。
