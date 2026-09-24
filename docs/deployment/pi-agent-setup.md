# Pi 环境初始化

供人或 Agent 在新的 macOS / Linux 服务器上安装 Pi，并恢复 `pi-web-access` 搜索能力。
扩展按用户全局安装，供多个项目共用；本仓库保存安装约定，不保存第三方扩展源码。

## 交给 Agent 的一句话

> 按 `docs/deployment/pi-agent-setup.md` 初始化这台机器的 Pi：检查已有环境，只补齐缺失项，
> 全局安装 pi-web-access，使用 Codex 登录，执行真实搜索验证。保留已有配置和扩展；
> 最后报告版本、安装位置、登录状态及搜索结果。需要我完成网页登录时告诉我。

没有仓库时，也可以把本文件单独交给 Agent；以下命令不依赖 Runweave 项目。

## 安装约定

| 项目       | 约定                                                             |
| ---------- | ---------------------------------------------------------------- |
| Pi CLI     | npm 包 `@earendil-works/pi-coding-agent`，当前用户的全局工具     |
| 搜索扩展   | `npm:pi-web-access`，使用 `pi install` 管理                      |
| 模型提供方 | `openai-codex`；新环境默认模型使用 `gpt-6-astra`，需确认账户可用 |
| Pi 配置    | 默认 `~/.pi/agent/settings.json`；只合并所需字段，不覆盖整个文件 |
| 扩展目录   | 默认 `~/.pi/agent/npm/node_modules/<包名>`                       |
| 搜索配置   | 默认 `~/.pi/agent/web-search.json`，没有自定义需求时无需创建     |

设置过 `PI_CODING_AGENT_DIR` 时，以实际配置目录为准。使用将来运行 Pi 的同一用户安装，
避免把扩展装到 root 的配置目录。凭据在目标机器登录生成，不随仓库提交或打印到日志。

## 1. 检查并安装

先运行 `node --version`、`npm --version`、`command -v pi`。已有 Pi 时，再运行
`pi --version` 和 `pi list`；已安装且可用的组件保留，不因重复初始化自动升级或降级。

基线 Pi 0.85.1 要求 Node.js >= 22.19.0。安装其他版本前用以下命令确认其 Node 要求：

```bash
npm view @earendil-works/pi-coding-agent engines --json
```

Node 不满足要求时，通过服务器已有的 Node 版本管理器补齐。只在 Pi 缺失时安装 CLI：

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
pi --version
```

只在搜索扩展缺失时安装：

```bash
pi install npm:pi-web-access
pi list
```

不加 `-l`：该参数会改为项目级安装。`pi list` 应在 `User packages` 下列出
`npm:pi-web-access`（或其固定版本）及安装路径。

以上命令为新环境安装当时的 npm 版本。需要复现已验证组合时，可在缺失组件的安装命令中
分别使用 `@earendil-works/pi-coding-agent@0.85.1` 和 `npm:pi-web-access@0.29.0`。
这组版本已于 2026-09-12 在 macOS 完成真实搜索验证。其他服务器仍须完成下述验证，
不继承本机通过结论。

如本机 npm 镜像下载超时，可仅对本次公开包安装使用
`npm_config_registry=https://registry.npmjs.org pi install npm:pi-web-access`，
不为安装扩展改写全局 npm 镜像。

## 2. 登录和默认模型

已有登录先检查，不输出凭据：

```bash
pi auth check --provider openai-codex --model gpt-6-astra --json
```

缺少登录时启动 `pi`，输入 `/login`，选择 OpenAI / Codex，并由用户完成授权。
SSH 环境按 Pi 当次显示的链接和回调提示完成登录。安装成功不代表登录已完成。

新环境在 `/model` 里选择 `openai-codex/gpt-6-astra`，按 Ctrl+S 保存启动默认值。
Agent 也可仅合并 `defaultProvider: "openai-codex"` 和 `defaultModel: "gpt-6-astra"`
到用户配置，保留其他字段。已有默认模型则保留；基线模型不可用时报告原因，由用户选替代模型。

`pi-web-access` 可以复用 Pi 的 Codex 登录进行 OpenAI 搜索，无需另配搜索 API Key。
如使用第三方模型网关，不能据此推定网关支持托管搜索，需单独检查扩展的路由配置。

## 3. 无界面服务器与加载

安装后重新启动 Pi，或在运行中的 Pi 输入 `/reload`。
无界面服务器在 Pi 内执行 `/curator off`，关闭搜索结果的浏览器审核流程；该选项持久化到
搜索配置。单次工具调用也可传 `workflow: "none"`，下述验证使用这一方式。

## 4. 真实搜索验证

登录就绪后运行下面的独立请求。它只开放搜索工具，不保存 Pi 会话、不加载项目指令；
扩展自身仍可能缓存搜索结果。

```bash
pi --provider openai-codex --model gpt-6-astra \
  --no-session --no-context-files --no-skills --no-prompt-templates --no-approve \
  --tools web_search --mode json -p \
  'Call web_search exactly once with query "Pi coding agent official documentation", provider "openai", workflow "none", numResults 2. Return one source URL and whether the search succeeded. If it fails, report the error and stop.'
```

验收必须同时满足：

- `pi list` 能找到用户级扩展，启动没有扩展加载错误。
- JSON 事件中有真实的 `web_search` 调用，参数包含 `provider: "openai"`。
- 工具结果 `isError` 为 `false`，`successfulQueries` 为 1，且包含来源 URL。

不能只以模型最后一句“搜索成功”为依据。失败时区分扩展加载、模型登录、网络连接或搜索
服务错误，报告实际错误；其他提供方搜索成功也不能算作 Codex 搜索路径通过。

交付时报告 Pi 和扩展版本、`pi list` 的安装路径、登录检查结果及搜索来源。
扩展版本可从上述安装路径中的 `package.json` 读取；无需输出整份配置或凭据。

## 更新与维护

需要升级时分别执行，再重跑搜索验证：

```bash
pi update
pi update npm:pi-web-access
```

固定版本的包不会随常规包更新升级；需要时用 `pi install npm:pi-web-access@目标版本`
显式切换。卸载扩展使用 `pi remove npm:pi-web-access`；若安装时固定了版本，使用
`pi list` 显示的完整来源。新增常用扩展时维护本文的安装约定及验证步骤。

上游参考：[Pi 快速开始](https://pi.dev/docs/latest/quickstart)、
[Pi 包管理](https://pi.dev/docs/latest/packages)、
[pi-web-access](https://github.com/nicobailon/pi-web-access)。
