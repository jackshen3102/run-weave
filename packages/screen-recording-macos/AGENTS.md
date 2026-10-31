# ScreenJournal

独立 macOS 15+ Swift App 与只读诊断工具。采集与本地存储保持独立，不依赖 Runweave、RemoteDesk 或模型。
二期在唯一 writer 内提供同用户 Unix socket 只读服务及 Mac 原生回放；iOS 代码留在 app-ios。

- 身份固定为 `com.runweave.screen-journal`；关闭设置窗口继续运行，明确退出保存停止状态。
- 构建入口 `./build.sh` 只构建，不安装、授权或采集。XcodeGen 生成物不提交。
- `CaptureCoordinator` 的单 worker 串行调用 `StorageEngine`；UI 动作先失效采集代际。
  禁止绕过 `CapturePermit` 直接提交生产帧，禁止并行启动替代 writer。
- 数据路径通过 `StorePaths` 校验，独占锁先于数据库和配置写入。未知 schema 拒绝写入。
- ready 是完成解码核对、fsync、原子移动及索引提交的段；writing 不是可恢复承诺。
- 真实采集通过原生控件启停。破坏性验证仅使用 Debug 显式隔离目录；不操作正式资料或 TCC 数据库。
- 运行、诊断、资源测量与验收边界见 [README](README.md)。不新增单元测试。

- 在线读取只能通过持锁 owner 获取许可；取消请求不代表解码已退出，许可实际释放后才能删除媒体。
