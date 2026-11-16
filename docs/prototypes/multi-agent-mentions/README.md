# 原生 CLI：先接入 Review Agent，再扩展通用代发

2026-11-17 方案 04。用户已明确选择 Skill 代发，并要求先改造现有 Review Agent。
这是设计与验证材料，不是新增产品页面。方案 01/02 的图形输入入口废弃；方案 03 的
原生 CLI 方向保留，但“先实现通用别名层”的顺序已被本版替代。

[可视化说明](index.html) · [手机文字阅读版](phone-reading.md) · [此前通用代发探针](native-cli-verification.md)。

## 本次落地

原生 CLI 输入 `@review` → 当前 Agent 读取 `review-agent` Skill → `rw terminal review start`
→ 现有 Backend 冻结改动和用户要求 → 独立 Reviewer 审查 → 当前 Agent 用 show/wait 读取真实报告，
在原 CLI 回答。Backend 继续负责必要反馈回传，Skill 不重复 send。

新增 CLI start/list/show/wait 与插件 Skill；复用既有 Review 服务、协议、事项轮次和独立会话。
不增加前端页面、不拦截 TUI 输入，也不创建第二套审查调度器。review-only 仍是执行者职责，
不会递归启动另一个 Reviewer。

当前范围是来源终端所属项目的 staged/working/untracked 改动。托管终端默认使用环境中的来源 ID；
外部 CLI 需要明确选择 Runweave 来源终端和连接配置。不是任意无 Backend 的 shell 都能直接审查 cwd。
用户要求复审时新建请求，服务决定复用空闲且未被人工接管的 Reviewer，或创建新会话；
本次没有任意聊天追问接口。

## 后续通用方向

保留多 @ 目标、各自独立会话和定向追问的目标。下一阶段再做别名注册、各目标独立投递、
统一结果回执和忙时策略。将 Review 作为专门适配器接入，不能把它的冻结快照、需求核验和报告合同
强行推广给所有角色。跨执行器、跨机器、重启恢复和异步通知须分别设计及验收。

此前原生 Codex 临时 Skill 探针 8 项通过（多目标、独立上下文、定向追问、未知目标和重复请求）；
更早执行底座探针 13 项通过。它们是可行性证据，不是本次正式 Review 接入的验收，也不证明 Pi/Claude 发起端。
社区一手资料用于交互取舍，未安装运行社区产品，链接保留在 HTML。

## 当前事实入口

- [CLI Review 合同](../../cli/terminal-task-control.md)
- [代发 Skill](../../../plugins/toolkit/skills/review-agent/SKILL.md)
- [CLI 实现](../../../packages/runweave-cli/src/commands/terminal-review.ts)
- [既有 Review 服务](../../../backend/src/terminal/code-review/service.ts)

## 交付边界

完整核心方案在当前终端直接呈现，不依赖本机 HTML 链接。原手机 HTML 打不开的问题未复现，
手机不可达，不能声称真机访问已修复。截图 01–03 是废弃 UI 方案；04 是上一版说明文档，
不是本次功能画面。正式功能尚未发布或安装到全局 CLI/插件。

[方案 04 Review 流程图](screenshots/05-review-skill-v4.png)：Runweave Browser 文档渲染，390px 窄视口，无横向溢出，正文 16px；已操作章节跳转与三个后续场景，控制台无错误。不是原生终端或真机截图。

## 本次 Review 接入实测（2026-11-17）

使用本工作区构建的 CLI，连接现有安装态 Backend（未改 Backend），在临时 Git 项目内启动
原生 Codex 0.169.0。普通 `@review` 请求使当前 Agent 读取本地新 Skill 并调用 start。
首次发现包装器的全局 `--instance` 参数被命令误拒绝；修复并重建后，沿用原 requestId 恢复。
Backend 创建另一原生 thread 的 Reviewer，报告完成后当前 Agent 用 show 读回并在来源 CLI 汇报。

Review `2eebdae4-087c-41a8-b773-5897c4b7f7a8`：临时 count 函数的 8 组实际调用符合要求，
报告 `completed / code_and_goals / coverageComplete=true / stale=false / delivery=skipped`。
这证明真实报告读取闭环，不证明所有代码审查都能通过。9 项链路与隔离核对通过；另核对了
相同 requestId 去重、wait 0 到期保留运行、完成后 wait 不超时，以及缺少来源、误传正文和非法等待值的拒绝。

两个临时终端、临时项目和仅本次产生的目录信任段已清理，原终端保留；临时源码未被 Agent 改动。
类型检查、CLI lint/构建、Skill 校验、文档检查与 diff 检查通过，未新增单元测试。

原始证据目录：`/var/folders/hp/bk0rp6xn3t5fsr5sf7n256rr0000gn/T/rw-review-skill-20261117-w3tzr0bl/evidence`。其中 summary.json、source-tool-calls.json、final-source.json、
final-reviewer.json、final-report.json 和 cleanup.json 分别保留核对、工具调用、双方原生结果、报告和清理记录。
未全局安装或发布；未重测有发现时的自动反馈分支、复审复用、Pi/Claude 发起端、重启及压力。

## 修复后的闭环复验（2026-11-17）

当前工作区真实试跑曾复现两处问题：CLI 等待期限未约束 HTTP 查询；报告证据分布在多条
同版已执行检查中时，被单检查覆盖规则拒收。已修复：正数等待期限取消在途查询且不再新增查询；
问题的每条证据仍须由同版已执行检查覆盖，允许多条检查共同提供。0 毫秒保持单次查询语义。

沿用原延迟响应案例验证：100ms 到期后不再发第二次查询，返回 waitTimedOut=true；
另验证首响应超时返回 null 状态、在途查询取消及正常完成，共 15 个 CLI 传输场景。
此前被拒的真实原始报告不改正文即可在隔离存储归档；未执行证据、错误指纹、未登记产物仍拒收。

在源码 fullstack Dev Session dvs-ad7b6a 中，原生 Codex 读取 review-agent Skill、调用新 CLI，
启动独立 Reviewer。临时项目故意引入 count 多返回 1 的错误；Reviewer 实际复现并提交问题，
报告入库成功，delivery=written，来源 CLI 读取了与磁盘一致的报告，且原生会话收到一次自动反馈
并明确确认。12 项链路核对通过。该样例的业务检查失败是预期结果，不是审查系统失败。

证据目录：`/var/folders/hp/bk0rp6xn3t5fsr5sf7n256rr0000gn/T/rw-review-fix-e6pxfboz`。
其中 report-replay-results.json、transport-results.json、inflight-results.json 和 evidence/summary.json
记录定向复验及完整链路。CLI/Backend 类型检查和 lint、架构、生命周期、定时任务运行验证通过；
定时任务验证清除了继承的安装态 worker 路径后执行。未新增单元测试，未更新全局安装或发布。
临时终端、项目和目录信任已清理；Dev Session 按专属生命周期停止，原有终端与安装态服务保留。
