# 本地 Agent 每日事实记录

第一阶段只读取本机 Codex、Pi、Claude、Trae 原生 JSONL，按消息实际时间分日。
不调用模型、不联网、不读取飞书或随记，不修改来源。Agent 使用配套
[Skill](../../plugins/toolkit/skills/daily-record/SKILL.md)阅读材料并整理事实，CLI 负责校验与保存。

飞书来源由同一 Skill 的[独立只读脚本与流程](../../plugins/toolkit/skills/daily-record/references/feishu.md)
采集本人消息、相关回复及文档候选，再由 Agent 合并事实；不混入本包的本地材料格式。

```bash
pnpm --filter @runweave/daily-record build
pnpm daily-record collect --from 2026-10-16 --to 2026-10-22 --timezone Asia/Shanghai --out /private/tmp/agent-week-materials
pnpm daily-record review --bundle /private/tmp/agent-week-materials --date 2026-10-16 --max-chars 1200
pnpm daily-record read --bundle /private/tmp/agent-week-materials --id <材料ID> --verify-source
```

日期两端均包含。默认使用本机账号的来源目录；Codex、Pi、Claude 分别沿用
CODEX_HOME、PI_CODING_AGENT_DIR、CLAUDE_CONFIG_DIR。`--home` 可明确指定另一个本地
HOME 树，此时忽略这些变量，便于在独立目录进行行为验收。Trae 默认读取 HOME 下
`.trae/cli/sessions`。不按文件名或 mtime 过滤日期，每次完整扫描来源，增量索引留到以后。

collect 输出 manifest.json、materials.jsonl、sessions.json 和 facts.template.json。
新输出目录不得已存在。文件大小在打开时冻结，只读取范围内完整行；末尾未完成行不纳入该快照。
单行超过 16 MiB、非法 JSON、源文件重写或缺失身份／时间会明确记录覆盖问题。
目录软链接不跟随，排除数量进入 receipt。模型 reasoning、系统上下文和 supervision 催办不纳入材料。

工具参数和结果保留关联；凭据常见格式会脱敏，但材料仍是私人记录，目录使用 0700、文件 0600。
材料带来源字节范围、源行 SHA-256 和脱敏后正文 SHA-256。`read --verify-source` 回读源行校验。
采集时按 cwd 读取 Git common directory，记录稳定的 project.id 和默认项目名；同一仓库的
主目录、子目录和不同 worktree 合并，同名但不同仓库保持独立。非仓库、不可访问目录或一条
事实涉及多个仓库时归为“未归类”。旧材料包没有项目字段时，读取时按 cwd 补齐。
Pi、Claude 保留不同分支上实际发生的消息与 parentId，不将不同分支拼成一条当前对话。
Trae history_mutation 的 replace 只作为历史回放排除，不将其重新归入替换当天。

`review` 默认显示用户与助手消息，可加 `--role tool` 查看回执，或 `--thread <ID>` 限定会话。
每条返回 truncated；截断不是全文，必要时用 read。后台、子 Agent 与普通交互分别标识。

Agent 以 facts.template.json 为基础生成 facts.json：

```json
{
  "schemaVersion": 1,
  "collectionId": "材料包的真实 collectionId",
  "days": [
    {
      "date": "2026-10-16",
      "items": [
        {
          "statement": "讨论了某项需求。",
          "action": "discussed",
          "sourceIds": ["真实材料ID"]
        }
      ]
    }
  ]
}
```

`review` 和 `read` 返回 project，可直接复用。事实的 project 为可选的 `{id, name}`；省略时
从引用材料推断，明确填写时 id 必须与来源仓库一致，name 可使用“Runweave”等可读名称。
同一 id 的显式名称必须一致，并会应用到所有日期；不同 id 不会因名称相同而合并。
无法归属的事实保留“未归类”，不按临时目录名猜项目。项目身份在材料包中冻结，后续读取
不依赖原仓库仍然存在；旧材料包补齐项目时依赖当前 cwd 是否仍可访问。

每一天都必须存在；空日 items 为 []。action 是 discussed、attempted、changed、verified、reported。
reported 自动显示“Agent 报告”；verified 必须引用当天工具材料。日期与来源校验不是语义验证，
执行 Agent 仍须逐条核对原文。

```bash
pnpm daily-record validate --bundle /private/tmp/agent-week-materials --facts /private/tmp/facts.json
pnpm daily-record render --bundle /private/tmp/agent-week-materials --facts /private/tmp/facts.json --out /private/tmp/agent-week-output
```

默认输出 weekly.md 和每日 YYYY-MM-DD.md，按“日期 → 项目 → 当天结论”分组。
正文保留“Agent 报告”等事实状态，不显示来源编号、链接、采集说明或附件，也不生成来源 Markdown。
facts.json 保留项目及内部引用，manifest.json 保留覆盖状态；原文仍在采集包中供校验。
完整采集的空日写“没有”；读取不完整的空日写明无法确认，不伪装成无事项。
读取不完整的非空日也保留简短缺失提示。
渲染写新目录，失败不覆盖已有成功产物。退出码 0 为成功，2 为产物可读但覆盖不完整，
1 为输入或校验失败。

```bash
pnpm --filter @runweave/daily-record typecheck
pnpm --filter @runweave/daily-record lint
pnpm --filter @runweave/daily-record build
pnpm testplan:validate docs/testing/skills/daily-record-local.testplan.yaml
```

真实行为验收见[第一阶段计划](../../docs/testing/skills/daily-record-local.testplan.yaml)和
[项目分组计划](../../docs/testing/skills/daily-record-projects.testplan.yaml)。

## 多机器定时上报

同一 Skill 与任务模板分别在 Mac/devbox 的 Runweave Backend 运行，只读取本机来源。
Mac 可启用本人飞书聊天，devbox 明确关闭；关闭时不检查或调用 lark-cli。
执行入口是 [job.py](../../plugins/toolkit/skills/daily-record/scripts/job.py)，
[配置、任务模板及恢复](../../plugins/toolkit/skills/daily-record/references/scheduled-reporting.md)
说明逐日补报、稳定身份、已读证据校验和显式授权的自动发布。

原生 collect 新增可选 `--providers codex,pi`、`--machine-id <固定ID>`、
可重复的 `--exclude-thread <ID>`；省略时保留原行为和材料包版本。飞书仍使用独立材料格式。

[多机器验收](../../docs/testing/skills/daily-record-reporting.testplan.yaml) 的真实 Mac、飞书、
devbox 与到点调度须分别取证；本机 PostgreSQL/HTTP/CLI 集成验证不替代它们。
