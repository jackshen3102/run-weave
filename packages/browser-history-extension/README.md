# Chrome / Edge 浏览记录扩展

一个 Manifest V3 构建供 Chrome 和 Edge 共用。记录新访问，通过本机 Native Messaging
接收器保存。协议和数据边界见[浏览记录合同](../browser-history/README.md)。

## macOS 安装

需要 Node 22+。在仓库根构建：

```bash
pnpm --filter @runweave/browser-history build
pnpm --filter @runweave/browser-history-extension build
```

1. 将本目录的 `dist/` 复制到打算长期保留的目录。解包扩展依赖该目录继续存在。
2. Chrome 打开 `chrome://extensions`，Edge 打开 `edge://extensions`，开启开发者模式，
   选择“加载已解压的扩展程序”，选中保存的目录。
3. 从扩展详情复制**该浏览器实际显示的扩展 ID**，分别登记接收器：

```bash
pnpm browser-history native-install --browser chrome --extension-id <Chrome实际ID>
pnpm browser-history native-install --browser edge --extension-id <Edge实际ID>
```

扩展安装后默认记录新访问。点击扩展图标可暂停、查看今日已确认访问数、待发送观察数和
本机保存状态，或“重试保存”。“已确认”只在本机 ACK 后增加；一条访问的多个标题修订
只计一次。计数使用 Asia/Shanghai 当日，原始时间保留 UTC。

无需 Runweave 正在运行；浏览器按需启动本机接收器。安装器复制接收器到
`~/.runweave/browser-history/runtime/`，不会把启动路径留在临时构建目录中。
登记会固定当次 Node 的绝对路径；删除或升级该 Node 后应重新安装接收器。
Chrome 与 Edge 分别登记，不能假设两个实际 ID 相同。更新扩展时覆盖保留目录内容后在
扩展管理页重新加载；更换目录可能改变 ID，此时需按新 ID 重新登记。

首次未连接接收器时，记录会本地暂存并显示原因；达到 4 MiB 后自动暂停。排查顺序：
确认对应浏览器登记成功、ID 一致、Node 路径仍可执行，再点击重试。旧队列保存成功后
手动重新开启记录。暂停不删除记录，也不回填暂停期间的浏览。

`--root <dir>` 可指定日志根；`--home <isolated-home>` 只用于独立浏览器 Profile 验证，
不要把测试 Profile 的登记写入日常浏览器。

## 卸载

先暂停或移除浏览器扩展，再运行对应浏览器的卸载命令：

```bash
pnpm browser-history native-uninstall --browser chrome
pnpm browser-history native-uninstall --browser edge
```

使用过自定义 `--root` / `--home` 时，卸载传入相同值。卸载只移除本接收器登记和可执行文件，
保留采集日志及浏览器原生历史；最后一个浏览器卸载后才移除共用 host 文件。
本功能不提供日志自动删除；需要删除时先暂停所有采集器，再由用户自行处理数据目录。

## 权限

`webNavigation` 观察主框架提交，`tabs` 读取当前页标题与地址，`storage` 保存来源和待发送队列，
`nativeMessaging` 连接固定本机接收器，`alarms` 在 Worker 休眠后重试。
无 history 权限、content script、页面正文采集或外部网络上传；无痕模式不可启用。

## 开发

```bash
pnpm --filter @runweave/browser-history-extension typecheck
pnpm --filter @runweave/browser-history-extension lint
```

真实浏览器验收使用独立 Profile，加载扩展后验证 popup 与本机日志，不能用单独的 Node
协议调用代替 Chrome / Edge 运行证明。
