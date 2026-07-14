# Agent Team Finding 范围裁决

冻结范围：Agent Team 执行态顶部的生产交互。Final review 的可复现 P0/P1 如果无法自动证明其命中可追溯产品 Case，或 reviewer 建议其属于范围外，Run 暂停并展示该卡片。

## 保留到产品的行为

- 展示 finding、复现场景、预期/实际结果和 reviewer 证据。
- 展示测试文档来源的产品 Case，并允许人工选择受影响 Case。
- 提供三个互斥裁决：继续修复、标记范围外、本轮豁免。
- 继续修复与本轮豁免必须绑定至少一个可追溯产品 Case；标记范围外不要求 Case。
- 所有裁决必须填写原因，并作为独立审计记录保存。

## 原型辅助行为

无。页面中的交互均对应生产行为；原型仅在本地切换裁决后的展示状态，不调用后端。

## 冻结决策

- `status` 记录 finding 的事实生命周期，`disposition` 记录产品处理结论，两者不互相覆盖。
- generic Code Review gate 不是产品 Case，不能作为 final review blocker 的范围证明。
- reviewer 可以建议 `out_of_scope`，但 `waived` 只能由人工裁决产生。
