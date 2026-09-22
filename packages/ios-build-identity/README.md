# iOS 源码构建身份

用于确认手机安装的是哪份源码。两个 App 共用同一身份格式和按需导出入口。

共享 Xcode scheme 的构建开始阶段记录输入，结束阶段复核并在签名前写入
`BuildIdentity.json`。输入包含 App、本地 Swift 依赖和生成器；构建中输入变化则失败。
每次构建生成独立 `buildId`；`sourceRevision` 与 `inputsSHA256` 分别表示 Git 提交和实际输入。
未提交源码以 `modified` 标记；缺 Git 时提交未知，不能从指纹还原源码。

手机“构建信息”仅在点击导出时读取安装包资源，通过系统分享提供原文件；缺失或损坏时明确报错。
无运行日志、账户或后端信息，无启动初始化、网络请求、采集定时器或持续写盘。
分享结束清理本次临时文件，其他 App 数据不参与。

电脑记录位于 `.runweave/ios-builds/<appId>/<buildId>/`。
`manifest.json` 记录构建输入及复核阶段；构建成功、安装回执和运行观察分别判定，不能互相替代。
直接 Xcode 构建只有输入复核证据，不据此宣称手机已安装或运行。

```bash
python3 -B scripts/ios-build/cli.py lookup --build-id <手机导出的buildId>
python3 -B scripts/ios-build/cli.py inspect --app-path <App产物路径>
python3 -B scripts/ios-build/cli.py record-install --app-path <App产物路径> --receipt <devicectl的JSON回执> --device <回执的deviceIdentifier>
```

`lookup` 比较当前源码指纹与历史构建；本机记录不存在时明确失败。
验收合同：[源码构建身份](../../docs/testing/app/ios-build-identity.testplan.yaml)。
