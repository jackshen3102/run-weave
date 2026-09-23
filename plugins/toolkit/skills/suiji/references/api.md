# 接入与调用

安装本 Skill 目录即可运行，不依赖仓库。执行 `python3 <skill-dir>/scripts/suiji.py --help` 查看参数。

准备权限 0600 的配置文件（身份从随记连接或交接文本取得），token 通过运行环境注入：

```json
{
  "endpoint": "https://your-suiji.example",
  "serverId": "服务 UUID",
  "ownerId": "所有者 UUID",
  "tokenEnv": "SUIJI_MCP_TOKEN"
}
```

配置发现优先采用用户明确给出的路径；本机可检查 `$HOME/.config/suiji/config.json`，不得猜测 HOME 为 /root。
客户端文件可显式加载，无需把秘密写入 shell 启动文件：

```bash
python3 scripts/suiji.py --config /private/suiji.json --env-file /private/device/client.env info
```

`--env-file` 只接受配置 tokenEnv 对应的一行 `变量名=43位token`，不执行 shell、不展开变量；
要求受保护文件（0600，拒绝符号链接），环境中已有不同值时返回 TOKEN_SOURCE_CONFLICT，在联网前停止。
未传该选项则继续使用原有环境变量。先核对 handoff 与本地配置，再向指定地址发送凭据并验证服务身份。
每台设备通过服务端 `mcp-credentials register` 独立登记摘要；Mac token 不需要复制到其他设备。
新版服务支持多 token，不能再覆盖服务器旧摘要来新增设备；管理命令见服务仓库的随记服务 README。

服务器需启用 MCP 个人凭据及跟进能力。缺少配置时向用户说明缺少哪项；不读取 App 密码替代。远程必须 HTTPS，loopback 开发服务可以 HTTP。脚本拒绝重定向。

以下从 Skill 目录执行，配置路径由当前用户环境提供，不要求固定工作目录：

```bash
python3 scripts/suiji.py --config /private/suiji.json info
python3 scripts/suiji.py --config /private/suiji.json search --query SSH --tag Runweave --status open
python3 scripts/suiji.py --config /private/suiji.json get --record-id <UUID>
python3 scripts/suiji.py --config /private/suiji.json followups --record-id <UUID>
python3 scripts/suiji.py --config /private/suiji.json handoff --input /private/handoff.txt
python3 scripts/suiji.py --config /private/suiji.json read-attachment --attachment-id <UUID>
```

`followups` 自动读取全部页；`read-attachment` 返回原工具分页，需要时用返回的 nextCursor 继续。图片保持 MCP image 内容块，结果不是图片已经被 Agent 阅读的证明。

成果输入文件只包含 recordId、body、可选 attachmentIds、agentName、sessionId。成果文件和 request 均使用本次唯一的路径；创建失败时不继续提交同名旧文件。append 必须通过 `--record-id` 独立传入本次选中的目标，脚本在联网前核对文件中的 recordId，缺少参数或不匹配时直接拒绝。文件内容和参数不是 shell 代码：

```bash
python3 scripts/suiji.py --config /private/suiji.json upload --record-id <UUID> --file /private/report.md --request /private/upload-intent.json
python3 scripts/suiji.py --config /private/suiji.json append --record-id <本次选中的 UUID> --input /private/result.json --request /private/result-intent.json
python3 scripts/suiji.py --config /private/suiji.json complete --record-id <UUID> --request /private/complete-intent.json
python3 scripts/suiji.py --config /private/suiji.json retry --request /private/result-intent.json
```

append/complete/upload 不接受已有 request 路径，防止覆盖结果未知的意图。retry 只重放文件，不接受新正文或新文件。已知业务拒绝也保留原意图便于核对；如需要改变请求，先确认原请求未提交再建立新的独立意图。不要将请求文件提交 Git。

旧的 append 调用需补上 `--record-id`；已冻结的请求格式不变，仍用原来的 `retry --request` 重试，不重新生成成果或幂等键。

连接关闭、响应不完整或超时会返回 `NETWORK_RESULT_UNKNOWN`，保留原请求。列表没有业务幂等键，即使读到相同正文也不能替代原请求的成功响应；只有用户明确要求后才重放原请求确认。

成功返回真实服务 JSON；失败以非零退出并返回错误代码。上传响应含 attachment.id；每条跟进最多一张 JPEG/PNG、一个 UTF-8 Markdown，各不超过 5 MiB。上传与追加分开：上传成功后保留返回 ID，再追加成果，不因追加结果未知重复上传。

## 底层合同

无状态 Streamable HTTP MCP 位于 `/mcp`，使用独立 Bearer；原 7 个工具外新增 get_service_info、list_followups、append_followup。跟进按 sequence 倒序，20 条/页，最多 50；追加需要业务 idempotencyKey，不需要父记录版本。正文最多 20000 Unicode 标量。

二进制上传位于 `POST /mcp/uploads`，同凭据、Idempotency-Key、multipart 单 file。App HTTP 使用独立 App 会话，不与 MCP token 混用。所有跟进归同一 owner；来源类别由服务设定。
