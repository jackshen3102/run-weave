# Runweave 文档总览

面向 Runweave 工程与智能体的 L1 文档入口。这里只负责把任务路由到下一层索引，
不维护每一份文件的重复清单。

## 从哪里开始

| 你要做什么                                | 下一步                                             |
| ----------------------------------------- | -------------------------------------------------- |
| 先理解代码目录、运行时和依赖方向          | [architecture/README.md](./architecture/README.md) |
| 使用或修改 `rw` CLI                       | [cli/README.md](./cli/README.md)                   |
| 启动、部署、更新或管理 Beta / Dev Session | [deployment/README.md](./deployment/README.md)     |
| 选择质量门禁、日志或运行证据              | [quality/README.md](./quality/README.md)           |
| 编写、查找或执行测试计划                  | [testing/README.md](./testing/README.md)           |
| 查看历史架构流程或交互原型                | [历史产物](#历史产物冻结)                          |

改动某个运行时或包前，还要读目标目录下的 `AGENTS.md`。完整清单以文件系统为准：

```bash
git ls-files '**/AGENTS.md' 'AGENTS.md'
```

## 文档分层

### 当前真相

`architecture/`、`cli/`、`deployment/`、`quality/`、`testing/` 描述当前实现、
操作合同和验证入口。它们需要随代码保鲜，是 Agent 判断现状的首要文档来源。

### 过程材料

`plans/` 与 `review/` 只承载正在进行的计划和评审，不是当前事实。任务完成后：

- 把仍有效的架构边界、操作合同和验收入口迁入当前真相；
- 删除已完成的过程文件及只服务于它们的资产；
- 不从旧 plan 或 review 反推现有实现。

### 历史产物（冻结）

| 目录                                         | 内容                                   |
| -------------------------------------------- | -------------------------------------- |
| [architecture-flows/](./architecture-flows/) | 特定基线的可运行架构、事件流与故障复盘 |
| [prototypes/](./prototypes/)                 | 特定需求阶段的 HTML/JS 交互原型        |

这些目录保留历史证据，但**不代表当前实现**。需要判断现状时回到当前真相和源码。

## 维护合同

- 文档价值、归属和生命周期的唯一规则见
  [`.agents/rules/documentation.md`](../.agents/rules/documentation.md)。
- 每个长期分类由本目录的 `README.md` 维护索引；本页只维护分类入口。
- 新增或移动 Markdown 后运行 `pnpm docs:check`，再执行与实际改动范围相称的验证。
- 纯文档保鲜不顺手修改产品代码；发现代码问题时单独报告和处理。
