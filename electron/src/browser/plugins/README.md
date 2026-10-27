# Browser 插件宿主

右侧 Browser 通过统一宿主管理内置能力与第三方 Chrome 解包扩展。入口为工具菜单的
“浏览器插件”，所有命令作用于当前 Browser Profile。浏览记录是第一个内置插件，默认关闭。

## 新增内置插件

在此目录实现 `contract.ts` 的 `BrowserPlugin`，只在 `registry.ts` 登记。
宿主统一提供页面身份、Profile、Group、tab/popup 与恢复上下文，接管 `page.listen`
注册的事件和清理；启停只影响目标 Profile。功能命令与菜单由插件声明，新增功能不需要
在 preload、Frontend navigation 或工具菜单动作中添加专属分支。

Browser 核心仅在页面创建、弹窗创建和应用启动/退出调用宿主。状态与命令使用
`@runweave/shared/browser-plugins`，IPC 限定可信应用主窗口主框架。内置插件是经过审查的
应用代码，可使用 Node/Electron；不能从下载目录动态 import 此接口的实现。
单个插件的启动、同步回调或状态异常会显示该插件错误，其他插件继续工作。

内置浏览记录的观察器、配置和命令集中于 `builtin/history/`；记录语义与读取入口见
[本机浏览记录](../../../../packages/browser-history/README.md)。每个 Profile 独立持久暂存、
保存回执与错误，正常退出排空，未交付项在下次启动保留原身份重试。

## 安装 Chrome 扩展

1. 工具菜单 → 浏览器插件 → Chrome 扩展 → 安装解包扩展，选择含 manifest.json 的目录。
2. 核对目标 Profile、权限、匹配站点及兼容提醒，再确认加载。
3. 同一菜单提供启停、权限与兼容状态、声明了 popup 时打开扩展页面，以及卸载。

安装内容复制到应用私有 `browser-extensions/<installationId>`，目录与文件权限分别为
0700/0600；登记于 `browser-extensions.v1.json`，按 Profile 在每次启动时重新加载。
安装源目录之后移走不影响副本。拒绝软链接、特殊文件、深度超过 20、条目超过 10000、
解包内容超过 100 MiB 的包。卸载移除此安装的副本与登记，保留浏览记录。

外来脚本通过 Electron Session 扩展机制运行，不作为 Node 主进程插件执行。使用持久
Profile Session，临时本地预览 Session 不继承第三方扩展。扩展自身可依照其站点权限运行
网页代码，因此安装前仍需判断所选代码及权限。

状态“已加载，兼容未确认”仅证明 Electron 接受了扩展。需要在具体页面实际验证该扩展的
行为，不能据此宣称完整 Chrome 兼容。当前提供解包目录安装，不提供 Chrome 商店安装、
CRX 解包、自动更新、权限授予编辑器或通用浏览器工具栏 API 模拟。
Electron 官方仅支持部分扩展 API、持久 Session 和解包目录，且不会替应用记住跨启动加载，见
[Chrome Extension Support](https://www.electronjs.org/docs/latest/api/extensions) 与
[Extensions API](https://www.electronjs.org/docs/latest/api/extensions-api)。

## 验证

- 静态门禁：Electron、Frontend、shared 和 browser-history 的 typecheck/lint、架构检查。
- 真实文件恢复：`pnpm --filter @runweave/browser-history verify`。
- 实际 Beta、原生菜单、真实扩展与页面行为：
  [插件宿主验收](../../../../docs/testing/browser/plugins.testplan.yaml)。
- 现有跨浏览器记录语义：
  [历史采集验收](../../../../docs/testing/browser/history-collection.testplan.yaml)。

格式校验与构建结果不能替代扩展实际功能兼容验证。
