# 评审反馈的目标确认方案

历史可视化样例，验证新 visual-plan-review 源码技能的生成与反馈循环，不是当前产品规格。

目标：让用户在加入元素评论前识别目标文件和 pane。基线：2026-11-13，73ec552f，工作区实现中。
源码事实来自 frontend/src/components/terminal/preview/files/view.tsx、frontend/src/features/terminal/html-review/use-review.ts、frontend/src/features/terminal/input/prompt-store.ts 及 frontend/src/components/terminal/surface/composer-insertion.ts。

打开 [index.html](index.html)：终端 Files/Preview 或原型库同名目录。产物无外部依赖；按钮只修改自身状态，是行为 mock，没有真实输入框或 API。采用宿主固定目标、正文复读、手动发送；目标摘要位置仍待决定。

验证：本会话已明确读取 plugins/toolkit/skills/visual-plan-review/SKILL.md，按真实源码生成此例；真实入口验收结果在当前任务交付材料记录。

同一 HTML 已补充手机字号、换行导航、局部宽表滚动、上下章节锚点和版本文字；真机阅读验收尚受无线 XCTest code 74 阻塞，不能把桌面窄视口或模板检查记为通过。电脑圈选与页内评论复用共用 Browser runtime，宿主复用已有 Browser comments 面板。

二期：2026-11-14 在真实 Web 手动发送元素评论，Agent 保留 plan-title id 并修改同一文件标题，刷新 DOM 核对成功；Web/Electron 的 VPR-003～014 及普通 Browser 最小回归已完成。
