# Terminal Browser Profile CLI

Terminal 内需要连接 Browser 时，先通过当前桌面实例的 resolver 解析 Worktree 绑定、临时覆盖和
CDP Group scope：

```bash
rw browser profile resolve [--profile 1|2|3] [--group-id <id>] [--json]
```

- 默认 Profile 顺序是当前 `RUNWEAVE_PROJECT_ID` 的 Worktree 绑定，再回退全局默认值。
- `--profile` 只覆盖本次解析，不修改偏好。
- 当前 Terminal 有 `RUNWEAVE_TERMINAL_SESSION_ID` 且未传 `--group-id` 时，resolver 为该 Terminal
  派生稳定的专属 Group，并返回一次性内存 attribution token；原始 Terminal ID 不进入 Group id。
- 显式 `--group-id` 继续优先；没有 Terminal 身份时保留 ambient endpoint 中已有的 `groupId`，连接在
  Automation 中显示为“未归属自动化”。
- 同一 Terminal 的活跃连接只能使用一个 Profile；尝试连接第二个 Profile 返回
  `AUTOMATION_PROFILE_CONFLICT`，全部连接断开后才释放绑定。
- resolver 只接受 loopback CDP endpoint。冲突返回退出码 `4`，参数错误返回 `2`，实例不可用返回
  `3`。
- `--json` 的 stdout 只包含 resolver 响应；除原字段外可包含 `browserGroupId` 和
  `automationAttribution`，诊断信息写 stderr。返回的 `cdpEndpoint` 可能带短期 token，不应写入日志、
  项目文件或长期缓存。

旧桌面没有 resolver 时，无显式 `--profile` 的调用会带警告回退到 ambient endpoint；旧版本不
支持 Worktree 绑定或临时 Profile 覆盖，显式覆盖会失败，避免把错误的 Browser 当作已选择目标。

## 人工协助（Codex、桌面端）

遇到登录、验证码或其他必须由用户完成的页面步骤时，Agent 可以主动请求协助。这是协作协议，
不是强制暂停或 CDP 排他锁；请求前必须停止浏览器操作并 detach，然后结束当前轮次，不轮询等待。
不需要导出、清除或改写 Cookie。

```bash
rw browser assist request --browser-profile 1 --group-id <resolved-group-id> \
  --target-id <actual-cdp-target-id> --reason "请完成登录，完成后点击交还" --json
rw browser assist status [request-id] --json
rw browser assist acknowledge <request-id> --json
rw browser assist cancel <request-id> --json
```

`--browser-profile` 必须来自前面的 resolver 结果，不是让 Agent 自行换 Profile。target-id 是该
Profile/Group CDP `/json/list` 中原页面的 `id`，不是页面 URL、tab 序号或桌面主窗口 target。
请求只保存绑定与协助原因，不保存 CDP token、页面截图、密码或 Cookie。

所有命令要求当前 Terminal 注入的 `RUNWEAVE_TERMINAL_SESSION_ID`。有 `TMUX_PANE` 时通过
Backend 的 Panel workspace 精确匹配调用者 pane（不使用 UI activePanel），否则使用
`RUNWEAVE_TERMINAL_PANEL_ID`；无法唯一解析则拒绝。使用现有 CLI 认证；`--profile` 是认证配置名，与
`--browser-profile` 不同。JSON 响应包含 requestId、terminalSessionId、panelId、threadId、
profileId、browserGroupId、targetId、reason、state、createdAt、expiresAt、resumedAt。

Terminal 提示卡在 Sidecar 收起时仍显示。用户等待“Agent 等待协助”后打开原页面；操作完成后
点击“完成并交还 Agent”。桌面校验页面仍属于原窗口/Profile/Group，Backend 校验原 Panel、
tmux pane 和 Codex 对话仍存在且空闲，再向原 pane 投递一次恢复提示。不启动或替换 Agent。
协助期间不要在输入框保留请求前的未发送草稿。请求后的新终端输入会同步使旧请求失效，
不依赖异步 running/idle 事件；需要由 Agent 重新观察并请求协助。
交还投递的短窗口内，其他输入明确返回忙碌错误，不混入恢复提示。
由于原始终端输入按当前 pane 路由，这个输入保护覆盖同一 Terminal session 的全部 Panel。
这不是运行中 Agent 的强制抢占能力，也不拦截 Runweave 之外的直接 tmux 输入。

| 状态                              | 含义                                                                |
| --------------------------------- | ------------------------------------------------------------------- |
| requesting                        | 请求已登记，尚未确认 Agent 结束当前轮次                             |
| waiting                           | 已观察到原 Agent 空闲，用户可以处理页面                             |
| resume_pending                    | 已发起一次交还投递，尚未得到 Agent 确认                             |
| acknowledged                      | 原 Agent 已执行 acknowledge，不表示业务任务完成                     |
| delivery_unknown                  | 投递可能部分成功，不自动重试；检查原终端，原 Agent 仍可 acknowledge |
| cancelled / expired / invalidated | 不会自动恢复；需要重新观察并创建请求                                |

Agent 收到恢复提示后先 `acknowledge`，失败则停止。成功后按响应中的绑定重新解析 Profile/Group、
附着原 target 并获取新 snapshot：已经完成则不重复提交，仍被阻塞则 detach 后创建新请求，否则继续
原任务并最终 detach。不能重放交还前的坐标、元素引用或点击。

每个 Panel 同时一个活跃请求，30 分钟过期。交还幂等，不自动重投；取消只允许在交还前，交还后
需使用终端现有停止能力。请求属于 Backend 当前运行期，重启后旧 ID 返回 404，不恢复或重放。
当前绑定对话而不是操作系统进程代际；不承诺抵御同一 pane 内重启并恢复同一 thread 的竞态，
也不提供其他 Agent 的强制浏览器写入封锁。关闭页面后应取消请求并重新观察。

实现入口：[Backend coordinator](../../backend/src/terminal/browser-assistance/service.ts)。
验收：[browser-assistance.testplan.yaml](../testing/browser-assistance.testplan.yaml)。
