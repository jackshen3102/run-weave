# 测试计划 YAML 格式

## 结论

Runweave 的新测试计划统一使用 `docs/testing/**/*.testplan.yaml`。Agent Team 只解析该格式，
不解析 Markdown 测试案例。已有 Markdown 用例可以继续作为历史或人工参考，但进入 Agent Team
前必须迁移为新格式。

规范目标是让 Agent 直接读自然语言，同时让程序可以稳定解析、校验和可视化。不要把步骤拆成
变量、selector、assertion、evidence、executor 等细粒度字段。

## 完整结构

```yaml
version: 1
name: 登录流程验收
description: >
  验证用户能够登录，并能看到登录失败时的明确提示。

cases:
  - id: LOGIN-001
    name: 正确账号可以登录
    required: true
    description: >
      验证有效账号提交后进入首页，并显示当前用户信息。
    preconditions:
      - 测试环境中存在一个可用账号。
      - 浏览器当前处于登录页。
    steps:
      - 输入有效账号和密码，点击登录；确认页面进入首页并显示当前用户信息。
      - 刷新页面；确认登录状态仍然有效。
```

## 字段规则

顶层字段固定为：

- `version`：必须是数字 `1`。
- `name`：测试计划名称，非空字符串。
- `description`：测试计划范围与整体正确结果，非空字符串。
- `cases`：至少一条、最多 20 条 case。超过 20 条时按功能边界拆为多个计划，
  不按页面、控件或历史缺陷机械分文件。

每条 case 的字段固定为：

- `id`：同一文件使用相同大写前缀，并从 `001` 按文件顺序连续编号。
- `name`：一句话说明被验证的行为。
- `required`：布尔值。`true` 是默认验收门禁；`false` 只在显式要求全量回归时执行。
- `description`：说明验证目标以及什么结果算正确。
- `preconditions`：非空字符串数组，只写执行前必须成立的事实。
- `steps`：非空字符串数组，用自然语言同时写动作和可观察结果。

不允许增加其他顶层或 case 字段。命令行门禁如果属于该计划，写成普通 case 或步骤，不新增
`commands` 字段。运行地址、Session ID、账号等动态值由执行上下文提供，不为它们增加变量字段。

## 组织原则

- 一份计划只覆盖一个系统能力或一个可独立验收的跨端闭环，例如 Terminal Runtime、Agent Team、
  Worktree Context；不要为单个按钮、样式、历史缺陷或静态检查单独建计划。
- 相同前置、相同状态机分支或相同安全边界的细节应合并为一条以不变量描述的 case；保留正常主链、
  身份隔离、恢复/幂等、鉴权和关键降级，不保留不改变系统正确性的视觉微调与穷举边界。
- 一个 case 可以覆盖同一不变量下的等价输入和必要分支，但步骤必须仍能给出确定、可观察的通过或失败证据。

## 文件命名与校验

文件名使用小写连字符并以 `.testplan.yaml` 结尾，例如：

```text
docs/testing/terminal/explorer-quick-search.testplan.yaml
```

校验单个文件：

```bash
pnpm testplan:validate docs/testing/terminal/explorer-quick-search.testplan.yaml
```

校验 `docs/testing/` 下全部新格式文件：

```bash
pnpm testplan:validate
```

格式解析器回归验证：

```bash
pnpm testplan:verify
```
