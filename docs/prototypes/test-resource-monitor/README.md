# 开发资源早期草案

2026-10-07 保存的历史草案。当前产品的资源计数、刷新、释放与身份保护以
[开发资源合同](../../architecture/development-resources.md)为准，手机交互草案见
[手机开发资源原型](../mobile-development-resources/README.md)。

此目录的 `app.js` 仍是通用原型模板，要求 `views`、`actions` 等字段；
`mock-state.json` 保存的是 `desktop`、`simulators` 资源样例，两者结构不匹配。
因此不能把此目录当作可运行的资源监控页面或验收证据。样例中的电脑、任务、
PID、UDID、地址和时间均不代表当前环境，也不会停止真实进程或释放设备。

修复模板与样例的结构匹配后，仍需单独执行浏览器交互验收。
