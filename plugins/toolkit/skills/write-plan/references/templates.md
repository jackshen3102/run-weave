# write-plan 模板与反例

按需使用本文件。不要把模板中的占位符原样留在最终计划里。

## 计划文档头部

```markdown
# [功能名称] 实施计划

> **给 agent 执行者：**根据任务风险选择执行方式。普通任务可按本计划顺序实现；高风险任务建议使用 subagent-driven-development 或 execution-grade 流程逐任务执行和 review。

**目标：**[用一句话说明要构建什么]

**背景：**[简要说明为什么要做，有哪些上下文]

**计划级别：**[Level 1 Directional / Level 2 Implementation / Level 3 Execution-Grade]

**架构：**[用 2-3 句话说明实现方案]

**技术栈：**[关键技术/库]

**非目标：**[明确不做什么]

---
```

## 文件结构章节模板

```markdown
## 文件结构

- 创建：`src/path/new_file.ts`
  - 负责：...
- 修改：`src/path/existing_file.ts`
  - 负责：...
- 修改：`tests/path/test_file.test.ts`
  - 负责：...

说明：遵循现有 `xxx` 模块的模式，不引入新的框架或全局重构。
```

## Level 1 / Level 2 任务模板

````markdown
### 任务 N：[任务名称]

**目标：**[这个任务完成什么]

**文件：**

- 创建：`exact/path/to/file.ts`
- 修改：`exact/path/to/existing.ts`
- 测试：`tests/exact/path/to/test.ts`

**实现要点：**

- [关键约束 1]
- [关键约束 2]
- [需要复用的现有函数或模式]

**关键接口 / 示例：**

```ts
// 只在关键接口、复杂逻辑或容易误解处给代码
export interface ExampleOptions {
  enabled: boolean;
  limit: number;
}
```

**如何验证测试：**

- 运行：`pnpm test tests/exact/path/to/test.ts`
- 预期：测试通过，并覆盖 [具体行为]
- 失败排查：优先检查 [可能原因]
````

## Level 3 执行级任务模板

````markdown
### 任务 N：[组件名称]

**目标：**[这个任务完成什么]

**文件：**

- 创建：`exact/path/to/file.py`
- 修改：`exact/path/to/existing.py:123`
- 测试/验证：`tests/exact/path/to/test.py` 或 `[手动验证路径]`

- [ ] **步骤 1：实现一个可验证的小变更**

说明要改什么、为什么改、关键约束是什么。复杂逻辑或接口签名给代码；普通 glue code 可以引用现有模式。

```python
def function(input):
    return expected
```

- [ ] **步骤 2：补充或更新必要测试 / 检查**

说明需要新增、更新或复用哪些测试。不要为了 TDD 机械要求“先失败”，但必须说明测试覆盖什么行为。

```python
def test_specific_behavior():
    result = function(input)
    assert result == expected
```

- [ ] **步骤 3：运行验证**

运行：

```bash
pytest tests/path/test.py::test_specific_behavior -v
```

预期：PASS，并覆盖 `[具体行为]`。

- [ ] **步骤 4：如何验证测试**

给独立验证 agent 的验收清单：

- 执行 `pytest tests/path/test.py::test_specific_behavior -v`，应通过；
- 检查 `[文件/接口/页面]` 中 `[具体行为]`；
- 负向场景 `[输入/状态]` 应返回 `[预期结果]`；
- 如果失败，优先检查 `[可能原因]`。

- [ ] **步骤 5：提交**

```bash
git add tests/path/test.py src/path/file.py
git commit -m "feat: add specific feature"
```
````

## 执行交接模板

仅当用户没有明确下一步时使用：

```markdown
计划已完成并保存到 `docs/plans/<filename>.md`。

建议执行方式：

1. **Subagent-Driven（推荐用于中高复杂度）**
   - 每个任务派发一个新的 subagent；
   - 任务之间做 review；
   - 适合并行或半并行推进。

2. **Inline Execution（适合小到中等任务）**
   - 在当前会话中按任务顺序执行；
   - 每完成一组任务设置 review 检查点。

3. **Manual Handoff（适合交给人类工程师）**
   - 人类按计划执行；
   - 按验收标准回传结果。

你选择哪种方式？
```

如果用户已经明确要求直接执行，不要再次询问，按最适合的方式推进。

## 常见错误

### 1. 把需求写得模糊，却把代码写得很细

错误：

```markdown
实现智能筛选逻辑。

步骤：新增 filter.ts，写一个 filterRepos 函数……
```

问题是“智能筛选”没有定义，代码再细也会偏。

正确：先定义筛选标准、输入输出、边界和验收，再写实现计划。

### 2. 计划替代规格说明

错误：

```markdown
Task 1: 创建数据库表
Task 2: 添加 API
Task 3: 添加页面
```

但没有说明用户行为、权限、错误处理和验收标准。

正确：先写 Goal、Requirements、Non-goals、Acceptance Criteria。

### 3. 所有任务都要求完整代码

错误：低风险任务也写大段代码，导致计划臃肿，并可能与代码库现状冲突。

正确：关键逻辑给代码，普通实现给约束和参考模式。

### 4. 只写“处理边界情况”

错误：

```markdown
处理各种边界情况。
```

正确：

```markdown
边界情况：

- 输入为空数组时返回空数组；
- 仓库缺少 description 时使用空字符串；
- stars 为 null 时按 0 处理；
- 数据源不可访问时返回降级来源结果，并在输出中标注。
```

### 5. 缺少验证

错误：

```markdown
完成后测试一下。
```

正确：

```bash
pnpm test tests/repo-filter.test.ts
pnpm lint
```

预期：测试全部通过，lint 无错误。
