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
