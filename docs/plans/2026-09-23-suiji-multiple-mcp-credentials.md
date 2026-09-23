# 随记多设备 MCP 凭据实施计划

日期：2026-09-23。粒度：L3（认证与数据库迁移）。状态：代码已实现、隔离验收通过；保留本计划用于尚未执行的发布与 Mac 原 token 验证。

## 当前现状与目标

`packages/suiji-server/scripts/mcp-credential.ts` 在客户端生成 32 字节随机 token，输出
`client.env`（原文）和 `server.env`（SHA-256 摘要、期限）。
`src/mcp/auth.ts` 只比对 `SUIJI_MCP_TOKEN_SHA256`，认证后查 singleton owner；
`src/mcp/router.ts` 以该配置是否存在决定开关，同时保护 `/mcp` 和 `/mcp/uploads`。
`src/index.ts` 当前只接受 schema 5。当前不存在多凭据管理能力，不能仅靠增添客户端配置解决。

目标：Mac、服务器 Agent 等各持独立 token；新增、到期或撤销某个 token 不影响其余设备，
日常注册和撤销不重启服务。原 Mac token 在原有效期内继续使用，迁移不要求知道原文。
本次会话曾短暂轮换线上凭据，随后已恢复原配置并核对运行容器，不能把本机生成但未启用的 token 当作可用凭据。

## 范围与用户行为

第一版交付数据库凭据登记、管理员 CLI、客户端生成/加载工具、迁移和发布支持。
用户在新设备生成凭据，把只有摘要的登记文件交给服务器管理员注册，再在设备加载本地原文。
管理员按凭据 ID 查看与撤销；名称仅帮助识别，不能证明实际设备身份，也不作为唯一键。
列出名称、ID、创建/到期/最近使用时间和状态，不显示原文或摘要。

本期不做 Web/iOS 管理界面、OAuth、设备自动配对、细粒度 scopes、多 owner、自动同步 token、
自动续期或自动撤销旧凭据。所有有效 MCP token 沿用现有 owner 的 MCP 业务权限。
不向 MCP 工具集添加签发或管理凭据的工具；App 登录、十个业务工具、actor 与业务幂等语义保持兼容。

## 合同与安全边界

### 存储

追加迁移 `packages/suiji-server/migrations/1790150400000-mcp-credentials.cjs`；执行前核对时间戳未冲突且为下一条，禁止修改已执行迁移。
当前基线目标为 schema 6；若实施前已有迁移，按实际下一版同步全部版本判断。

新增 `mcp_credentials`：

| 字段         | 合同                                                 |
| ------------ | ---------------------------------------------------- |
| id           | UUID 主键，由客户端生成，登记重放的稳定标识          |
| owner_id     | 必填，外键 owners(id)，由服务端 singleton owner 决定 |
| name         | 去首尾空白后 1–80 Unicode 标量，允许重名             |
| token_sha256 | 64 位小写十六进制，唯一，不对外列出                  |
| created_at   | 服务端 timestamptz(3)                                |
| expires_at   | 必填 timestamptz(3)，不可通过重复登记延长            |
| revoked_at   | 可空 timestamptz(3)，非空即不可恢复                  |
| last_used_at | 可空 timestamptz(3)，精度一分钟，非实时审计          |
| source       | generated 或 legacy-import                           |

不存原文、不硬删除凭据，以保留撤销墓碑。状态计算优先级为 revoked、expired、active。
数据库角色授权随已有迁移策略核对，API 不获得迁移凭据。

### 本地生成与管理员 CLI

扩展现有 `mcp:credential`，保留 token 的 43 位 base64url 格式及默认 90 天、可选 1–365 天期限。
多凭据路径采用 `--name`、`--server-id`、`--owner-id`、`--output-dir`，输出：

- `client.env`：原始 token，仅新建 0700 目录内的 0600 文件，不打印原文。
- `registration.json`：`version:1, serverId, ownerId, id, name, tokenSha256, expiresAt`；只含摘要。
- 成功标准输出只含生成路径、ID、有效期；失败不得覆盖旧文件或隐式注册。

旧版生成流程只在显式 legacy 模式保留，默认不再引导用户覆盖 deployment env。
新增 `scripts/mcp-credentials.ts`，打包为 `dist/mcp-credentials.js`，容器入口新增 `mcp-credentials`，
使用现有受保护管理员数据库连接，命令参数只包含动作和非敏感 ID；JSON 经标准输入传入。
所有 JSON 严格拒绝未知字段，身份与数据库实际 serverId/ownerId 必须一致。

| 动作          | 输入与行为                                                          | 输出与错误                                                            |
| ------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------- |
| register      | 标准输入 registration.json；未来期限不超过当前时间 365 天；事务登记 | 新增返回 created:true；同 ID 且同不可变字段原样重放返回 created:false |
| list          | 无原文输入；列出全部凭据，按创建时间和 ID 稳定排序                  | 仅元数据与计算状态，ISO UTC 时间                                      |
| revoke        | `--id UUID`；仅更新该 owner 的该凭据，重复执行保持成功              | 返回 ID、revokedAt；不存在返回 NOT_FOUND                              |
| import-legacy | 标准输入受保护 JSON，含身份、名称、原摘要与原期限；不传原文         | 返回导入 ID；按唯一摘要幂等；不得刷新期限或清空撤销时间               |

ID 或摘要被不同登记数据占用返回 CREDENTIAL_CONFLICT；撤销或过期 ID 不能通过 register 复活，
返回 CREDENTIAL_INACTIVE。输入错误 INVALID_INPUT，身份错误 IDENTITY_MISMATCH，均非零退出且无写入。
import-legacy 允许导入已到期摘要但保持 expired；遇到已有同摘要只接受同 owner/期限的幂等导入，保留原元数据和状态。
并发 register 由唯一约束和事务确定结果；未知提交结果用同一 registration.json 核对/重放，不重新生成凭据。
凭据轮换定义为注册新 ID → 验证新设备可用 → 明确撤销旧 ID；没有全局覆盖操作。

### 请求鉴权

新增 `SUIJI_MCP_ENABLED` 布尔配置，默认 false；false 时 MCP 与上传均返回 404 MCP_DISABLED。
true 时每次请求摘要查询凭据表，要求匹配 owner、未撤销、`expires_at > clock_timestamp()`。
不存在、格式错误、撤销、到期、App token 均返回统一 401，不暴露匹配状态。
数据库故障返回通用 503，不回退旧环境变量、不放行、不泄露连接信息。
保持 Origin 拒绝与 POST-only 合同；权限检查仍先于上传读取和业务执行。

认证返回内部 `{ownerId, credentialId}`，业务 actor 继续为 agent；不可让 token ID 改变业务幂等空间。
无长期正向认证缓存；撤销事务提交后开始鉴权的新请求必须失败，提交前已通过鉴权的在途请求允许完成。
最近使用时间只在成功鉴权后、距离上次至少一分钟时更新，采用条件 UPDATE 并保持时间单调；更新失败不放宽鉴权，
仅记录脱敏运维事件。它表示最近成功认证，不代表业务操作成功，不记录每次业务动作。

旧环境变量不再参与鉴权，也不在启动时自动导入，避免撤销后重启复活旧 token。
升级时发现旧摘要配置却未完成同摘要/期限导入，应在发布预检失败并停止切换；
运行时遇到残留旧配置给出不含值的迁移错误，要求移除旧两项配置，避免看似启用却全部 401。

## 分步实施与交付门禁

- [x] **1. 数据与管理命令。** 新增迁移、`src/mcp/credentials.ts`（登记/列举/撤销/导入服务）和
      `scripts/mcp-credentials.ts`；扩展 `scripts/mcp-credential.ts`、`scripts/build.mjs`、`package.json`。
      先在隔离 PostgreSQL 验证唯一约束、重复登记、撤销墓碑；原文不得进入服务端。
- [x] **2. 认证接入。** 修改 `src/mcp/auth.ts`、`router.ts`、`config.ts`、`index.ts`，复用凭据服务。
      以新表为唯一凭据来源；两把 token 均可请求 `/mcp` 和 `/mcp/uploads`，撤销其中一把不影响另一把。
- [x] **3. 容器和发布。** 修改 `deploy/suiji/entrypoint.mjs` 转发管理命令参数；修改 `compose.yaml`、
      `.env.example` 引入开关；扩展 `release.mjs` 迁移预检和旧摘要导入编排。
      必须沿用当前 project、实际 compose 文件列表及 override、不可变镜像、数据卷、普通 API 角色。
      不允许只用仓库默认 compose 覆盖当前线上低内存等配置。
- [x] **4. 备份与恢复。** 修改 `deploy/suiji/backup.mjs`、`release.mjs` 的 schema 条件核对，
      增加凭据数量与按稳定字段生成的校验摘要（包括撤销状态，不包含原文；last_used_at 在静止窗口核对）。
      保留 schema 5 备份的读取兼容；恢复隔离环境默认 MCP 关闭。明确旧备份可能让备份后撤销的 token 重新有效，
      生产恢复必须先核对恢复点后的撤销记录，无法核对时先全量撤销恢复的凭据，再重新登记客户端摘要。
- [x] **5. 客户端接入。** 更新 `plugins/toolkit/skills/suiji/scripts/suiji.py`、`SKILL.md`、
      `references/api.md`，说明配置发现与受保护 env-file 加载方式；保留已有 tokenEnv 配置兼容。
      增加显式 `--env-file` 本地加载入口，要求文件 0600、核对配置身份后才联网；不通过 shell source 执行文件内容。
      只向配置指定的 HTTPS 服务发送 token；环境变量与文件同时存在且内容冲突时拒绝，禁止默默选旧凭据。
      同步 `packages/suiji-server/AGENTS.md` 的旧“轮换通过服务配置”规则，以及该包 README、部署 README 和架构说明。
- [x] **6. 验证与交付。** 执行下述检查与 YAML 用例，保留脱敏证据；提交本需求文件，
      如本地有其他改动不得一并提交。没有提交/合并或生产部署授权时停在可审阅产物，不自动发布。

若后续增加 App 管理接口，其 DTO 进入 `packages/shared/suiji` 并单独计划 UI；本期管理合同只在服务端 CLI 使用，
不引入跨运行时依赖，不改原生 Swift DTO。

## 兼容迁移与生产发布顺序

1. 只读确认目标 serverId/ownerId、当前镜像/schema、Compose project 与全部 override、现有摘要/期限。
   由 Mac 持有人在本机做旧 token 只读探测，保留脱敏结果；无法取得这项证据时不得宣称 Mac 兼容已验证。
2. 使用既有发布锁、静止窗口和有效异机备份；备份验证失败则不迁移。允许一次部署维护窗口，
   “不影响其他设备”指不让凭据失效，不承诺本次 schema 发布零停机。
3. 停旧 API 后追加迁移；管理员用旧摘要和原期限执行 import-legacy，标记名称“迁移的原有凭据”。
   不能假定它只由 Mac 使用；不续期、不生成替代 token、不需要复制 Mac 原文。
4. 确认导入记录、身份与期限完全一致后，准备 `SUIJI_MCP_ENABLED=true` 并移除旧两项配置，启动支持新 schema 的镜像。
   配置旧 MCP 关闭的部署保持 false，禁止迁移隐式打开服务。
5. Mac 持有人再次用原 token 只读探测；新服务器 Agent 本地生成独立凭据，注册摘要并读取同一服务身份。
   在专用测试记录上验证双设备与撤销隔离，不以用户真实记录作为破坏性测试 fixture。
6. 更新各设备的本地连接路径说明；当前机器之前生成但未登记的文件明确保持 inactive，禁止误当成有效连接。
   新设备登记成功后不再需要服务器重启；服务端不保留 client.env。

迁移前失败：保留原镜像、配置与 token。迁移提交后失败：保留新 schema 数据，使用兼容 schema 的修复镜像；
当前旧镜像仅支持 schema 5，不能直接回退启动。不得自动 down/drop 表或恢复旧备份覆盖在线新数据。
确需恢复旧备份时单独确认停写窗口和恢复点的数据损失，并处理撤销状态回退风险。

## 验收与验证

本轮配套的 [多凭据验收计划](../testing/suiji/mcp-credentials.testplan.yaml) 已在隔离 PostgreSQL 18.6 和真实服务中执行，13 条通过。
各 case 自建隔离 fixture，重点覆盖旧摘要迁移、多设备并存、撤销、期限、登记幂等、重启与恢复。
继续执行 [MCP 既有合同](../testing/suiji/mcp-agent.testplan.yaml) 的业务回归；实施时同步其旧配置前提，
用例 001/002/003/008/010/012 为必需回归，验证默认关闭、入口隔离、工具表、幂等、附件和期限。

实施后的静态门禁：

```bash
pnpm --filter @runweave/suiji-server typecheck
pnpm --filter @runweave/suiji-server lint
pnpm --filter @runweave/suiji-server build
pnpm testplan:validate docs/testing/suiji/mcp-credentials.testplan.yaml
pnpm docs:check
```

所有命令退出 0；真实行为必须按 YAML 在独立 PostgreSQL 和实际 MCP 请求中取证。
不新增单元测试，不用格式检查代替认证验收。最终交付必须明确“静态检查 / 隔离行为验收 / 生产设备验证”各自结果。
本轮已实现并完成 typecheck、lint、build、YAML 校验和 docs:check；13 条多凭据用例通过，
另通过原有 MCP 合同 001/002/003/008/010/012，其中协议调用使用官方 MCP SDK。
备份恢复用例执行了真实 pg_dump/pg_restore 和凭据状态核对，不等于完整 release.mjs 发布验收。
完整 Compose v2 + 真实异机备份发布、AWS 升级和 Mac 原 token 验证尚未执行；当前环境仅有 Compose v1，
没有本任务专用的真实异机备份目标。本轮未修改 AWS；当前无有效生产 MCP token，不能向随记追加最终成果。
发布之前必须逐项完成上文生产发布顺序，不能将隔离验收当作线上已升级。
