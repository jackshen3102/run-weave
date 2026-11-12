export const installCommand =
  "npm install -g @runweave/cli@latest @runweave/server@latest";
export const windowsInstallCommand =
  "npm.cmd install -g @runweave/cli@latest @runweave/server@latest";
export const startCommands =
  "rw server init &&\nrw server doctor --json &&\nrw server start";
export const windowsStartCommands =
  "rw.cmd server init\nif ($LASTEXITCODE -eq 0) {\n  rw.cmd server doctor --json\n  if ($LASTEXITCODE -eq 0) { rw.cmd server start }\n}";
export const agentPrompt = `请帮我在这台机器上安装并开始使用 Runweave。先阅读下面的 Agent 使用指南，再执行当前环境需要的步骤。先检查已有安装与运行状态，复用现有配置和数据，不覆盖、不重置。安装 CLI 和 Server 后，检查环境，协助我完成账号初始化，在本机启动并验证 Web 可用，再指导我创建第一个项目与终端。账号密码由我在本机安全输入，不写入聊天或脚本。Agent CLI 的安装和登录单独核对；手机和远程连接另行配置，完成安装不代表已远程可用。`;
export const agentGuide = `# Runweave: installation and first task / AI Agent 使用指南

目标：在用户指定机器上安装 Runweave，启动本机 Web，创建第一个项目和终端。
范围：本机使用优先。不要默认开启公网访问、安装系统服务、修改现有 Agent 插件或升级已运行的实例。

Windows 上以下所有 rw 命令均使用 rw.cmd 入口，避免 PowerShell 的 ps1 执行策略。

1. 发现现状
- 确认操作系统、架构、Node.js 22.x 和 npm。Mac 仅 Apple Silicon；Linux glibc x64/arm64；Windows x64。
- 没有 Node 22 时指引用户选择 Node 22：https://nodejs.org/en/download 。不要将默认最新 Node 误当成 Server 兼容版本。
- 如 rw 已存在：rw version --json；rw server status --json；rw auth status --json。
- 如实例正在运行，复用它，不重复 init/start 或升级。不要修改无关配置、删除数据、终止用户终端。

2. 安装组件（只有缺失时）
macOS/Linux: ${installCommand}
Windows PowerShell: ${windowsInstallCommand}
全局 npm 目录须可写；遇到权限或系统依赖问题说明原因，不自动 sudo 或修改 PowerShell 执行策略。
安装组件不等于启动服务，也不代表 Agent CLI 已安装或登录。

3. 初始化与启动（没有可用实例时）
macOS/Linux:
${startCommands}
Windows:
${windowsStartCommands}
init 交互询问账号并只展示一次生成密码。由用户在本机完成交互；不收集或回显密码。
非交互 init 仅使用用户已准备的 --auth-file 私有绝对路径，JSON 包含 username 和至少16字符 password；权限必须仅当前用户可读。不能生成固定默认密码，不能把凭据写入仓库。
doctor 的服务、终端和 Agent 登录结果分别核对，失败时按诊断处理，不直接继续。
server start 是前台服务，保持所在终端打开；自动化工具应使用可保留的执行会话，不让命令超时杀掉服务。不要在同一前台进程里继续排后续命令。

4. 验证与首次使用
在另一终端执行 rw server status --json，确认运行与健康；请求 http://127.0.0.1:5001/ 确认 Web 可达。
用户用 init 配置的账号登录 Web，选择实际项目目录，创建终端，运行自己已安装且已登录的 codex、claude 或其他 CLI。
若需要 rw 管理终端，执行 rw auth login --base-url http://127.0.0.1:5001 --username 用户实际账号，并在本机交互输入密码。不要使用 --password 参数保存或暴露密码。
已鉴权后：rw health --json；rw project ensure --name 用户项目名 --path 用户指定绝对路径 --json。
从 JSON 获取 projectId，执行 rw terminal create --project-id 该ID --cwd 同一真实目录 --json。
从 JSON 获取 terminalSessionId，经用户确定要运行的命令后，rw terminal send 该ID --text 已确认命令 --mode line --json。
rw terminal snapshot 该ID --tail 120 --plain；rw terminal handoff 该ID --tail 120 --json。
send 成功只代表输入被接受，不等于任务成功完成。读取真实输出与结果再判断。

5. 手机与多机器
127.0.0.1 只属于本机，不能直接填到手机当成电脑地址。手机需要已安装 Runweave iOS App 和受保护且可达的电脑入口；同一账号登录后打开对应项目与终端。
每个后端独立安装、初始化并确认访问地址，再在客户端添加连接。先配置明确的受控网络入口，不默认修改监听到0.0.0.0、关闭防火墙或公开端口。
iOS 安装说明：https://github.com/jackshen3102/run-weave/blob/main/packages/app-ios/README.md
网络说明：https://github.com/jackshen3102/run-weave/blob/main/docs/architecture/network-topology.md

6. 交付
分别报告组件安装、服务健康、Web登录、终端输入输出、Agent登录和手机连接；未完成项准确说明。不要把代码、截图、安装或输入回执等同于业务任务验收。

权威入口：
https://github.com/jackshen3102/run-weave/blob/main/docs/cli/server-cli.md
https://github.com/jackshen3102/run-weave/blob/main/docs/cli/terminal-cli.md
`;
