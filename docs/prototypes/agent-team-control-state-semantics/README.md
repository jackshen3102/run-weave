# Agent Team 控制状态语义

面向 Agent Team 侧栏的三类控制状态原型。

## 启动

```bash
python3 -m http.server 6188 --directory docs/prototypes/agent-team-control-state-semantics
```

打开：

```text
http://127.0.0.1:6188/?state=automatic-recovery
http://127.0.0.1:6188/?state=recovery-required
http://127.0.0.1:6188/?state=scope-decision
```

## 原型简报

- 目标：把笼统的“需要人工”拆成“正在自动恢复”“需要恢复现场”“需要范围裁决”。
- 用户动作：观察自动恢复；在恢复现场继续原 Run 或重新运行；对 finding 做范围裁决。
- 主要用户：在终端侧栏观察和处理 Agent Team Run 的开发者。
- 影响模块：Agent Team header 状态、顶部状态卡、执行区恢复卡与 finding 裁决卡。
- 关键状态：运行中的 protocol correction、blocked framework repair、pending finding decision。
- 非目标：不新增后端恢复协议，不提供通用“人工完成”，不改变 finding 事实。

## 冻结的操作矩阵

| 状态         | 识别事实                                       | 允许的写操作                             | 禁止的写操作         |
| ------------ | ---------------------------------------------- | ---------------------------------------- | -------------------- |
| 正在自动恢复 | running + protocol correction dispatch         | 无                                       | 恢复、重跑、范围裁决 |
| 需要恢复现场 | blocked framework repair 或非裁决型 need_human | 继续原 Run、重新运行（仅后端声明可用时） | finding 裁决         |
| 需要范围裁决 | pendingFindingDecision                         | 继续修复、标记范围外、本轮豁免           | 恢复、重跑           |

## 功能分类

### 产品核心功能

| 元素 / 行为              | 最终产品是否需要 | 产品价值                 | 备注                   |
| ------------------------ | ---------------- | ------------------------ | ---------------------- |
| 三类独立状态标签与状态卡 | 是               | 明确当前责任方和下一步   | 文案不再使用“需要人工” |
| 状态专属操作             | 是               | 防止错误恢复或越权裁决   | 自动恢复没有写操作     |
| 原因与恢复条件           | 是               | 让用户判断现场是否可恢复 | 复用现有字段           |

### 原型辅助功能

| 元素 / 行为      | 辅助验证什么       | 为什么不进入产品 | 备注              |
| ---------------- | ------------------ | ---------------- | ----------------- |
| URL `state` 参数 | 切换三种 mock 状态 | 产品状态来自 Run | 页面无可见 helper |

## 冻结记录

- 最终采用：顶部 badge 与内容卡使用一致语义；每类卡只出现本状态允许的操作。
- 放弃方向：继续显示“需要人工”再靠说明文字区分；它无法约束操作，也无法表达责任方。
- 产品核心功能清单：已确认。
- 原型辅助功能清单：已确认，不进入生产实现。
- 最终截图：`prototype-preview.png`。
- 冻结时间：2026-07-18。

## 边界

- 原型不连接真实后端、不导入生产源码。
- 原型只证明交互意图，不证明协议能力。

## 实施计划衔接

- 在 panel model 中建立唯一的 control-state 投影。
- header、attention、executing section 统一消费该投影。
- 复用 `protocolCorrectionAttempt`、`frameworkRepair`、`pendingFindingDecision`，不增加共享协议字段。
- 通过前端 typecheck/lint、聚焦验证和真实 Dev Session 页面验收。
