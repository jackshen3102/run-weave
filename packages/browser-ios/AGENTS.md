# iOS 共享浏览器

`RunweaveBrowser` 是 RunweaveIOS 与 SuijiIOS 使用的独立 Swift Package，仅依赖系统框架。

- 宿主通过 `BrowserContext`、实时呈现注册和 `BrowserSession` 输入用户意图；不得导入业务 App、凭据、终端或随记 API。
- `BrowserPage`、WKWebView 和导航策略保持包内可见；不要把 WebKit 的可变对象暴露给宿主。
- 来源失效先同步取消回调，再安全卸载文档；网站数据清理必须等全部退役文档卸载完成。
- 默认持久网站数据属于各 App 沙箱；不做跨 App 或业务账户 Cookie 同步。
- 修改共享行为后构建并原生验收两个宿主。入口和回归合同见 [README](README.md)，不新增单元测试。
