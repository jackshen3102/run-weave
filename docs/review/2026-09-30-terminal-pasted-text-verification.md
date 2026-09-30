# Terminal 长文本附件验证记录

2026-09-30；实现已落盘，完整验收尚未闭环。不作为部署或发布通过结论。
当前合同：[Frontend](../../frontend/docs/terminal-text-attachments.md)、
[Backend](../../backend/docs/terminal-text-attachments.md)。

## 环境与取证

源码 `/Users/bytedance/Code/browser-hub/browser-viewer`，基线
`66b749bf1b80767932e3db5b2d82ec5537929781` 加本次未提交改动。
由 Dev Session planner 选择 Beta，安装构建 0.216.0 至 0.223.0。
最终构建 0.223.0 含保存中关闭提示、不确定投递的镜像保护，以及仅开放 macOS loopback 直连的资格收紧。
Dev Session `dvs-a47e50`、槽位 `pool-05`；最终租约
`fbb62c6c-f051-4a5c-88ea-ef291b5cc93d`，Backend PID 96697。
桌面使用 resolver 返回的 `dvs-a47e50-desktop` / CDP 9335，未修改 Stable 安装。
测试 session、tmux pane、磁盘错误、崩溃和旧版本实例均为本任务创建的隔离 fixture。

测试合同未放宽；按真实接口、DOM、TUI、磁盘与 Agent 工具结果分别取证。
辅助脚本位于本机 `/tmp/txt-case*.js`、`/tmp/txt-case014.ts`，不是新增单元测试。
下表“通过”说明已观察对应结果；跨构建拆分的证据注明边界。

## 长文本用例

| Case | 结果 | 实际证据 |
| --- | --- | --- |
| TXT-001 | 通过 | 4999 原生剪贴板粘贴；5000 ASCII、2500 emoji、含中文/CRLF/tab/HTML 样本完整保存。认证回读的字节数、SHA-256 与原文一致，预览没有执行 HTML。fixture `cd384e84`。 |
| TXT-002 | 通过 | 两份同长度正文生成不同 ID；恢复仅替换选区 3..9，其他附件保留；移除不改正文、不提交。fixture `51f107a4`。 |
| TXT-003 | 通过 | 指令加附件一次 input；真实 Codex 工具读取文件首尾标记。另测仅附件发送及运行期间 Tab 排队，200、绑定 panel/thread、成功后消费。fixture `36a8a4ae` / `a1875b87`；最终 0.223.0 复验 `7bc0101d` 的仅附件发送和运行中排队均 200。 |
| TXT-004 | 通过，组合证据 | 0.221.0 fixture `190b8ce9`，最终 0.223.0 同行为复验 `7360c097`：保留原 TUI 指令，无自动展开/回车，关闭提示后显式 Enter，真实工具读取 `TXT004_BEGIN` / `TXT004_END`。底层一次 literal bracketed 路径、无 Ctrl-U/Enter/全文的序列另在 TXT-019 捕获。 |
| TXT-005 | 通过 | 创建真实成功后暂停响应，切到另一个实际 panel 再返回，insert 请求为 0；原 scope 显示未插入，可复制 6007 单元原文。fixture `dd51c44a`。未独立抓取两侧全部输出帧。 |
| TXT-006 | 通过 | 延迟保存期间继续输入和显式提交两种状态均取消插入；原生短文到达，复制原文分别 6013 / 6012 单元。fixture `42c92978`。 |
| TXT-007 | 通过 | 第二个真实 WebSocket 客户端向同 pane 输入后，暂停的旧 insert 返回 409；短文完整，旧路径未写。fixture `644b40df`。 |
| TXT-008 | 通过 | 服务端实际插入后丢弃响应，仅一次 write，通过只读查询得 accepted。最终包另中断查询，UI unknown、无重放、文件路径真实在 TUI，关闭卡片后镜像覆盖仍禁用。fixture `164712e2` / `67743034`。 |
| TXT-009 | 通过 | 五类匿名请求 401；跨 session content/insert/delete 410、input 409；任意 filePath 400、穿越 410，原文件仍读得 6014 单元。fixture `50936b42`。 |
| TXT-010 | 通过 | 1 MiB 保存；1048577 字节拒绝且复制完整；真实填满 100 MiB 后 413，所有配额 draft 已释放。对本例目录 chmod 0500 注入 EACCES，不插入且原文可复制；恢复 0700 后新保存成功。fixture `738af0af`。错误文案已区分单份/会话限制。 |
| TXT-011 | 通过 | shell、真实 Vim、受控 SSH ProxyCommand、运行中 Agent 均只有原生 bracketed 输入帧、无 create；延迟保存后退出 Codex，原路径不进入 shell。fixture `a58f6576`。 |
| TXT-012 | 通过 | 同 op/payload create 返回同 ID，磁盘仅一份正文；重复 insert 回原 accepted，TUI 一次路径；改变正文/目标返回 409。fixture `db5f66db`，文件 `bc881316-b74f-4864-93ff-574648be9184`。 |
| TXT-013 | 通过 | 在真实 packaged Backend 持久化 dispatching 后、实际 tmux write 前用 Inspector 暂停，核验独占 PID 后 SIGKILL；按 Dev Session stale recovery 重启。同两份文件 SHA-256 不变，中断 op unknown，TUI 无中断路径，不自动重放。fixture `b3f78237`。 |
| TXT-014 | 部分验证，未完整通过 | 实际文件服务与隔离磁盘的时钟 fixture 验证 draft 7 天、retain、临时文件 24 小时、referenced 保留、明确 deleted 后 7 天及损坏 metadata 跳过。真实 Codex 退出后文件仍在、没有 deletedAt，但 Backend session 仍标 running；退出/丢失 tmux 的现有恢复机制重新创建 shell，未取得稳定的 Backend exited 状态；实际 DELETE 204 后 metadata 写入 deletedAt 且文件继续保留，7 天时钟边界另用文件服务验证。不能以组件验证替代完整 runtime 用例。 |
| TXT-015 | 通过 | xterm 根/helper 分别一次 create/insert；短文不增 create；真实 PNG+长文本仅走 clipboard-image；Preview README 实际选区 Add to input 注入引用、无 txt 请求。fixture `083e1e22`。 |
| TXT-016 | 未执行，选测 | 远端能力保持关闭，没有声称支持远端读取。 |
| TXT-017 | 通过 | 干净旧 HEAD worktree 运行真实旧 Backend `dvs-5db3a4`，新 renderer 连接它；capability 404，6007 单元仅一个原生 6019 长帧，零 txt create/card。fixture `24a8fc50`。旧 session、连接、Dev Session 和临时 worktree 已清理。 |
| TXT-018 | 通过 | 无 textAttachmentIds 的旧 raw/line/default input 均 200，raw 只编辑，line/default 显式回车才执行真实 shell printf。fixture `6c2535fc`。 |
| TXT-019 | 通过，修正后复验 | 最终包 fixture `64642b4e` 在真实 copy mode 取得 lease 后，通过 Inspector 给本例 writer 增加临时等待；后续 `TXT019_AFTER` 完整排队。捕获一条 literal `ESC[200~ + JSON 路径 + ESC[201~`，放行后真实 TUI 路径在短文前、路径一次，无隐式提交；浮动覆盖发送禁用。修正了超时/切 scope/关闭提示可能恢复不可靠镜像的问题。 |
| TXT-020 | 通过 | 实际保存成功的响应暂停期间 Send 禁用、排队不可触发、input=0；移除 pending 后放行，DELETE 204、descriptor 410、原文字不变且卡片不复活。fixture `866d8e4f`。 |

额外实际验证：最终构建 fixture `35f16fff` 的本地 create 201；通过实际请求加入 forwarded 代理头后 capability=false、create/insert/composer 均 409。浏览器取得真实禁用结果后仅原生粘贴，create/card=0；未把这项连接分类检查计作远端 TXT-016。

TUI pending 提示关闭后仍一次 accepted 插入且卡片不复活，fixture
`dedf8905`；没有自动打开 Composer。原型模拟的四个 TUI 状态也单独通过，未计入产品验证。

真实 Agent 工具读取证据（本机 Codex rollout）：

最终 0.223.0 的 TXT-004 另由 `01a0f264-52a4-77a1-b05c-e25b6600e0e0` 实际读取附件 `0bdb6aca-dfdd-44f8-b175-d96162fb64e5`，请求/输出 JSONL 行号分别为 25 / 28，首尾标记一致。

- TXT-003：`01a0f1bc-0924-76c3-87cd-473e26549e56`，ordinal 22 工具请求、24 CommandExecution；读取首尾，exit 0，文件 6024 bytes / 0600。
- 最终 TXT-004：`01a0f248-986c-7c41-a4d7-e4273748879a`，JSONL 第 23 行 custom_tool_call 为真实文件 head/tail，第 26 行输出首尾标记且 exit 0；附件 `ed72386d-4bc9-4e1a-bebf-97bd839edf5a`。
- TXT-013：原确认文件 SHA-256 `1aa8af0cd3e7d2645b54d16df5d250e6c3fe6edc38746eba46d9d63a20b02b1c`；中断文件 `52ca6deec37da3722bf28342e50e04600e9756aacb19396d37f5d2f3880fdac7`，重启前后相同。

## 既有 Activity / Composer 回归

| Case | 结果 | 证据或阻塞 |
| --- | --- | --- |
| TAC-001 | 通过 | 无 query 的 Activity 默认 Terminal History；六个导航入口可见；刷新无白屏、无限 journal loading 或 pageerror。 |
| TAC-002 | 通过 | 真实同一 Terminal 两次 Codex，两个 Thread 的档案引用均保留，一条 Terminal 档案，创建时间不变；真实 Activity UI 同时展示两段。初次 fixture `697b2492`；复验 fixture `5f03edc7` 等两次真实 Worked for 和退出提示后，Thread `01a0f252-c362-7412-a9ec-98a112110385` / `01a0f252-f7f0-72e3-9c1b-d4778528ca41` 均归同一创建时间的档案。 |
| TAC-003 | 未执行，前提阻塞 | 本次隔离 Backend `/api/work-history/runs?limit=100` 返回 200、runs=0，缺少有 Evidence 和无 Evidence 的真实 Run。没有伪造验收事实或以 mock 判通过。 |
| TAC-004 至 TAC-010 | 未执行 | 按独立用例执行规则在 TAC-003 的前提阻塞处停止，未声称通过。 |

## 门禁与待完成

共享、Backend、Frontend typecheck 和 Backend/Frontend lint 已通过。
最终 Frontend 修正后再次 typecheck、lint 通过。架构检查 1587 files，over600=0，
runtime/type cycles=0；configuration access 检查 1144 个已分类访问通过。
测试计划 schema 与文档链接、diff 空白检查分别执行。

`pnpm backend:verify-lifecycle` 未通过：在现有 `verifyActivityDrain` 第 59 行
`assert(runtime.store)` 失败，附件 owner 的检查尚未被执行。
独立检查 Activity 初始化得到 `activity_sqlite_worker_termination_timeout`。
没有修改 Activity、SQLite worker 或原有生命周期验证脚本来绕过门禁。

未闭环项：TXT-014 的完整 runtime 删除/退出验收、TAC-003 的真实 Run 前提及后续回归、
生命周期门禁。全部 required 未通过，保留临时计划与本记录；不发布、不部署、不标为完整验收通过。

## 清理与最终状态

37 个本轮 `dvs-a47e50` 测试 Terminal 已通过真实 DELETE 清理，列表 remaining=0；
测试用 Default Project path 恢复为 null。已引用 txt 按生命周期合同保留，不直接删除。
旧 Backend 连接与临时 worktree、Inspector/凭据 relay、原型服务器与本轮原型 tab 均已清理；
既有浏览器其他 tab 保留。Playwright 已 detach，`dvs-a47e50` 状态 stopped。
最终 docs:check 131 Markdown / 17 entrypoints、两份 testplan schema、git diff --check 均通过。
代码未提交；临时计划与记录保留用于继续处理未闭环项。
