# SwiftTerm 本地源码依赖

来源：[migueldeicaza/SwiftTerm](https://github.com/migueldeicaza/SwiftTerm)，版本 **1.19.0**，
commit **464df5207fc2432e16c9a23abe538187196daf5f**；许可见 [LICENSE](LICENSE)。
RunweaveIOS 的 [Package.swift](../../Package.swift) 直接引用本目录，不修改下载缓存或在构建时打补丁。

## 分发与复核

保留上游 `Sources/SwiftTerm`（含 Metal shader）、`Sources/SwiftTermBuildInfoGenerator`、
`Plugins`、`LICENSE`。库共 84 文件，约 1.8 MB；不含 `.git`、构建输出、二进制、示例或测试。
`Package.swift` 只分发 Apple 平台库和必需的 build-info 工具/插件，去掉 CLI、benchmark、测试、
文档插件及其依赖；因此不再需要远端 SwiftTerm/ArgumentParser 的锁文件。

[upstream-files.sha256](upstream-files.sha256) 记录所保留输入的**原始上游**哈希；
[runweave.patch](runweave.patch) 记录代码/manifest 改动；
[runweave-privacy.ed](runweave-privacy.ed) 单独将上游 Buffer 调试输出的个人绝对路径改为系统临时目录。
隐私清理使用 ed 格式，只记录替换行而不再次分发被移除的个人路径。
复核或重建时从该 commit 导出清单中的文件，在副本根目录应用 patch，再执行
`ed -s Sources/SwiftTerm/Buffer.swift < runweave-privacy.ed`，然后逐文件比较
（本 README、哈希清单和两份补丁本身是分发元数据）。不对 `.build` checkout 应用。

## 补丁边界

- 本地历史沿用 UIScrollView 的像素滚动与系统惯性；已冻结历史在惯性期间同步阅读位置，
  防止后续输出拉回松手位置。触达底部后继续跟随输出，并将滚动位置通知宿主。

- `iOSTerminalView.opensLinksOnSingleTap` 默认关闭，仅 Runweave 开启。沿用现有 single-tap
  recognizer、bidi-aware buffer hit test 和 delegate；首次触摸无需先点一次聚焦。
  OSC 8 使用真实目标与原参数；普通 HTTP(S) 复用上游 implicit detector。
  已激活选区时走原选择处理，不把拖柄/长按/双击改成打开，也不新增滚动 recognizer。
- `LinkLookupMode.explicitAndImplicitSoftWrapped` 优先读取 OSC 8 的真实目标，普通文本只
  连接终端自然软折行。禁用上游通用 editor-wrap heuristic，不推测拼接硬换行。
  原 `.explicitAndImplicit` 行为不变。不新建 ANSI/单元格坐标映射或另一份 URL 正则。
- URL 仍交给 Runweave 的 BrowserURLPolicy；本补丁不授权 local/未知协议，不发送链接到 PTY。
- Buffer 的调试 dump 使用系统临时目录，不包含上游开发者的个人路径。
- build-info 插件固定声明 `1.19.0-runweave.1`、上述 commit 与 modified 状态，避免把包外层
  Runweave 仓库的 Git 信息冒充上游来源；generator 源码不变。

原生验收边界以 [验收状态](../../docs/validation-status.md) 为准。
