# 按承诺验收 · 方案评审

打开 [交互方案](index.html)，切换需求查看取证和交付示例，在导出流程中选择最后一个有证据的节点。页面可直接从 Runweave 终端文件链接或 Files Preview 打开。[桌面预览](preview.png)展示性能优化场景。

本稿对应 2026-11-24 的设计讨论。源码基线为 wt-1 的 `f01077ed` 加当时工作区内的[统一验收入口](../../../plugins/toolkit/skills/acceptance/SKILL.md)、[证据选择](../../../plugins/toolkit/skills/acceptance/references/evidence-selection.md)和[受阻判定](../../../plugins/toolkit/skills/acceptance/references/criteria.md)。已有入口支持按目标选择材料。本稿把讨论选定的组织方式具体化：以用户要证明的问题为主，工作类型提醒遗漏，跨步骤任务展开执行路径。场景可继续扩展，未要求增加产品页面或新的技能入口。

所有场景数据、状态和示意画面仅供方案评审。通过本次终端的 Runweave Browser 打开实际 HTML 预览，在 1280px、390px 两种视口分别操作全部 8 个场景和 6 个流程节点，确认对应内容切换、返回顶部可用且无整页横向溢出。390px 为桌面浏览器窄视口，未进行真机阅读验证。
