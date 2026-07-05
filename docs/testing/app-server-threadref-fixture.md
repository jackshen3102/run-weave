# App Server ThreadRef Fixture

用于给 behavior_verify 构造稳定的 App Server ThreadRef 验收数据，避免临场手写 `agent.hook` / `agent.completion` JSON。

## 命令

```bash
pnpm app-server:seed-threadref-fixture \
  --project-id fixture-project \
  --terminal-session-id fixture-terminal \
  --terminal-panel-id fixture-panel \
  --run-id fixture-run \
  --prefix status-lookup-recheck \
  --statuses running,starting \
  --print-json
```

脚本连接当前 App Server。可通过以下环境变量指定测试 App Server：

```bash
RUNWEAVE_APP_SERVER_HOME=/tmp/runweave-app-server-test
RUNWEAVE_APP_SERVER_STATE_DIR=/tmp/runweave-app-server-test
RUNWEAVE_APP_SERVER_URL=http://127.0.0.1:<port>
RUNWEAVE_APP_SERVER_TOKEN=<token>
```

支持的状态：

- `starting`
- `running`
- `idle`
- `completed`

输出中的 `threadId` 可直接用于 `/threads/:threadId` 或 Web Terminal 的状态查询 dialog。
