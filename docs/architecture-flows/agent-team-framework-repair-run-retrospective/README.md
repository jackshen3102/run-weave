# Agent Team framework repair Run 复盘原型

本目录把 `atr_a07db00d_20260717170123` 的执行事实、Human Gate 因果链、遗留现场和改进优先级做成一个可运行的静态页面。

## 查看

```bash
python3 -m http.server 6198 --directory docs/architecture-flows/agent-team-framework-repair-run-retrospective
```

然后访问 `http://127.0.0.1:6198`。

## 事实边界

- 父 Run 最终状态为 `done`，11/11 acceptance case 通过。
- 统计基于父 Run JSON、17 份 pane-scoped outbox history、相关 review 文档、测试案例文档和当前实现代码。
- Human Gate 等待时长由相邻 outbox consume / intervention 时间估算，页面中明确标注为估算值。
- 页面不修改 Run 状态，也不清理复盘发现的遗留 fixture Run。

## 页面验收

- 总览、时间线、根因、改进、证据五个视图可以切换。
- 时间线可按协议、调度、范围、验证四类过滤 Human Gate。
- 1440×1000 视口无横向溢出，浏览器控制台无 error。
- Playwright 验证截图保存在 `prototype-preview.png`。
