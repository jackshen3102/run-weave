# 质量工作流历史原型

[index.html](./index.html) 冻结了 2026-11-16 质量巡检的方案讨论，包含异常发现、归因、
台账与复验场景。示例问题为虚构，按钮只改变页面内存，不调用 API、不读日志、不启动任务。
通过 Runweave 文件 Preview 或 Prototypes 入口阅读，无需另起服务。

原型基线为 `06d2bd5167dce947cb3e3e42805a5e97c5a8563f`。
其中“拟议”“未实现”等文字描述当时状态；后续源码已实现采集与归因入口，
不能用该页面判断当前运行版本、上线范围或每日任务是否已启用。

## 当前事实入口

- [质量工作流 CLI](../../cli/quality-workflow.md)：持久队列、Backend 证据库、分页、覆盖和台账合同。
- [质量工作流验收](../../quality/quality-workflow-validation.md)：启用要求、历史验证与未完成项。
- [18 条验收用例](../../testing/quality/automatic-attribution.testplan.yaml)：自动采集、隔离、恢复与跨轮复验。
- [客户端操作诊断](../../architecture/client-action-diagnostics.md)：阶段证据和原有手动导出边界。

采集持续增量保全，每日任务执行归因；原型及其历史计划均不是部署或调度证据。
原始计划与调查过程从 Git 历史查阅，不再维护另一份当前合同。

## 历史验证边界

当时仅完成 HTML 结构、脚本语法及文档链接检查；原型浏览器交互受登录入口阻塞，
窄屏布局与 iPhone 真机阅读未完成。Clarity 调查不替代本原型验收。
本次文档整理不修改冻结 HTML，也不重跑其交互或设备验收。
