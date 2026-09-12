# Pi 环境初始化

供人或 Agent 在新的 macOS / Linux 服务器上安装 Pi，并恢复 `pi-web-access` 搜索和
`pi-subagents` 只读调研、并行评审能力。
扩展按用户全局安装，供多个项目共用；本仓库保存安装约定，不保存第三方扩展源码。

## 交给 Agent 的一句话

> 按 `docs/deployment/pi-agent-setup.md` 初始化这台机器的 Pi：检查已有环境，只补齐缺失项，
> 全局安装 pi-web-access 和 pi-subagents，使用 Codex 登录，配置 scout 与 reviewer 只读，
> 执行真实搜索及“scout → 双 reviewer”验证。保留已有配置和扩展；最后报告版本、安装位置、
> 登录状态、搜索结果及子 Agent 运行回执。需要我完成网页登录时告诉我。

没有仓库时，也可以把本文件单独交给 Agent；以下命令不依赖 Runweave 项目。

## 安装约定

| 项目          | 约定                                                             |
| ------------- | ---------------------------------------------------------------- |
| Pi CLI        | npm 包 `@earendil-works/pi-coding-agent`，当前用户的全局工具     |
| 搜索扩展      | `npm:pi-web-access`，使用 `pi install` 管理                      |
| 子 Agent 扩展 | `npm:pi-subagents`，同样全局安装；初期只读调研与双 reviewer      |
| 模型提供方    | `openai-codex`；新环境默认模型使用 `gpt-6-astra`，需确认账户可用 |
| Pi 配置       | 默认 `~/.pi/agent/settings.json`；只合并所需字段，不覆盖整个文件 |
| 扩展目录      | 默认 `~/.pi/agent/npm/node_modules/<包名>`                       |
| 搜索配置      | 默认 `~/.pi/agent/web-search.json`，没有自定义需求时无需创建     |

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

分别只在对应扩展缺失时安装：

```bash
pi install npm:pi-web-access
pi install npm:pi-subagents
pi list
```

不加 `-l`：该参数会改为项目级安装。`pi list` 应在 `User packages` 下列出
`npm:pi-web-access`、`npm:pi-subagents`（或其固定版本）及安装路径。

以上命令为新环境安装当时的 npm 版本。需要复现已验证组合时，可在缺失组件的安装命令中
分别使用 `@earendil-works/pi-coding-agent@0.85.1` 和 `npm:pi-web-access@0.29.0`。
这组版本已于 2026-09-12 在 macOS 完成真实搜索验证；同日 Pi 0.85.1 与
`pi-subagents@0.67.0` 完成原生子会话串行调研、双 reviewer 并行及结果回传验证。
其他服务器仍须完成下述验证，不继承本机通过结论。

如本机 npm 镜像下载超时，可仅对本次公开包安装使用
`npm_config_registry=https://registry.npmjs.org pi install npm:pi-subagents`，
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

## 5. 子 Agent 的保守配置

安装只提供委派能力，不会自动运行评审。主 Pi 负责拆任务、取 Git diff、汇总和决定是否修复；
子 Agent 初期只使用 `scout` 与 `reviewer`。它们继承父会话模型，不另行绑定提供方。

向用户 `settings.json` 合并下列字段，保留已有模型、`packages`、`skills` 及角色配置。
设置中的 `tools` 必须是字符串数组，不是 agent Markdown frontmatter 的逗号分隔写法：

```json
{
  "subagents": {
    "agentOverrides": {
      "scout": {
        "tools": ["read", "grep", "find", "ls", "contact_supervisor"],
        "output": false,
        "defaultContext": "fresh",
        "inheritProjectContext": true,
        "inheritSkills": true
      },
      "reviewer": {
        "tools": ["read", "grep", "find", "ls", "contact_supervisor"],
        "output": false,
        "defaultContext": "fresh",
        "inheritProjectContext": true,
        "inheritSkills": true
      }
    }
  }
}
```

两种角色没有 `bash/edit/write`；Git 和运行验证由主 Agent 提供证据。任务仍须明确
“不写 progress.md、不改文件”，避免 scout 的默认进度说明与只读目标冲突。
`inheritSkills` 仅继承已发现技能，不会安装 Toolkit；新机器没有相应技能时不能假定可用。
这些限制不是操作系统沙箱，也不禁用其他内置写入角色；不要让本流程调用 worker 或自动修复。

另向 `~/.pi/agent/extensions/subagent/config.json` 合并运行限制，不要放进 `settings.json`：

```json
{
  "globalConcurrencyLimit": 2,
  "maxSubagentSpawnsPerRun": 3,
  "maxSubagentDepth": 1,
  "worktree": false
}
```

限制针对单个流程：先一个 scout，再两个并行 reviewer，总计三个子 Agent；不是全机器的
并发或费用上限。`worktree: false` 仅表示默认不分配 worktree，不提供写隔离。不要并行写
同一工作区；需要并行实现时另行设计隔离，并核对本仓 `.worktree/` 路径规则与扩展限制。

## 6. 使用与真实子 Agent 验证

重启 Pi 或 `/reload` 后先执行：

```text
/subagents-doctor
/subagents-models
```

确认扩展无加载错误、scout/reviewer 被发现、模型映射符合预期。doctor 成功只证明发现和
基础配置可用，不证明模型调用、并行或结果回传成功。

### 保存只读流程快捷入口

在用户配置目录的 `prompts/scout-review.md` 创建以下模板；已有同名模板时先阅读再合并。
`/scout-review` 是本地自建的 Pi prompt，不是扩展自带命令：

```markdown
---
description: Scout 调研后双 reviewer 独立只读评审，最多三个子 Agent
argument-hint: "<任务、改动范围或提交>"
---

对 $@ 执行只读调研与评审。先读取 pi-subagents skill 和当前版本 workflows 指南，
确认 scout/reviewer 可用。主 Agent 提供准确 cwd、基线、diff、需求与项目约束。
只启动一个 async workflowScript：先 await runs.run 的 scout，再 await runs.all
并行启动 correctness 与 boundaries 两个 reviewer；使用稳定 key 和描述任务的 label。
三者均 fresh 上下文、output:false、progress:false、worktree:false。
将 scout 输出传给两个 reviewer，分别独立核对正确性/回归，以及边界/验收缺口/复杂度。
总计最多三个子 Agent、并发两个。子 Agent 不写文件、不执行命令、不再委派。
失败时报告已有证据并停止，不自动重试、改代码、提交或创建 PR。
主 Agent 等待完成后核实、去重并汇总；没有可靠问题就明确说明，不把静态审查当运行验收。
```

例如在仓库中执行 `/scout-review 最近一次提交`。运行过程中可用
`/subagents-fleet` 查看任务和记录；普通交互会话使用扩展的完成通知，不循环 sleep 轮询。

### 无界面真实验证

选一个明确的只读目标，从项目目录启动独立验证；用实际 `<文件路径>` 替换占位符：

```bash
pi --session-dir /tmp/pi-subagents-smoke/sessions \
  --tools read,grep,find,ls,subagent,bg_wait --mode json -p \
  '做真实只读冒烟测试，目标 <文件路径>。先确认 scout/reviewer 可用，只启动一次 async:true、mission:false、worktree:false、context:fresh、timeoutMs:240000 的 workflowScript。先一个 scout 读目标和就近规则，再将其结果传给两个并行 reviewer，分别检查正确性和验收边界。每个子任务 output:false、progress:false，最多读五个文件，返回简短证据，不写文件、不运行命令或子agent。scout 失败立即停止，不重试、不切换模型或执行模式。用 bg_wait 等待本次 headless 结果，读取最终 status，返回三个结果和运行ID。' \
  > /tmp/pi-subagents-smoke.jsonl 2> /tmp/pi-subagents-smoke.stderr
```

若收紧主进程 `--tools`，必须保留子角色要求的 `read/grep/find/ls`；仅给
`read,subagent,bg_wait` 会使 scout 在模型调用前失败，报
`tool contract could not be satisfied`。这不是模型或被评审代码失败。
本机首轮曾遗漏这三个只读工具，补齐同协议重试后通过；不需要给子角色开放写入或 shell。

验收不能只看 CLI 退出码或模型自述，需要核对 JSON 工具结果及回执：

- scout 与两个 reviewer 均有独立 run ID，最终工作流 `complete`，子项完成且返回实际内容。
- scout 返回结果后才启动 reviewer；事件记录证明两个 reviewer 执行区间重叠。
- `workflow-receipt.json` 记录 fresh 上下文与模型；本机验证 scout 使用
  `openai-codex/gpt-6-astra:low`，两位 reviewer 使用同模型 `:high`。
- 对比运行前后的 Git diff、状态及原有未跟踪文件内容，确认未修改工作区；不得清理其他任务改动。
- 基础设施失败时保留错误、run ID、cwd、分支和已有 diff；只做明确的同协议修正或由用户决定，
  不擅自改为外部 CLI、前台子 Agent 或其他执行模式。

本机此流程约 103 秒完成，工作流 ID `ae3f2ece-cef9-49c4-8ce6-6a4b357e046a`，
本地证据目录 `/tmp/pi-subagents-smoke/`（临时目录，不随仓库分发）。这只是原生子 Agent
执行链路冒烟，不代表 TUI Fleet、取消/恢复、多机或产品真机功能已通过。

## 更新与维护

需要升级时分别执行，再重跑对应的搜索和子 Agent 验证：

```bash
pi update
pi update npm:pi-web-access
pi update npm:pi-subagents
```

固定版本的包不会随常规包更新升级；需要时用 `pi install npm:pi-web-access@目标版本`
显式切换。卸载扩展使用 `pi remove npm:pi-web-access`；若安装时固定了版本，使用
`pi list` 显示的完整来源。子 Agent 扩展同理使用 `pi remove npm:pi-subagents`；卸载后
自建 `/scout-review` 模板和角色配置不会自动清理，需按需移除。新增常用扩展时维护本文
的安装约定及验证步骤。

上游参考：[Pi 快速开始](https://pi.dev/docs/latest/quickstart)、
[Pi 包管理](https://pi.dev/docs/latest/packages)、
[pi-web-access](https://github.com/nicobailon/pi-web-access)、
[pi-subagents](https://github.com/nicobailon/pi-subagents)、
[子 Agent 配置](https://github.com/nicobailon/pi-subagents/blob/main/docs/configuration.md)、
[子 Agent 工作流](https://github.com/nicobailon/pi-subagents/blob/main/docs/workflows.md)。
