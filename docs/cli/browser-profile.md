# Terminal Browser Profile CLI

Terminal 内需要连接 Browser 时，先通过当前桌面实例的 resolver 解析 Worktree 绑定、临时覆盖和
CDP Group scope：

```bash
rw browser profile resolve [--profile 1|2|3] [--group-id <id>] [--json]
```

- 默认 Profile 顺序是当前 `RUNWEAVE_PROJECT_ID` 的 Worktree 绑定，再回退全局默认值。
- `--profile` 只覆盖本次解析，不修改偏好。
- 未传 `--group-id` 时保留 ambient `PLAYWRIGHT_MCP_CDP_ENDPOINT` 中已有的 `groupId`。
- resolver 只接受 loopback CDP endpoint。冲突返回退出码 `4`，参数错误返回 `2`，实例不可用返回
  `3`。
- `--json` 的 stdout 只包含 `profileId`、`source`、`projectId`、`route`、`cdpEndpoint` 和
  `whistle`；诊断信息写 stderr。

旧桌面没有 resolver 时，无显式 `--profile` 的调用会带警告回退到 ambient endpoint；旧版本不
支持 Worktree 绑定或临时 Profile 覆盖，显式覆盖会失败，避免把错误的 Browser 当作已选择目标。
