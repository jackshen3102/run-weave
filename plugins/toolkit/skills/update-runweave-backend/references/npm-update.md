# NPM 部署的机器升级

适用于已由 `rw server` 管理的 Linux Stable。通用合同见目标仓库的 `docs/cli/server-cli.md`；
已知机器的路径约定见 `docs/deployment/npm-server-operations.md`。使用远端已安装 CLI 时先核对帮助，
不要求目标机器安装源码仓库。旧源码部署先按仓库 `docs/deployment/backend-standalone.md` 一次性迁移；不再提供源码日常升级。

## 固定目标与恢复材料

- 通过独立 SSH 在目标机器确认服务用户、HOME、Node、实例、配置根、npm prefix 和实际 rw wrapper。
  查询 `server status --json`、`server doctor --json`、CLI 包内 package.json 与 systemd 状态。
  CLI 的源码版本与 npm 版本可能不同，不能只看 `rw version` 判断 npm 包版本。
- 用户说“升级后台到最新版”时，默认核对独立 CLI 和 Server 两个 npm 包。
  用户只要求其中一个时保持范围；版本已一致且运行正常时不重新安装或重启。
- 将目标 channel 解析成两个精确版本并记录。优先使用发布流程交接的已验证版本；
  默认 latest，不能因为 next 编号较大就自动选 next。确认对应平台包、Node ABI 与管理协议兼容。
- 保存配置、unit/drop-in、安装记录、发布指针、现有 npm 包版本及可恢复产物，数据库使用一致性备份。
  对比基线包括项目/终端 ID、tmux socket/pane/任务 PID。保留密钥和 Agent 登录态，不输出凭据。
- 向用户简述旧新版本、机器和短暂连接中断，已有升级授权时继续。服务原本停用则保持停用。
  普通 tmux Agent 可保活，但正在调用 HTTP/WS 的操作仍可能受影响。

## 升级顺序

1. CLI 若需要更新，在原 npm prefix、原服务 HOME 与 Node PATH 下安装核验过的精确版本。
   采用该机器已验证的 sudo/用户方式；不能用 SSH 登录用户的裸 `npm install -g` 改装到另一个 prefix。
   不覆盖实例 wrapper。读取实际包版本和 wrapper 指向，执行 CLI 帮助及 `server status` 确认管理能力可用。
2. 只有 CLI 管理能力确认可用后，执行同一实例入口的
   `rw server update --version <精确Server版本>`。由该命令执行下载/原生与兼容预检、维护租约、
   停止、安装、切换、原运行模式重启与健康检查。无需重复 init、service install 或手动改 current。
3. 若出现 `SERVER_TASKS_ACTIVE`，列明受影响执行并等待后重查；不默认 force。
   数据不兼容、原生预检失败或安装归属不明时先解决，不停止旧服务冒险继续。
   `--force` 不能解除数据与原生兼容限制。
4. 安装或更新返回不确定时重新读取实际状态、包版本、发布指针和 update receipt，
   不凭旧日志重放整套操作。CLI 成功、Server 失败要分别报告，不称整套升级成功。

CLI 与 Server 的升级不是跨包/跨数据库原子事务；服务端更新失败也不会自动回滚。
CLI 切换后若管理能力失效，确认恢复条件后可在原 prefix 重装保存的旧 CLI；
Server 恢复使用兼容版本的 `server update --version`。不能自动恢复旧数据库覆盖升级后的写入，
也不因 npm 更新失败重新启动遗留源码 unit 与新服务争抢实例。

## 真实验证与交付

- CLI npm 版本、Server installed/active/running 版本对应目标，Backend/App Server PID 与 supervisor 一致。
- 对本应运行的服务检查健康、重启次数、日志和持久自启；本来停用的服务检查已安装版本并保留停用状态。
- 通过合法现有 profile 或私有凭据输入完成认证业务请求，核对项目/终端及 tmux 保活。
  验证登录时创建的临时 session 应注销，不泄露 token 或重置用户密码。
- 若用户报告某个入口登录失败，在那个入口复测前保持问题未解决；CLI 鉴权和健康 200 不等于用户 UI 成功。
- 独立 Hub/MCP/隧道按原范围单独核对，不因 Server 包更新顺带重启其他产品。
- 不默认整机重启。分别报告程序版本、运行验证、自启配置与真实重启验收，以及未完成项和恢复位置。

交付应让用户看懂“哪台机器的 CLI 从什么版本到什么版本，Server 从什么版本到什么版本，
服务与登录是否可用，现有任务是否保留”。仅需要升级机器时，不创建新的 npm 发行版。
