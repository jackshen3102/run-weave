# System Activity Data Foundation 产品原型

面向 `docs/plans/2026-07-11-system-activity-data-foundation.md` 与
`docs/testing/system-activity-data-foundation-test-cases.md` 的可运行 HTML 参考原型。

## 启动

```bash
python3 -m http.server 6188 --directory docs/prototypes/system-activity-data-foundation
```

打开 `http://127.0.0.1:6188/`。

## 原型简报

- 目标：让用户查询可追溯的 Recorded facts、显式关联 Timeline、来源分母和数据策略。
- 用户动作：切换四个视图，按事件/Thread/Project 搜索，筛选 runtime，输入显式 Timeline ID。
- 主要用户：需要核对 Runweave 本机行为事实与采集覆盖边界的用户。
- 影响模块：产品 `/activity` 页面、`/api/activity/*` 查询和 Data Policy 操作入口。
- 关键状态：有数据、过滤无结果、显式 ID 无关联、source gap、Activity unavailable。
- 非目标：Task、Goal、Outcome、Rework、Learning、模型结论和无分母 coverage 百分比。

## 与测试案例的对应

| 原型视图    | 主要用例                           |
| ----------- | ---------------------------------- |
| Facts       | ADF-022、ADF-026、ADF-028          |
| Timeline    | ADF-017、ADF-023                   |
| Sources     | ADF-018、ADF-024                   |
| Data Policy | ADF-019、ADF-020、ADF-021、ADF-025 |

## 功能分类

### 产品核心功能

| 元素 / 行为                      | 最终产品是否需要 | 产品价值                       |
| -------------------------------- | ---------------- | ------------------------------ |
| 四视图侧栏                       | 是               | 明确分离事实、关联、来源和策略 |
| Search 与 runtime 筛选           | 是               | 缩小事实查询范围               |
| Recorded / Computed 标签         | 是               | 不把推导值伪装成事实           |
| 显式 Timeline selector + ID      | 是               | 禁止按时间邻近猜关联           |
| Sources 连续序列与 gap 分母      | 是               | 诚实表达采集完整性             |
| 7/30 天、WAL、schema、delete job | 是               | 用户可核对数据边界             |

### 原型辅助功能

无可见辅助控件。数据来自 `mock-state.json`，不会连接真实 Backend。

## 冻结记录

- 最终采用的交互：左侧四视图、顶部全局搜索/runtime、Timeline 显式 selector。
- 放弃的方向：Learning inbox、自动结论、coverage 百分比；它们超出 P0 事实底座。
- 产品核心功能清单是否已确认：是，以冻结计划与测试合同为准。
- 原型辅助功能清单是否已确认：是，无可见 helper。
- 最终截图：`prototype-preview.png`（浏览器验收后生成）。
- 冻结时间：2026-07-12。

## 边界

- 本原型不连接真实 Backend，不证明 SQLite、鉴权或 Producer 已实现。
- 生产完成证据必须来自真实 `/activity` 页面和临时 Activity 数据库。
- 架构与数据流参考 `docs/architecture-flows/system-activity-data-foundation-flow/`。
