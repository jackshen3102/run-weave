# 恢复故障验证

`pnpm recovery:verify` 使用临时目录、独立子进程和 worker 验证 PR #651 的两项修复。
不读取正式数据库或日志，不启动已安装 runtime，不写单元测试或引入测试框架。
需要当前 workspace 的依赖；三项运行验证中的两个 App Server 入口会先构建产物。

```bash
pnpm recovery:verify --output .runweave/recovery-verification/after
pnpm app-server:verify
pnpm app-server:verify-state-sync
pnpm backend:verify-lifecycle
```

输出目录保留每项子进程日志和 `results.json`，包含源码提交、验证脚本摘要、Node 版本和
每项结果。临时配置、合成数据和 fixture 进程在完成后回收；配置 owner 的测试使用私有
settings；运行门禁的子进程还隔离用户目录，App Server 使用 fixture Codex，避免读取
真实 Agent 会话、启动已安装 Codex、注册正式 root 或接触已有 tmux。

Activity 的六项为退出码 0、非零退出、worker error、请求不响应、带未完成记录的关闭、
初始化不响应。检查当前/后续请求的拒绝、动态 runtime health、幂等关闭及期限。
退出测试使用真实 worker 中的故障入口，不主动终止正式 worker。

日志的十项为启动/runtime 两个阶段各执行：截断后进程退出、部分写入失败、rename 前退出、
rename 后退出及成功重写。随后启动真实 App Server，用鉴权 HTTP 比较保留事件的完整内容、
无重复 ID、完整重放后的 thread 状态、云同步镜像，以及所有已确认成功的并发追加。
runtime 成功路径检查 20 次追加；部分写入失败路径检查另外 19 次已确认追加。

对照修复前源码时，在同一父项目的 `.worktree/` 下准备隔离 checkout，并提供其绝对路径：

```bash
node scripts/verify/recovery/run.mjs \
  --repo /absolute/project/.worktree/recovery-before \
  --expect-regressions \
  --output .runweave/recovery-verification/before
```

PR #651 的父提交为 `7a7d0c9a83ee0f1a86ef1edf72a5f5efe3ce96f9`。
该模式要求复现六项 Activity 失败和四项日志数据损失；旧实现没有 rename 边界，所以对应
四项明确记录为 unsupported，不能计作通过。两项正常重写仍应成功。默认模式要求全部
16 项通过，且每个修复后的故障边界确实触发。对照运行复用同一套脚本和依赖版本。

三个旧运行验证入口已迁移到 settings fixture：重复配置 owner 按当前合同返回退出码 1
和 `CONFIG_INSTANCE_ALREADY_RUNNING`，并确认首实例的 lock 和健康状态；state-sync 将假
Codex binary、会话目录和轮询间隔写入 settings；Backend 重新打开实际设置选择的数据库。
源码 App Server 的构建产物仍通过 workspace 的 tsx resolver 加载源码导出的 config-node。
这些通过结果不证明裸 `node app-server/dist/index.js` 的分发依赖解析已修复，也不证明
硬件断电耐久性、自动 worker 重启或整个 Backend 的有界关闭。
