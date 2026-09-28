# ChatGPT 接入本机 Runweave MCP

适用于个人排查问题、深度调研：ChatGPT 通过 OpenAI Secure MCP Tunnel 调用本机
Runweave MCP，结合代码、Activity、原生 Agent 会话、日志及数据库取得证据。
MCP 沿用运行账号的完整访问能力，SQL 和命令支持写入。工具合同、数据范围及限制见
[MCP 包文档](../../packages/runweave-mcp/README.md)。

```text
ChatGPT 中的 Runweave 应用
  → OpenAI Tunnel
  → 本机 tunnel-client
  → http://127.0.0.1:5099/mcp
  → Runweave Backend / 本机代码、日志、数据库
```

本机只监听 loopback，不需要公网 IP 或端口映射。查询返回的数据会传给 ChatGPT。
以下客户端命令已在 macOS arm64、tunnel-client 0.0.15 验证；其他版本先核对
`tunnel-client help quickstart`。安装来源始终使用官方 latest 页面。

## 已接入过：下次怎么使用

1. 在仓库根目录启动 MCP，保持这个终端运行：

   ```bash
   pnpm --filter @runweave/mcp start --instance stable --cwd "$PWD"
   ```

   首次拉取代码或修改 MCP 后先执行 `pnpm install --frozen-lockfile` 和
   `pnpm --filter @runweave/mcp build`。`--cwd` 是调查用的默认工作目录，可改成其他绝对路径。
   如果 5099 已有服务，先访问 `/health` 核对实例，不要重复启动或直接杀占用进程。

2. 检查已保存的隧道：

   ```bash
   curl -fsS http://127.0.0.1:5099/health
   tunnel-client runtimes status runweave-local --json
   ```

   若未运行，重新执行下文[连接隧道](#4-连接隧道并验证)中的完整 `runtimes connect`
   命令，沿用原 Tunnel ID 和本机 Key 文件，无需创建新隧道或新 Key。

3. 在 ChatGPT 聊天中选择已添加的 **Runweave** 应用，直接提出调查问题。

电脑需要联网并保持唤醒，MCP 与 tunnel-client 都必须运行。客户端的后台管理不等于
开机自启动；本指南没有安装 LaunchAgent，重启电脑后按以上步骤恢复。

## 首次接入

### 1. 准备并启动本地 MCP

需要 Node.js 22、pnpm、Python 3、Git，以及目标 Runweave 实例已有的 rw 登录状态。
在使用 nvm 的终端中先加载 Node 环境，确认 `node`、`pnpm`、`rw` 可用。
rw 的实例和登录规则见 [CLI 入口](../cli/README.md)。

在仓库根目录运行：

```bash
pnpm install --frozen-lockfile
pnpm --filter @runweave/mcp build
pnpm --filter @runweave/mcp start --instance stable --cwd "$PWD"
```

另开一个终端检查 `curl -fsS http://127.0.0.1:5099/health`，预期返回
`service: runweave-research-mcp`、`instance: stable` 和 `/mcp` 地址。
这只能证明本地服务启动；Backend 登录与数据可读性还要通过 `list_sources` 检查。

### 2. 安装官方 tunnel-client

已经能运行 `tunnel-client --version` 时跳过安装。

1. 打开 [官方最新发行页](https://github.com/openai/tunnel-client/releases/latest)。
   macOS 执行 `uname -m`：`arm64` 选 `darwin-arm64.zip`，`x86_64` 选 `darwin-amd64.zip`。
   下载名称为 `tunnel-client-v<版本>-darwin-<架构>.zip` 的完整包及 `SHA256SUMS.txt`。
2. 用 `shasum -a 256 <下载的 ZIP 路径>` 与官方校验表中的同名条目核对，解压到
   `~/.local/share/tunnel-client/<版本>/`。保留包内的 `cloudflared`、manifest 等文件，
   不要只搬走主程序。
3. 将下面的 `<版本>` 替换成解压目录名后执行：

   ```bash
   tunnel_install_dir="$HOME/.local/share/tunnel-client/<版本>"
   chmod +x "$tunnel_install_dir/tunnel-client" "$tunnel_install_dir/cloudflared"
   mkdir -p "$HOME/.local/bin"
   ln -s "$tunnel_install_dir/tunnel-client" "$HOME/.local/bin/tunnel-client"
   export PATH="$HOME/.local/bin:$PATH"
   tunnel-client --version
   tunnel-client help quickstart
   ```

   已有同名命令时先检查其路径，不要直接覆盖；若新终端找不到命令，把上述 PATH 设置
   加到自己的 shell 启动配置。后续使用不需要重新安装。

### 3. 创建隧道并保存运行凭证

在 [Platform Tunnel 设置](https://platform.openai.com/settings/organization/tunnels)
创建或复用隧道，记下 `tunnel_id`，并关联目标 ChatGPT 工作区。
仅关联 Platform organization 不保证 ChatGPT 能看到它。

在 [Platform API Keys](https://platform.openai.com/settings/organization/api-keys)
创建运行用 Key。对应身份需要隧道的 **Read + Use** 权限；创建/修改隧道另需
**Read + Manage**。已有 Tunnel ID 时，下文连接命令无需 Admin Key。

将 Key 保存在仓库外，只供当前用户读取。下面的交互输入不会显示 Key，也不会把 Key
字面值写进 shell 历史；文件已存在时直接复用，不重复执行：

```bash
python3 - <<'PY'
import getpass
import os
from pathlib import Path

directory = Path.home() / ".config/runweave-mcp"
directory.mkdir(parents=True, exist_ok=True, mode=0o700)
key = getpass.getpass("Tunnel runtime API Key: ").strip()
if not key:
    raise SystemExit("Key 不能为空")
fd = os.open(directory / "tunnel-runtime-key", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, "w") as output:
    output.write(key)
print("凭证已保存在本机")
PY
```

不把实际 Key、个人 Tunnel ID 或机器配置提交到仓库。Key 在这里用于隧道认证与转发，
本地 MCP 本身不调用模型 API；这不构成 Tunnel 免费或会员额度归属的承诺，费用以平台条款为准。

### 4. 连接隧道并验证

保持本地 MCP 运行，将 `tunnel_REPLACE_ME` 替换成第 3 步的真实 ID：

```bash
tunnel-client runtimes connect \
  --alias runweave-local \
  --profile runweave-local \
  --tunnel-id tunnel_REPLACE_ME \
  --runtime-api-key "file:$HOME/.config/runweave-mcp/tunnel-runtime-key" \
  --mcp-server-url http://127.0.0.1:5099/mcp \
  --json

tunnel-client doctor --profile runweave-local --explain
tunnel-client runtimes status runweave-local --json
```

`runtimes connect` 由客户端管理后台进程；已有实例时复用。再次连接仍传完整参数：
仅传 alias/profile 会缺少 MCP 目标，省略 `--tunnel-id` 可能进入需要 Admin Key 的创建路径。
此版本将 `--json` 放在子命令参数末尾，不放在 `tunnel-client` 后面。

检查 `process_running`、`healthy`、`ready`，并打开返回的 `ui_url`。
UI 地址使用动态端口，不能固定复制其他机器的端口。
`/health?details=true` 中 `components.control-plane` 的 `last_success` 应有值，
`consecutive_failures` 应为 0；首轮长轮询可能约需 30 秒。
本地 MCP 的启动探测应成功。完整验收仍需下一步的 ChatGPT 实际工具调用。

这些文件保存在本机，迁移机器时重新安装并配置：

| 内容             | 默认位置                                                              |
| ---------------- | --------------------------------------------------------------------- |
| 运行 Key         | `~/.config/runweave-mcp/tunnel-runtime-key`                           |
| 连接 profile     | `~/.config/tunnel-client/runweave-local.yaml`（引用 Key 文件）        |
| macOS 客户端日志 | `~/Library/Application Support/tunnel-client/logs/runweave-local.log` |

### 5. 在 ChatGPT 创建 MCP 应用

开启账号可用的开发者模式，进入 [ChatGPT 插件页](https://chatgpt.com/plugins)，
打开 **Create MCP App**。创建时保持隧道运行，以便发现工具。

| 字段                     | 填写方式                                              |
| ------------------------ | ----------------------------------------------------- |
| 名称                     | `Runweave`                                            |
| Description              | `结合本地代码、日志和运行数据排查问题`                |
| 连接                     | 选择 **Tunnel**                                       |
| Tunnel                   | 选择已有隧道，或粘贴 `tunnel_id`                      |
| Authentication（若显示） | **No authentication / 无认证**，当前 MCP 不实现 OAuth |
| Choose icon              | 可选，可留空                                          |
| Upload plugin archive    | **无需使用**，这个表单可以直接创建 MCP 应用           |

核对后勾选 **I understand and want to continue**，点击 **创建**。
API Key 已配置在本机客户端，不填到这个表单。
不要把本机 `/health`、`/ui` 或 OpenAI 隧道地址填进 Server URL；此路径使用 Tunnel ID。
界面可能随版本调整，入口与工作区可用性以实际账号为准。

### 6. 用一次真实查询验收

在聊天中选中 Runweave，发送：

> 调用 list_sources，说明数据源、项目和环境的可用状态。再读取最近 24 小时的
> Activity，结合相关日志和本地代码分析主要异常，给出证据、查询范围和建议，暂不修改。

确认模型实际调用工具，返回目标实例的项目/事件，并与一条本地已知记录核对。
应用创建成功、客户端 ready、真实数据查询成功是三个独立结果。
更完整的验收入口见 [Research MCP 测试计划](../testing/architecture/research-mcp.testplan.yaml)。

## 停止、恢复与排障

```bash
tunnel-client runtimes stop runweave-local
```

停止隧道只中断后续转发，已送达 MCP 的命令不会自动取消；需要时按 commandId 调用
`run_command` 的 cancel。MCP 前台终端按 Ctrl-C 会关闭服务并取消它管理的命令。
恢复时先启动 MCP，再执行第 4 节的完整连接命令。MCP 重启后旧证据 ID 失效，重新查询。

| 现象                                     | 检查方式                                                                                          |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 本机 health 连接失败 / 5099 被占用       | 检查 MCP 终端、Node 环境和 `/health` 返回的实例；不盲目重启其他服务                               |
| 提示缺少 OPENAI_ADMIN_KEY                | 连接已有隧道时补上 `--tunnel-id` 与 `--runtime-api-key`，不要为此创建管理员 Key                   |
| 401 / 403、Tunnel 不可见                 | 核对 Key、Platform organization、Read + Use 权限及 ChatGPT workspace 关联                         |
| 出现 OAuth 要求                          | 应用选无认证；当前 MCP 不提供 OAuth。doctor 的 metadata not advertised/404 是预期结果             |
| ready 为 true，但 ChatGPT 调用失败       | 查看控制面最后成功轮询和日志，再核对所选应用、隧道与 MCP 目标；ready 不代表已完成数据调查         |
| list_sources 的 Backend 来源不可用       | 检查目标实例是否启动、rw 登录/profile；本机文件与 Backend 来源分别判断                            |
| `/health/mcp` 为 unknown，但启动探测成功 | 0.0.15 对 HTTP transport 的该详细探测可能显示 unsupported_transport；以启动握手及实际调用结果核实 |
| 引用网页在其他机器打不开                 | localhost 引用页只供同机浏览器使用；模型通过 fetch 读取正文，Tunnel 不公开这些网页                |

依据：[官方 Secure MCP Tunnel 文档](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
与安装版本的 `tunnel-client help quickstart`、`runtimes connect --help`。
