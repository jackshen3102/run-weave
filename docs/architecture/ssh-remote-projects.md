# SSH 远程项目

macOS 桌面可同时保存本地 Backend、普通 Backend URL 和多条 SSH 连接。每个远端项目由
`connectionId + remoteProjectId + remoteDirectory` 标识；同一台 Linux 的多个项目复用
一条 SSH 连接。终端、Agent、文件和 Git 操作仍由该 Linux Backend 执行，桌面只负责
聚合项目与终端元数据、展示状态、连接归属和本地 Browser。

## 连接与身份

- Electron 使用系统 `ssh` 和现有 SSH 配置，以 `-L` 建立 Backend 隧道。首次连接只
  检查 `/health`；用户仍须使用该 Backend 自己的账号登录。登录后 `/api/remote/capabilities`
  返回协议版本、数据安装身份、运行实例身份和 Backend 功能。
- `connectionId` 是桌面持久身份；本地端口随 SSH 重建而变，不能当作项目或缓存身份。
  请求缓存以连接和 generation 分域，预览状态和未保存草稿以连接、项目和文件分域。
  同一个安装身份若经两个 SSH 别名重复加入，桌面提示复用原连接。
- 每条后台连接只订阅终端元数据事件和 Attention 快照，不附着所有终端屏幕输出。
  断线时保留最后观察时间，并将旧终端数标作历史信息。远端 tmux 不由桌面断开操作结束。
- Attention 从各连接分别读取，入口带连接身份。Terminal 工作区可以跨连接跳到
  对应项目和终端；新出现的 Attention 按连接与事件身份去重，在桌面失焦时发送系统通知，
  点击通知跳到所属连接的项目和终端。全局其它页面仍使用当前连接。

## 开发服务与 Browser

- 受管 Workspace Service 必须先从所属 Backend 重取服务快照，验证项目、服务身份和
  `.localhost` 主机名，再把端口映射到该连接的 `-L` 本地端口。手动开发进程须显式输入
  远端端口。两个 Linux 的同号端口各有独立本地入口；HTTP 和 WebSocket 均由 SSH 传输。
- 本地 Browser 的三个 Profile、工作组、Cookie 和代理配置维持原有语义。远端 Browser
  经 SSH `-R` 接到 Electron 的短期认证网关；Backend 只向拥有有效终端身份的 CLI
  发放一次性 60 秒票据。网关校验连接、generation、项目、终端、Profile 和获准复用的
  工作组，并将归因加上连接身份。没有显式认可的工作组不可由远端指定。
- 停止桌面或 SSH 隧道会撤销 Browser 通道。连接恢复后 Agent 必须重新 resolve 并观察
  页面；未知结果的点击、输入和保存不会自动重放。Browser 失败不代表 tmux 终端结束。

## 运行前提与限制

连接目标须已有可用 Backend。安装依赖、部署和源码更新由 Agent 根据服务器实际环境
引导或执行，操作要点见 [独立 Backend 部署](../deployment/backend-standalone.md#通过-agent-维护远端环境)。
桌面负责连接、认证、能力检查与错误展示，不安装或升级远端服务。

SSH 接入不探测或要求安装任何 Agent，也不检查模型配置和 Agent 登录状态。
远端终端可运行任意命令；只有用户选择运行某个 Agent 时，才需要自行准备对应工具与配置。
已有终端可跨桌面和 Backend 重启恢复，前提是远端 tmux socket 与数据目录保留。
Backend 自己启动的 Workspace Service 在 Backend 重启时会回收，不能按 tmux 的保活
合同推断服务仍在运行。普通 localhost 转发不保证硬编码其它主机名、严格 Origin 或
生产域名语义的应用透明工作。

连接页的手动开发端口转发固定使用同一个本地与远端端口（例如 `127.0.0.1:8080`
转发到远端 `127.0.0.1:8080`），不随机分配、自动避让或维护异端口映射。
本地端口被占用时直接失败，由用户调整服务端口或释放占用。端口和网页路径按连接保存；
SSH 断开会结束转发，重连后再次点击转发仍使用原端口。

实现入口：[共享合同](../../packages/shared/src/remote/index.ts)、
[Electron SSH 管理](../../electron/src/remote/ssh-connections.ts)、
[Backend 能力与 Browser 绑定](../../backend/src/remote/routes.ts)、
[桌面工作区聚合](../../frontend/src/features/connection/workspace-overview.tsx)。
