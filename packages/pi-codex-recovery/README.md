# Pi Codex Recovery

Pi provider 扩展，兼容 Pi 0.85.1。增强 Codex TUI 的错误恢复，不修改 Pi 安装包。支持普通 Pi 配置显式启用，以及原有的独立验收配置。

## 日常 Pi 安装

推荐把扩展部署到稳定的用户目录，再通过 Pi 的本地包机制启用。不要让日常安装依赖临时 worktree 路径。以下部署命令在仓库根目录执行。

**这是独立副本安装，不会自动跟随仓库源码更新。** `pnpm deploy` 将源码和运行所需依赖部署到用户目录；`pi install` 只登记这个本地包的加载路径，不负责持续同步源码。

- 开发源码：仓库中的 `packages/pi-codex-recovery`。
- 实际加载的副本：`~/.pi/packages/pi-codex-recovery`，不通过软链接指向 worktree。
- Pi 用户配置：`~/.pi/agent`，保存安装登记、登录与会话，和部署副本分开。

修改源码、切换分支或拉取仓库后，已安装副本保持原样；仅重启 Pi 或再次执行 `pi install` 不会同步这些修改。删除原 worktree 也不会删除已部署的扩展。

首次安装命令：

```sh
pnpm install --frozen-lockfile
pnpm --filter pi-codex-recovery typecheck
pnpm --filter pi-codex-recovery deploy --legacy "$HOME/.pi/packages/pi-codex-recovery"
pi install "$HOME/.pi/packages/pi-codex-recovery"
```

部署目标必须是新目录；更新时先备份旧部署，部署完成再切换。普通 Pi 的 `~/.pi/agent/recovery.json` 中设置 `"profile": "shared"`，例如文件不存在时创建 `{"profile":"shared"}`。若已有该文件，合并此字段并保留其他设置。不要修改普通配置的 `retry`，也不需要复制登录凭据或会话。退出并重新启动 `pi` 后生效，正在运行的旧进程不会自动切换。

普通配置下，仅 Codex TUI 使用此扩展的恢复控制器；print、JSON、RPC（包括子代理的非 TUI 调用）交回原生 Codex provider，其他 provider 不受影响。普通配置原有插件、模型选择和重试设置保持原样。

Pi 0.85.1 没有公开的单条消息禁止重试字段，其公开分类器根据错误文字判断是否重新开始。扩展对已经结束恢复、但仍会被分类为临时失败的错误，先在 TUI 展示原始原因，再返回明确的最终失败文案，避免外层重复预算。上下文溢出继续交给原生压缩。原始原因只即时展示，不写入恢复诊断；会话中保存最终失败文案。升级 Pi 时必须复验此分类合同，不能直接放宽版本守卫。

## 独立配置安装与启动

在仓库根目录执行 `pnpm install --frozen-lockfile`、`pnpm --filter pi-codex-recovery typecheck`。依赖由根目录 `pnpm-lock.yaml` 统一锁定，使用包内的 Pi 二进制运行。Node.js 至少为 22.19。

以下 setup 命令在 `packages/pi-codex-recovery` 目录执行。

首次运行 `node scripts/setup.mjs` 创建 `~/.pi/agent-codex-recovery`。脚本不覆盖已有设置，不复制原配置的凭据或历史。然后运行脚本输出的启动命令，在 Pi 中使用 `/login` 独立登录 OpenAI Codex。

也可用 `node scripts/setup.mjs --profile /absolute/path/agent-codex-recovery` 创建另一独立配置。最终真实目录名必须为 `agent-codex-recovery`，不能指向普通 `~/.pi/agent`。专用目录的 `settings.json` 必须保持 `retry.enabled=false`，项目设置也不能覆盖它。配置守卫在每次模型调用前重新检查。

此 setup 只创建独立配置，不改写普通 `pi` 的工具、会话或设置。独立入口仅支持 `openai-codex` TUI；未设置 `profile: "shared"` 时，RPC、JSON 和 print 模式仍拒绝候选模型请求。

## 仓库组织

每个 Pi 扩展在 `packages/pi-<name>` 下独立成包，分别维护 `package.json`、依赖、入口、README 与验证脚本，由根 pnpm workspace 管理。新增扩展沿用此结构，并在包的 `pi.extensions` 中声明入口；按需在对应 Pi 配置中启用。加入 workspace 不会自动加载扩展，也不会自动将它打包进 Runweave 客户端。多个扩展出现实际共用逻辑时，再提取公共包。

## 行为和已知差异

- WS 正式首次加最多 5 次重试，耗尽再切 SSE；SSE 首次加最多 5 次重试。普通退避为 200 ms 起的指数退避，带约 ±10% 抖动。
- 426 立即降级。同一运行中会话保持 SSE，新会话重新尝试 WS；成功连接复用，空闲一分钟释放。请求使用完整有效历史，不依赖失效的增量 continuation。
- 明确的建连失败按 5、10、20、40、60、60… 秒等待；从首次网络等待起最多 5 分钟。未知连接错误只走有限普通预算。
- 临时限速遵守服务的等待时间；要求等待超过 60 秒则结束并提示稍后继续。鉴权、额度、非法请求不能无限重试。
- Escape 可取消连接、流读取和等待。内部失败尝试只作为恢复进度，最终才产生一个成功、失败或取消终态。
- 文字断流后可能重新生成并替换未完成内容。放弃尝试中的工具调用不执行，工具预览等成功后才出现。已完成轮次的工具历史保持原样。
- OAuth、工具执行与压缩算法沿用 Pi。没有 Codex 的预热、额外 HTTP 层重试、无限网络等待或部分工具并行续跑；401 可能需要 `/login`。

恢复期间额外调用可能增加模型时间和用量；Pi 的最终 usage 只来自最终响应，无法据此推算失败尝试在服务端的实际消耗。不同客户端的 delta 拼接兼容不属于当前 TUI 支持范围。

## 诊断与端点

专用目录的 `recovery.jsonl` 记录时间、随机会话/调用标识、阶段、尝试计数、等待和结局，不记录请求正文、响应正文、凭据或原始异常。文件创建权限为 0600。保留所需记录后可在实例退出时归档；本扩展不上传日志。

默认请求 `https://chatgpt.com/backend-api/codex/responses`。可在专用目录 `recovery.json` 中显式设置 `baseUrl`，仅允许 HTTPS 或本机 loopback HTTP。它是携带 Codex 凭据的目标端点，只设置自己信任的服务。本地故障探针始终使用假凭据，不能对真实账户执行故障注入。

HTTP 使用 Pi 进程已配置的 fetch；WS 使用 `ws` 并按公开 Pi 代理解析规则读取 HTTP/HTTPS 代理环境变量。不修改系统代理、DNS 或 VPN；SOCKS/PAC 不在此扩展支持范围内。

## 验收

当前版本已通过 11 条本地故障用例与真实 OpenAI 请求、连接复用和 read 工具验证，范围与证据见[验证记录](docs/validation.md)。

在仓库根目录运行：

```sh
pnpm testplan:validate docs/testing/terminal/runtime/pi-codex-recovery.testplan.yaml
node packages/pi-codex-recovery/scripts/recovery-probe.mjs --case PCR-001 --output /tmp/pi-recovery-evidence/PCR-001
```

普通配置兼容验证可为探针增加 `--shared-profile`：使用临时普通目录并保持 `retry.enabled=true`。PCR-001 此时返回原生分类器认定可重试的错误，确认恢复结束不会启动额外外层重试。PCR-009 专门验证独立配置守卫，不支持该开关。

按 PCR-001 至 PCR-011 顺序逐条执行，每条使用新的输出目录，遇到失败先修复当前项再继续。PCR-006 使用真实默认 5 分钟期限。探针需要 tmux，并启动真实 Pi TUI、独立临时配置、本地 HTTP/WS 服务；工具只修改临时计数记录。不包含单元测试，也不依赖测试替换恢复控制器。

输出包括 `verdict.json`、终端文本快照、服务请求、公开 Pi 事件和脱敏恢复时间线。服务与 observer 中的正文仅来自确定性的假模型。探针成功仅证明对应故障场景；真实上游验证需另用已独立登录的专用配置发起只读请求。

探针退出时关闭自己的 tmux server、连接与监听，保留临时 fixture 和证据便于复核。不会关闭用户 tmux server。

## 升级与回滚

### 更新已安装的源码副本

1. 在仓库中完成修改并运行包的 `typecheck` 及对应行为验证。
2. 使用 `pnpm --filter pi-codex-recovery deploy --legacy <新的暂存目录>` 部署完整副本，并检查部署后的依赖和入口可加载。不要只覆盖个别源码文件，以免源码与依赖版本不一致。
3. 退出使用该扩展的 Pi 实例，将原 `~/.pi/packages/pi-codex-recovery` 移到备份目录，再把验证过的暂存目录移到这个固定路径；若切换失败，恢复备份。保留 `~/.pi/agent` 中的设置、凭据和会话。
4. 重新启动 Pi，验证真实请求。加载路径没有变化，无需再次执行 `pi install`。更新后的验收完成前保留旧部署，以便回滚。

本地路径安装没有配置自动更新；`pi update` 也不能替代上述从仓库重新部署的流程。不要直接在安装目录开发，后续部署会替换其中的改动。

### Pi 版本升级与回滚

依赖锁定 Pi 0.85.1。升级前重新检查公开 provider、模型目录、Responses parser、TUI partial 快照语义及上述故障矩阵，验证通过后才调整版本守卫。

普通配置回滚：执行 `pi remove "$HOME/.pi/packages/pi-codex-recovery"`，重新启动 Pi。此安装不改动原生 retry 设置，无需恢复它。

独立配置回滚：退出专用实例，恢复使用原 `pi`。可移除专用配置中的扩展路径或保留整个专用目录供查阅，不删除凭据和历史。若把专用目录改为无插件运行，须自行恢复 Pi 的重试设置，避免留下 `retry.enabled=false`。

请求构造中的小段代码改编自 MIT 许可的 `@earendil-works/pi-ai` 0.85.1；许可证见同目录 `THIRD_PARTY_LICENSE`。其余转换、解析、OAuth 与模型目录直接复用公开模块。
