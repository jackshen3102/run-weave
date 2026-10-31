# Runweave Server

通过 NPM 安装的独立 Runweave 后台，包含 Backend、App Server 和网页；独立的 `@runweave/cli` 提供唯一的 rw 命令。
安装机器需要 Node 22；终端需要 tmux，Git 和 Agent CLI 根据所用功能单独安装及认证。
不需要 Electron、项目源码或编译工具链。当前支持目标为 macOS arm64/x64、Linux glibc arm64/x64；
每个目标必须先经过实际发布构建与安装验证。Windows、musl 和其他 Node ABI 不在第一阶段范围内。

```sh
npm install -g @runweave/cli @runweave/server
rw server init
rw server doctor --json
rw server start
```

交互初始化生成强密码，显示一次，请保存。非交互初始化使用仅当前用户可读的绝对路径 JSON 文件，
内容为 username、password（至少 16 字符）：

```sh
rw server init --auth-file /absolute/private-auth.json --host 0.0.0.0 --port 5001
```

独立服务使用 Activity 目录中仅当前服务用户可读的文件密钥，避免依赖 macOS 登录 Keychain；已有数据缺少原密钥时拒绝重建。
初始化不会覆盖已有配置，默认监听 127.0.0.1:5001。打开该地址可使用网页；桌面端通过现有连接功能接入。
远程访问需自行配置网络与 HTTPS/WSS。不包含 Electron 内嵌 Browser、原生远控 Host 或跨网中继。

```sh
rw server service install       # 安装系统服务、启用开机启动并启动；需要管理员权限
rw server status --json
rw server logs --follow
rw server restart
rw server stop
rw server start
rw server update
rw server update --version 0.1.0
rw server update --force
rw server service uninstall     # 注销并停止，保留配置与数据
```

后台用 systemd 或 launchd 分别托管两个组件，异常重启限速；前台错误会退出。
普通 tmux 任务在重启期间保留，连接暂断；依赖后台 API 的请求仍可能失败。
有服务托管执行时更新和重启默认拒绝，force 明确取消这些执行后继续。
排队或已持久化等待记录本身不会阻挡更新。更新失败保留日志和数据，不自动回退。
指定旧版本只允许数据合同兼容的版本，第一阶段使用保守的存储源码指纹校验，不执行逆向数据迁移。

运行文件放在配置目录下的 server/releases，数据和凭据使用现有配置路径，均在 npm 包目录之外。
直接 npm 全局安装新版本不会自动替换运行进程，使用 rw server update 激活。
Server 更新不会替换 CLI 或全局 rw。更新中断时查看 server/update.json，必要时重新安装分发包，再用 rw server update 恢复。
全局 npm 前缀需要当前用户可写，更新不会自动提升 npm 权限。

服务管理命令适用于一台机器一个 Stable 服务。安装前台与系统托管不得并存；已有桌面后台的共存/迁移暂不支持。

源码构建产物与 NPM 使用相同的激活路径：

```sh
pnpm server:build
rw server update --server-package /absolute/repo/.runtime-artifacts/server/package
```

首次使用源码产物时，可在 `rw server init` 指定相同的 `--server-package`。
CLI 先查私有安装记录，再查同一全局前缀中的 Server 包，最后查询 npm 全局目录；不会按当前工作目录猜测源码。
Server 不注册 rw，也不携带 CLI；两个包通过 managementApiVersion=1 的管理合同配合，可独立升级。
