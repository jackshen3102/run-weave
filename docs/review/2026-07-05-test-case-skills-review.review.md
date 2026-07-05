# 新增测试用例技能评审

评审对象：

- `plugins/toolkit/skills/write-test-cases/SKILL.md`
- `plugins/toolkit/skills/write-test-cases/assets/test-cases-template.md`
- `plugins/toolkit/skills/write-test-cases/references/coverage-checklist.md`
- `plugins/toolkit/skills/run-test-cases/SKILL.md`
- `plugins/toolkit/skills/write-plan/SKILL.md` 中新增的测试用例衔接说明

校验结果：

- `quick_validate.py plugins/toolkit/skills/write-test-cases` 通过。
- `quick_validate.py plugins/toolkit/skills/run-test-cases` 通过。
- 插件 manifest 使用 `skills: ./skills/`，新增目录会被插件发现。

## 结论

没有 P0/P1 阻断问题。两个技能的核心方向是对的：写用例和跑用例分离，浏览器/桌面验收必须真实取证，失败时不能静默改用例。这正好对应历史里反复出现的问题：用例没落盘、浏览器验证被静态检查替代、失败后扩大范围、以及没有从失败 case 继续。

## 发现

- **P2 `plugins/toolkit/README.md` 的已包含技能列表未更新。** README 声明本地插件是唯一规范来源，并列出已包含 skills，但当前列表缺少 `write-test-cases` 和 `run-test-cases`；新会话或维护者按 README 自查时会误判这两个技能未纳入插件。定位：`plugins/toolkit/README.md:1`、`plugins/toolkit/README.md:14`、`plugins/toolkit/README.md:33`。修复方向：把两个新 skill 加入“已包含的 Skills”，保持 README 与插件目录一致。

- **P2 `write-test-cases` 对既有用例格式的描述过于绝对，可能诱导重写大文档。** 技能说 `docs/testing/` 下用例共享同一套骨架，并要求“范围 / 当前代码事实 / 必跑命令 / 用例映射 / 验收通过标准”几节不能少；但现有文档实际有多种形态，例如 `app-server-event-center-test-cases.md` 是 `Scope / Commands / case` 结构，`terminal-panel-split-test-cases.md` 是大矩阵分层结构，`terminal-browser-playwright-mcp-test-cases.md` 是能力域矩阵。这个约束会让 agent 在补用例时倾向于改格式，而不是最小追加缺口。定位：`plugins/toolkit/skills/write-test-cases/SKILL.md:32`、`plugins/toolkit/skills/write-test-cases/SKILL.md:34`，对照 `docs/testing/app-server-event-center-test-cases.md:3`、`docs/testing/app-server-event-center-test-cases.md:13`、`docs/testing/terminal-panel-split-test-cases.md:40`、`docs/testing/terminal-browser-playwright-mcp-test-cases.md:56`。修复方向：把“固定章节”改成“必须包含的信息”，并明确补已有文档时优先保留原结构，只补可取证预期、失败判断、必跑命令和覆盖缺口。

## 我对好测试用例的评定

好的测试用例不是“测得多”，而是能把需求的真假变成可重复取证的判定。按这个仓库的历史，优先级应该是：

1. **需求可追溯。** 每个 case 能指回一个需求点、计划条目、历史 bug 或明确非目标；没有来源的 case 宁可不写。
2. **踩真实代码路径。** 写清入口、API、状态文件、环境变量、端口、隔离目录；不要只写“打开页面检查功能正常”。
3. **可取证。** UI 走 `$playwright-cli`，桌面联动走 `$computer-use`，后端/协议走 verify 脚本或临时 Node 脚本；每条都有可保存的 DOM、截图、接口响应、日志或文件内容。
4. **有失败判断。** 预期不是“正常展示”，而是“出现什么就算失败”；这能防止 agent 在失败时自我解释。
5. **边界少而准。** 优先覆盖会导致回归的边界：权限、隔离、重启恢复、并发串扰、迟到事件、旧格式兼容、错误态不写入状态。不要为“看起来全面”枚举无关输入。
6. **执行顺序清楚。** 必跑命令和 case 顺序明确，写清任一失败是否停止；后续修复时能从失败 case 继续，而不是重跑一大坨。
7. **范围收敛。** 如果用户只要求 `case_1/case_2`，用例和执行都不能扩成全量验收；如果文档已删 case，执行前必须重读当前文档。
8. **不把门禁当行为验收。** `typecheck`、`lint`、`git diff --check` 是前置门禁，不是 UI/行为通过证据。

这两个技能已经覆盖了第 2、3、4、6、8 点；建议补强的是 README 发现性，以及“保留既有文档结构”的约束，避免为了规范化而制造无关 diff。
