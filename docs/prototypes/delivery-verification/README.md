# 交付核验可视化方案

状态：历史方案。用户已确认将交付核验合并到现有 Review，独立技能和第二次派发已撤回。当前行为以
[技能入口](../../../plugins/toolkit/skills/review-only/SKILL.md)为准；
实际验证记录另存本机 `artifacts/verification-runs/delivery-verification-20261114/delivery-summary.md`。
以下保留原方案制作与检查记录。手机圈选不在范围内。

- 原始目标：把规格、独立判断、受影响回归和用户验收围绕完成条件连接起来，避免把反馈台账当作 Runtime 完成门禁。
- 打开 [index.html](index.html)，使用项目内 HTML Preview；也可在 `/prototypes` 选择当前项目的此目录。无需构建、外网或新增服务。
- 当前规则见 [Review 技能](../../../plugins/toolkit/skills/review-only/SKILL.md)，验收见 [统一 Review 行为用例](../../testing/skills/review-only.testplan.yaml)。原独立技能计划已撤回清理。
- 源码阅读基线：`db8668fe4dd3d03d3c763f6168dc9645d1aea9a1` 至 `f420e5418946bb21829d5496a378e7e88bdd583d`；读取期间有并行提交。关键入口见页面源码依据及实施计划。
- 历史取舍曾为独立交付核验技能；用户已否定其入口设计。现已合并到 Review，由已有入口冻结用户要求并交给同一 Reviewer，不再二次派发。
- 本 HTML 保留原讨论上下文，不能用其旧流程替代当前 Review 实现。
- 模拟边界：五个判定示例只是本地文档交互，不调用 Runtime，不代表实际交付或验收通过；流程不是新增产品 UI。
- 迭代：保留稳定章节与元素 id，修改同一文件后主动刷新。
- 静态检查：HTML 为 23027 字节，包含合同 meta、viewport、43 个唯一稳定 id；7 个锚点均有效，无外部资源。`pnpm docs:check` 通过。
- 真实浏览器检查：2026-11-14 使用 resolver 返回的 Runweave Terminal Browser Profile 1，附着 `delivery-plan-review`；从现有 Backend HTML Preview 文件票据入口读取，HTTP 字节与本地文件一致。五个场景按钮、展开说明、目录锚点及刷新复位通过。390px 窄视口文档宽 390px、正文 17px；宽表 700px 仅在 352px 容器内溢出。此结果不等于手机真机验收。
- 入口限制：浏览器中的 `/prototypes` 跳转登录页，本轮未验证原型库选择流程；使用现有 scoped HTML Preview 入口完成上述检查，没有启动新服务。
- 手机验收阻塞：指定 iPhonejackshen / iPhone 17，UDID `00008150-00195CC03E33401C`。agent-device 预检返回 CoreDevice error 1011，无法定位设备以检查锁定状态；未启动 UI 自动化，未执行真机阅读、触控或刷新。记录在 `.runweave/mobile-qa/delivery-verification-plan/`。
- 截图：首次视口截图为空白，未采用；后续完整页面截图成功，并已实际查看。有效截图为 `artifacts/verification-runs/delivery-plan-20261114/narrow-full.png`，来源是 Runweave Browser 的窄视口，不是真机。
- 清理：关闭本次新建的浏览器页，保留原有空白页并 detach；手机仅预检，没有启动 Runner。
