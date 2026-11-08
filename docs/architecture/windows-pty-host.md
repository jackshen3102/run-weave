# Windows 独立 PTY Host

Windows standalone npm Server 从 Server 0.1.7 / CLI 0.10.8 候选起，将 ConPTY 从 Backend 迁到独立的本机 Host。
macOS/Linux 默认继续使用原来的 tmux 或直接 PTY。Host 不依赖 Backend 业务代码，共享线协议在
`packages/shared/src/terminal/pty-host.ts`，Node 实现在 `packages/pty-host/`。

## 所有权与发现

外层 `rw server start` 管理 Backend/App Server，并启动或发现独立 Host。Host 使用 detached Node 进程、
独立日志和无父进程 IPC 的启动方式；Backend、网页和管理连接退出均不关闭终端。用户显式删除终端才发送 close。
原来正在运行的直接 PTY 不能转移到另一个进程，首次迁移允许中断一次，见 [CLI 迁移步骤](../cli/server-cli.md)。

Host 根目录为 `<configRoot>/runtime/pty-host`，私有记录包含管道、进程创建身份、Host 随机实例 ID、
稳定 gateway 地址和不可变发行目录。Windows 检查实际 DACL，POSIX 检查拥有者和模式。
命名管道名由规范配置路径生成；凭据只放私有文件，不进入命令行或公开 DTO。
每次 RPC 同时验证私有 token 和 Host 实例 ID，hello 再核对配置范围。
内核文件锁保证同一实例只有一个 Host；发现记录与 PID 创建身份不符时拒绝接管，不能杀掉身份不明的进程。

每个会话持久保存 `hostInstanceId + sessionInstanceId`。Backend 在发送 create 前先保存绑定；
重启后先与 Host 对账，再连接原会话。找不到原绑定或 Host 失联时报告错误，不启动同名替代 shell。
新的 Backend 通过比较并交换取得 writer generation；旧代不能输入、resize 或 close。
只读快照、输出和操作查询不取得写权限。

Backend 的 registry dispose 只释放托管连接；显式结束终端发送 close 并等待退出。
Host 本身崩溃、用户注销或 Windows 重启无法保留原进程，不自动 resume Agent 冒充原终端。
Windows profile 锁另记录进程创建身份，异常退出后结合 HasExited 和创建身份判断旧锁；无法探测时保留锁。

## 输入与画面

结构化输入携带 operationId、单调序号和完整步骤。文本、延时、Enter 由 Host 排队执行；
Backend 在中间退出不会丢掉后续回车。line 沿用 200 ms 后单独发送 Enter 的行为，原始键盘输入不自动加回车。
确认 written 只表示字节已写入 PTY，不代表 Agent 已完成执行。

同一 ID 和内容重试返回原操作；不同内容或冲突序号拒绝。详细记录保留最多 10,000 条、24 小时；
窗口外保留结构化 ID 的防重摘要，原始键盘操作使用可推导序号的 ID。过期操作返回 expired，不重新写入。
每个会话最多接管 65,536 个结构化 ID，达到上限明确拒绝，需结束终端后新建。
队列上限为 128 个操作、4 MiB，单操作最多 1 MiB、64 步和 5 秒延时。

Host 保存 60 秒 / 512 KiB 输出环及 headless 当前屏幕。Backend 使用同一个流 ID 和游标读取，
异步取快照期间暂存 live 帧，并按已回放边界去重。重放窗口外走当前快照，不能声称完整历史。
慢管道断开订阅，不关闭 PTY。屏幕镜像失败只降低恢复能力；后续快照清屏并明确显示恢复不可用提示，原进程继续工作。
每实例最多 64 个运行终端、保留 256 个运行时；回收旧的 exited 运行时不会复用旧会话身份。

## 稳定 Hook 入口

活着的子进程继承 Host 生命周期内固定的 loopback gateway，而非某次 App Server 的临时地址。
每会话使用单独 token；Origin、会话/项目范围、路由和请求体大小受限。Backend 完成 App Server 发现后，
把新上游地址和凭据发布给 Host，活着的 Agent 环境无需修改。

App Server `/events` 先带 dedupeKey 写入私有 outbox，fsync 后返回 202，再按接收顺序补投；
上游事件中心负责去重。outbox 最多 16 MiB / 4096 个文件。上游拒绝的无效事件隔离保留，
后续事件继续投递；容量耗尽或拒绝事件留下持久 incomplete 标记，`host status` 显示该状态。
直接 Backend 兼容回调只做即时转发；Backend 不可用时返回 503，不重放任意有副作用的 API。
Host 维护时取消上游请求并停止排空，不能因历史积压阻止 Host 停止。

## 升级接管与维护

Windows 的 `rw server update` 向现有外层管理进程提交请求。管理进程私有持久回执写入并 fsync 后才确认 accepted；
发起 CLI/Agent 退出不会取消执行。同 requestId 和相同目标返回原事务，不同目标冲突；另一个并发事务报告 busy。
阶段回执是 `server/update.json`，请求回执是 `server/updates/<request-id>.json`。
管理进程异常退出后，未完成请求标记 interrupted，先核对实际配置与发行指针，不能把缺少响应理解为未执行。

事务先固定 npm 精确版本，校验清单、ABI、数据/配置和 Host 协议，再取得现有维护租约。
切换期间冻结新终端和新 writer 接管，已接管输入继续完成；Backend/App Server 停止不停止 Host。
激活后解除冻结、启动组件、切换上游、对账，并核对 Host/会话/shell PID 未改变。
`--force` 不绕过身份、协议或数据兼容检查。兼容失败发生在停止旧组件之前。

Windows 使用 `active-release.json`，内容是相对 releases 路径、发行清单 SHA-256 和事务标识；
统一读取器验证真实路径和摘要后使用。通过 fsync 临时文件、rename 原子切换，不替换正在使用的 junction。
旧 `current` 只作为首次迁移读取来源；POSIX 保持原 symlink 合同。
激活或配置已提交后的失败不自动降级数据库；源摘要和指针均未变化时才尝试恢复原组件。

普通更新不替换全局 CLI，也不更新正在运行的兼容 Host。Host bundle 与原生 DLL 保留在不可变旧发行目录。
`rw server host status` 分别显示运行和已安装发行目录；`host stop`、`host update` 有活跃终端时拒绝。
Windows 系统服务、Host 自身热更新、tmux 分屏和 Fork/Recover 不在当前范围。

## 验证边界

真实进程入口：`node scripts/verify/server/pty-host.mjs`；真实 npm tarball、HTTP、WebSocket、
PowerShell 及升级接管入口：`node scripts/verify/server/registry.mjs --local`。
后者通过隔离 registry 的另一个精确版本测试，原 PTY 子进程持续计数，接管后杀掉发起更新的 CLI。
macOS/Linux 继续原安装、自更新验收，发布只使用 next 测试通道。

完整验收合同见 [Host 运行时](../testing/terminal/windows-pty-host.testplan.yaml)和
[Windows 更新](../testing/platform/windows-pty-host-upgrade.testplan.yaml)。
CI 计数器不是 Traex 对话，也不是浏览器 UI 或手机验收；真实 Windows Traex 的 PID、thread 与界面连续性需单独取证。
