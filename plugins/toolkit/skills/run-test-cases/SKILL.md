---
name: run-test-cases
description: 当需要执行或验收 docs/testing/**/*.testplan.yaml 测试计划或用户给出的新格式 YAML 用例时使用。先校验最小 schema，再在真实浏览器、桌面或后端环境逐条取证；默认遇到首个失败即停，不负责编写用例，不兼容 Markdown 测试案例。
---

# 执行测试用例

把测试计划视为不可偷改的验收合同。只执行 `.testplan.yaml`；收到 Markdown 测试案例时停止，
要求先用 `write-test-cases` 迁移，不自行兼容解析。

## 先判定执行模式

- **Agent Team behavior dispatch**：prompt 已包含 `Run`、`Role: behavior_verify` 和本轮结构化
  Case 时，Backend 已校验输入测试计划（如有）、固化 Case 并记录来源摘要。直接执行 prompt
  分配的 Case；不重新解析原始 YAML，不探测或运行目标仓库的测试计划格式校验命令。目标
  仓库没有 `pnpm testplan:validate` 或其他 validator 不属于 environment blocker。
- **独立执行**：用户直接给出测试计划、没有 Agent Team behavior dispatch 时，由本 skill
  完成下面的格式校验，再开始执行。

## 独立执行校验

1. 读取完整 YAML，确认：
   - 顶层只有 `version`、`name`、`description`、`cases`，且 `version: 1`。
   - `cases` 包含 1-20 条；至少一条 `required: true`。
   - 每条 case 只有 `id`、`name`、`required`、`description`、`preconditions`、`steps`。
   - `id` 符合 `<统一大写前缀>-<三位连续编号>`；字符串非空，`preconditions` 和 `steps`
     都是非空字符串数组。
2. 仅当当前仓库的 `AGENTS.md`、项目文档或 package script **显式声明**测试计划 validator
   时运行它；不得根据 pnpm、Rush、npm 等仓库类型猜测命令。Runweave 仓库显式入口为：

   ```bash
   pnpm testplan:validate <测试计划路径>
   ```

3. 仓库没有额外 validator 时，第一步的最小 schema 校验结果即为格式校验结果，不能据此
   写 environment skip。
4. 校验失败立即停止，不猜测或修补格式。
5. 默认只执行 `required: true` 的 case，并按文件顺序逐条执行。只有用户明确要求全量回归时，
   才额外执行 `required: false`。

## 执行铁律

- 默认严格逐条执行，任一 case 失败立即停止。
- 不为了通过而修改测试计划。发现用例与已确认需求或当前前提矛盾时，停止并说明。
- 逐项执行 `preconditions` 检查，再按 `steps` 的自然语言完成动作和结果核对。
- 浏览器行为必须使用 `$toolkit:playwright-cli` 操作真实页面并获取 DOM、截图、控制台或网络
  证据；桌面端联动使用 `$computer-use`；后端、协议和 CLI 运行真实命令并保留关键输出。
- `typecheck` 和 `lint` 只是门禁，不能替代 UI 或行为取证。
- 承诺过真实验证但无法执行时，写明“未执行 + 阻塞原因”，不得用代码阅读或推断判为通过。

用户显式要求“失败后自己修”时，可以修实现并重跑当前 case；仍然不得擅自修改测试计划。

## 失败归因

以下情况视为用例问题并停止确认：

- 描述与已确认需求或当前代码事实直接矛盾。
- 前提条件已经不存在。
- 步骤没有写出可观察结果，无法判断通过或失败。
- 让它通过需要明显超出当前任务范围的行为修改。

其余可稳定复现的偏差按实现问题报告；只有用户授权自愈时才修改实现。

## 汇报

使用中文报告：

- 执行模式、测试计划路径、格式校验依据与结果。Agent Team 模式注明“使用 Backend 固化的
  acceptance，不重复校验”。
- 每条 case ID、通过/失败/未执行、操作或命令、关键证据。
- 未执行的 `required: false` case。
- 首个失败点、实际结果、期望结果和建议下一步。
- 自愈模式下列出修改文件与重验结果。
