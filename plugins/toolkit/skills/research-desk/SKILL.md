---
name: research-desk
description: 按研究方向采集论文和技术博客全文，冻结证据，逐篇生成中文总结并由另一模型在新线程审阅，再结合历史资料形成跨篇研究。用于“研究这个方向”“继续上次研究”“研究一次”；支持明确链接作为材料，不用于工作日报或把文献结论直接写入项目经验。
---

# 研究工作台

完成可追溯、可续跑的技术研究。默认方向为 Agent Memory；方向配置、资料与回执保存在本机独立资料库，跨项目使用，不进入业务仓库。当前执行器支持 macOS/Linux 与已登录的 Codex CLI；生成和审阅必须选择不同模型。

## 入口

在本机独立使用时先通过下面同一脚本执行 `install`，安装到 `~/.agents/skills/research-desk`。更新仍从本仓库源码执行 `install`；只更新安装器管理且未被人工修改的文件，旧版保留在用户数据目录，不改现有插件、日程或会话。新会话可自动发现，快捷入口引用此稳定用户技能路径。

所有命令调用**本 SKILL.md 同目录**的 `scripts/research.py`。使用参数数组传参，不拼接包含用户输入的 shell 字符串。

```bash
uv run --no-project --no-env-file <skill-directory>/scripts/research.py --topic agent-memory doctor
uv run --no-project --no-env-file <skill-directory>/scripts/research.py --topic agent-memory init
uv run --no-project --no-env-file <skill-directory>/scripts/research.py --topic agent-memory run
uv run --no-project --no-env-file <skill-directory>/scripts/research.py --topic agent-memory resume
```

`uv` 按脚本内声明在隔离环境准备依赖，不安装到项目或全局 Python。缺少 uv/Codex 时明确缺项，不改认证、代理或模型账户。命令 stdout 为 JSON，进度在 stderr；需要等待真实退出和最终状态，不能用进程存在或收到启动响应冒充完成。

1. 先 `doctor`。新方向用 `init --name '<方向名>'` 创建配置。**非 Agent Memory 方向**须先把关键词和来源改成实际研究范围，不能沿用默认关键词。已有方向直接读取返回的 `topic.json`，保持用户配置。
2. 根据用户要求调整方向、来源、窗口与预算；详见[配置与材料合同](references/workflow.md)。默认近60天、最多80个候选、每轮最多5篇；历史最多回看180天、30篇，并受完整输入上限约束。
3. 新研究执行 `run`。用户说继续时执行 `resume`，只有一个未完成批次时自动选中；多个批次或指定批次用 `resume --run <id>`。`run` 不绕过未完成批次创建第二次执行。
   `resume` 返回 `nothing_to_resume` 且退出0时，本次检查已正常完成：提示“没有未完成研究，可点击研究一次开始”，不要再调用 `report`、自动执行 `run` 或生成启动确认。在后台任务中正常返回 `succeeded`，说明没有新增报告，`recovery` 为 null。
4. 执行器采集并冻结全文，按相同研究范围、规范URL和正文指纹跳过已处理版本。原文不可读就保留原因，不能以摘要替代全文。完整文本过大时跳过或停止，不静默截断。
5. 每篇生成与审阅使用独立新线程；事实、归属、指标和推断越界影响准入，文风不作拒收理由。最多修订一次，仍不通过则保留候选。总结通过后，结合实际绑定的历史原文做跨篇综合并独立审阅；不足两篇或缺少新证据可 `no_insight`。
6. 有已完成研究批次时运行 `report`，读取实际报告和范围说明，给用户报告绝对路径及简短结论。保留来源缺口、未通过材料和“未复现实验”等限制。`no_insight` 是证据不足，不伪装成生成了新洞察。

报告或冻结输入被修改时保留修改并停止，不覆盖人工内容。中断后复用已完成回执；输入对象字段顺序变化不视为内容变化，任务说明、材料或模型变化仍拒绝复用。结果未知的模型调用不自动重发。先查看 `status` 和对应 `calls/`：有匹配的完成事件与最终响应时 `resume` 可恢复，否则报告具体未知调用，等待核对，不新建批次绕过。

## 快捷入口与后台运行

`shortcuts` 返回“研究一次／继续上次研究”的两条指令内容，须先 `install`。用 Runweave 已有快捷指令创建 API 或 `rw quick-input create` 保存，重试沿用同一 `clientImportId`；回读确认正文与模式。更新已有指令用带 `expectedUpdatedAt` 的 API 或 `rw quick-input update`，不覆盖他人修改。不要把插件缓存绝对路径写进快捷指令。

保存快捷指令不启动研究。已有“后台运行”可以执行这两条指令，研究结果保存在配置的资料库，不放进临时任务目录。后台运行仍需可用的 Codex 认证和来源网络；本技能不扩大宿主权限。

用户明确要求订阅时才读取 [scheduled-task](../scheduled-task/SKILL.md)，复用现有调度并按其草稿确认流程创建；不要在研究、安装或保存快捷指令时自动创建日程。缺少日程时先交付可执行研究能力。
