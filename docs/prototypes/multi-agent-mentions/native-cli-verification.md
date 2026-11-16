# 原生 CLI Skill 代发：隔离验证记录

2026-11-17，本机 Codex CLI 0.169.0。目标是验证用户在原生 CLI 提交 @多个别名后，由当前 Agent 读取 Skill 并代发；不是 UI 方案模拟。

## 结果

8 项检查通过：

1. 原生轨迹记录 `cat .agents/skills/agent-relay/SKILL.md`，用户提示没有显式指定 Skill 名称。
2. 原生轨迹记录调用 `scripts/relay.py`，由其执行已有 `rw terminal task` 命令。
3. 代发者、backend、frontend 为三个独立原生 thread。
4. 两个接收者收到相同正文；各自投递有独立标识。
5. backend 私有原始数字 1139，frontend 私有原始数字 2281；同题加 17 得到 backend=1156、frontend=2298；代发者返回与真实 final 一致。
6. 仅 @backend 追问原始数字加 19，沿用原 thread 返回 backend=1158；frontend 无新增投递。
7. @missing-agent 被拒绝，已登记接收者没有新增投递。
8. 复用 relay-r1 请求编号与相同正文，读取同一结果，没有产生重复投递。

曾在同次观察中读取到两个接收者均为 agent_running；这不是精确推理耗时或性能基准。历史读取仍存在执行中短暂显示 interrupted 的现象，本次以匹配投递的原生 final、completed 和实时 idle 联合判定结束。

## 输入与边界

原生输入由 `rw terminal task send` 注入 Codex TUI，保留普通 @别名文本；未走 Runweave 悬浮输入框，也未添加 UI 拦截或 Hook 解析。后台会附加投递标记，Skill 转发正文也带有该来源标记。这是可行性探针，正式实现应将路由元数据与任务正文区分。

同一轮测试使用两个登记的 Codex 接收者，以及当前 Codex 作为代发者。临时 Skill 描述、注册表与 helper 均属于受控条件。没有人工逐键输入 @，没有验证补全弹窗、所有 CLI 的文件提及冲突、自动触发稳定性、Pi / Claude 发起端、压力、跨机器、重启或异步自动回报。

请求编号在探针提示里显式提供，仅用于证据比对。正式方案应由工具创建并持久化，不要求用户手工填写。

## 原始证据

本机证据根目录：
`/var/folders/hp/bk0rp6xn3t5fsr5sf7n256rr0000gn/T/rw-skill-relay-20261117-e9ev3xeu/`

- [检查结果](/var/folders/hp/bk0rp6xn3t5fsr5sf7n256rr0000gn/T/rw-skill-relay-20261117-e9ev3xeu/evidence/summary.json)
- [Skill](/var/folders/hp/bk0rp6xn3t5fsr5sf7n256rr0000gn/T/rw-skill-relay-20261117-e9ev3xeu/coordinator/.agents/skills/agent-relay/SKILL.md)
- [代发者工具调用](/var/folders/hp/bk0rp6xn3t5fsr5sf7n256rr0000gn/T/rw-skill-relay-20261117-e9ev3xeu/evidence/coordinator-tool-calls.json)
- [代发者最终原生会话](/var/folders/hp/bk0rp6xn3t5fsr5sf7n256rr0000gn/T/rw-skill-relay-20261117-e9ev3xeu/evidence/final-coordinator.json)
- [backend 原生会话](/var/folders/hp/bk0rp6xn3t5fsr5sf7n256rr0000gn/T/rw-skill-relay-20261117-e9ev3xeu/evidence/final-backend.json)
- [frontend 原生会话](/var/folders/hp/bk0rp6xn3t5fsr5sf7n256rr0000gn/T/rw-skill-relay-20261117-e9ev3xeu/evidence/final-frontend.json)
- [清理回执](/var/folders/hp/bk0rp6xn3t5fsr5sf7n256rr0000gn/T/rw-skill-relay-20261117-e9ev3xeu/evidence/cleanup.json)

## 清理

三个运行过的临时终端以及一个初始启动准备终端均已删除；原终端 e34c3022 保留。未安装全局 Skill、未修改产品代码。首次临时 Git 工作区要求目录信任；只信任本次自建目录，结束后移除了该唯一临时信任段。启用 Hook 先做只读信任核对，没有改动其配置。

手机真机当前不可达。本记录及完整说明也以当前终端文字交付，不把本机 HTML 路径说成手机网页地址，不声称原手机打开问题已修复。
