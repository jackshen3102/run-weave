---
name: publish-runweave-server
description: 发布 Runweave Server 与 CLI 的 npm 新版本：准备版本、提交发行代码、触发 GitHub Actions、处理失败并核对公开包与安装验收。用于“发布服务端新版本”“发 npm 包”；已有机器升级使用 update-runweave-backend，不因发布而重启服务器。
---

# 发布 Runweave npm 版本

将明确的源码提交发布为可安装的 npm 发行版。发布目标是 registry；部署到某台机器是另一个操作。
用户同时要求发布和升级时，先完成本流程，再按目标机器执行 `update-runweave-backend`。

## 入口与版本选择

在 Runweave 仓库读取 `AGENTS.md`、`docs/deployment/npm-server-operations.md`、
`docs/cli/server-cli.md` 及 `.github/workflows/server-release.yml`。
仓库可由当前目录、Git remote 或用户指定路径识别；不要把缓存中的 skill 目录当成项目。
使用实际 workflow 与脚本，不在本机重写一套发布步骤。

- 确认待发布改动、源码基线和 Git 状态，保留无关工作。发布请求包含完成发行所需的版本修改、
  提交与 CI 操作；不自动包含尚未确认的其他功能或生产机器部署。
- 查询 npm 的已发布版本、dist-tags 和正在运行的发行任务。记录准备发布的 Server/CLI 精确版本、
  channel 与对应源码，不从旧聊天记录推断 registry 状态。
- 用户指定版本或 channel 时遵从。未指定时，兼容修复默认选择新的 patch 版本并发布到 `latest`，
  先向用户说明选择；不重复询问已授权的发版。涉及不兼容升级或候选范围不明时先明确缺口。
- 当前整套工作流发布六个包：Server 主包、四个平台包、独立 CLI。Server 与平台包版本一致；
  CLI 独立编号，但这条整套发行要求 CLI 也使用新版本。仅发 CLI 是不同范围，不能擅自捆绑 Server 发版。
- 已存在的版本不可覆盖。计算新版本时同时核对源码和 registry，不能把旧 `latest` 当成最大已占用版本。

## 执行发行

1. 更新两个 package.json 的版本；若工作流或打包代码有变化，执行其明确要求的验证。
   保留已有 commit/push hook 和远端门禁。通过项目正常 PR 流程将发行提交合入主分支，
   不跳过失败检查或人工要求的评审。确认远端合并提交后再创建发行标签。
2. 按运维文档推送与 Server 版本严格匹配的 `server-vX.Y.Z` 标签，默认触发正式发行。
   若请求 `next`，使用 `workflow_dispatch` 的 `publish=true, channel=next`。
   记录 run ID 和 head SHA；创建、推送或触发结果不明确时先查询远端，避免重复操作。
3. 跟进四个平台构建、自更新验证、全套 artifact 校验、OIDC 发布、公共 registry 安装/登录验证和标签提升。
   发布 job 从本次 CI artifacts 取包，不使用本机重打的 tarball 替代。
4. 失败先读具体 job、日志和 release receipt。确认本次实现缺陷时修复并走正常提交过程；
   外部权限或 npm 扫描未完成时保留准确状态。不要用本机 `npm publish` 绕过一个失败的 OIDC 链路并称其自动化成功。
5. 部分包已上传时，优先解决问题后 Re-run failed jobs，复用同一次构建的 artifacts。
   同版本只有摘要完全相同才能继续。若必须改代码或重新构建且旧版本已发布，选新版本重新发行，
   不覆盖版本、强改摘要或自动删除公开包。

首次可信发布配置按运维文档逐包绑定 repo、workflow、environment 和允许的操作；
新包需先完成首次发布。首次身份认证属于初始化，日常工作流使用 OIDC，无需长期写 token。
`Pending validation` 只是配置保存，必须实际发布成功才能确认可用。
不为省浏览器验证而关闭账号 2FA。权限拒绝时说明具体包和缺失权限，继续不依赖它的准备工作。

## 完成判据

同时核对目标 run 成功、最终回执 `phase=complete`、六个包的版本/摘要及请求的 dist-tag，
四个平台从公共 registry 安装后的服务和登录验证通过。需要重试时，保留每次 run 的来源关系。

交付写明 Server/CLI 版本、channel、源码提交、工作流链接和未覆盖项。
包验证不代表真实用户 UI 或生产机器升级已完成。用户只要求发布时，到此结束；
用户也要求升级时，将已核验的两个精确版本交给机器升级流程，不再次解析可能变化的 latest。
