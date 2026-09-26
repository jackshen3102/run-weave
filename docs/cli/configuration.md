# 实例配置 CLI

统一配置实现位于 `packages/config-node`，跨端合同位于
`packages/shared/src/configuration`。当前处于全仓迁移实施阶段；已安装 Stable 尚未切换。

正式实例默认使用 `~/.runweave/settings.yaml`；测试实例使用
`~/.runweave/dev-sessions/<id>/settings.yaml`。文件为 YAML 1.2 单文档，目录必须为
0700，配置及备份为 0600。旧 `config.json` 仅作显式迁移来源，不与 YAML 同步。

## 查询

```bash
rw config path --instance stable --json
rw config keys --json
rw config show --instance stable --json
rw config validate --instance stable --json
rw config doctor --instance stable --json
```

`path` 默认只输出文件路径，`--json` 同时返回实例身份与配置根。其他配置命令默认输出可读的结构化结果，脚本可显式使用 `--json`。`show` 只输出脱敏值。`keys` 列出注册字段的类型、敏感标记、远程修改权限和生效方式。
`doctor` 额外列出当前权威 YAML、发现的旧来源文件、父进程里存在的旧环境键名和 cwd 中是否有 `.env`；不读取或输出旧环境值。键名只表明检测到潜在迁移来源，不能据此断定运行时的端口等启动上下文也被忽略。
无目标只读查询默认定位 Stable；来自 Dev Session 的冲突上下文会被拒绝。

## 写入

所有写操作必须带 `--instance stable|<dev-id>`。`--config-dir` 只能是绝对路径；
Dev 路径必须与该实例目录一致，已登记 Stable 根不能通过另传目录绕过。
Dev Session 终端里的绑定 `rw` 会先校验会话身份，再代入本实例目标；进入嵌套
`zsh -l` 后仍使用该入口。绕过绑定入口的命令须自行指定 `--instance`，绑定目标
与显式目标不一致时拒绝。

```bash
rw config set voice.transcription.language --value-file /private/path/value.json --instance stable
rw config import --file /private/path/settings.yaml --instance stable --dry-run
rw config import --file /private/path/settings.yaml --instance stable
rw config import-env --instance stable --dry-run
rw config reload --instance stable --profile local --json
```

`set` 的值文件是单个 JSON 值，例如字符串 `"zh-CN"`；`--value-file -` 从 stdin 读取。
完整配置文件使用 YAML。不要把凭据直接写进命令行或共享文件。
并发编辑者可同时传 `--expected-revision` 和 `--expected-digest`；任一不匹配都会拒绝写入。
即使手工编辑只改变注释、没有改变 revision，摘要冲突也会阻止覆盖。

`import-env` 是显式的一次性导入，运行服务不会继续把这些业务环境变量作为配置来源。
同一字段的多个旧别名值不一致时拒绝导入。远端写入和认证操作还会核对 Backend 实例握手。

保存成功报告 `savedRevision` 和 `restartRequired`，不代表运行中的消费者已经加载。
`reload` 通过当前 profile 调用 Backend，由各消费者分别报告 appliedRevision、error、
unconfigured 或 restartRequired。坏文件保留原件，不自动生成替代配置。

## 全新 Stable 初始化

只有确认此操作系统用户从未有过需要保留的 Runweave 身份和数据时，才执行：

```bash
umask 077
$EDITOR /private/path/new-runweave-auth.json
rw config init --instance stable --auth-file /private/path/new-runweave-auth.json --dry-run --json
rw config init --instance stable --auth-file /private/path/new-runweave-auth.json --confirm-new-install --json
```

认证文件只含 `username` 与 `password` 两个字符串，必须为本用户拥有的 0600 普通文件；
密码至少 16 个字符。工具生成独立 JWT 密钥并保存到 YAML，不在输出中展示凭据。
初始化成功后删除这份一次性输入文件；运行服务只读取 settings.yaml。
预览展示目标路径和脱敏字段，不写入；提交只允许创建尚不存在的 Stable 文件，
已发现旧 CLI、分享、飞书或历史 Browser Profile 身份数据时拒绝并提示使用 `migrate`。
其他旧 Backend/Desktop 数据须先通过迁移草稿选定来源；`--confirm-new-install` 表示操作者
已核对这些来源并确认可以建立全新身份。Desktop 首启也会检查同一实例文件；发现旧来源时只提示迁移，真正全新安装才展示本机初始化表单。Desktop 首启交互仍需独立测试用户的安装态验收。

## 迁移

```bash
rw config migrate --source-manifest /private/path/sources.json --instance stable --dry-run --json
rw config migrate --source-manifest /private/path/sources.json --instance stable --json
```

来源清单是数组，每项包含绝对 `file`、目标 `domain`、`format: json|env`。
同一域不同来源必须先明确选择，不自动拼接凭据。迁移保留私有来源备份，并把来源摘要和
迁移标记写入同一个 YAML 提交；已迁移域再次执行不会重新读取旧来源。

默认仅发现当前配置根下的旧 CLI `config.json`、`snapshot-share/publish.env` 和
`feishu_notify.env`。通过 `--backend-profile <绝对目录>` 选择认证、推送和模型配置的
旧 Backend profile，通过 `--desktop-data <绝对目录>` 选择桌面认证、隧道、浏览器和伴随窗口来源。
选择 Backend profile 时还会保留原数据库、终端、日志等存储路径，不移动数据。
Dev 来源必须位于自身目录；同域来源冲突需要使用来源清单明确选择，不能自动挑最新文件。
其他域须提供归属明确的来源清单，默认发现不等于全仓迁移完成。

发布产物声明支持的 YAML schema 和域版本。受管安装/回退在切换程序前检查兼容性；
缺少声明的旧程序不能直接用作新 YAML 的恢复目标。该检查不会恢复或覆盖配置文件，
也不能约束用户手工运行历史二进制。

## 显式恢复备份

```bash
rw config backups --instance stable --json
rw config restore <backup-id> --instance stable --dry-run --json
rw config restore <backup-id> --instance stable \
  --expected-revision <preview-revision> --expected-digest <preview-digest> \
  --expected-backup-digest <preview-backup-digest> --json
```

预览只列出变化字段、源/目标 schema 和摘要，不输出凭据值。执行时必须携带预览中的三个
版本参数；当前文件或备份在预览后发生变化就拒绝恢复。备份只能来自本实例私有备份目录，
且必须通过当前工具的 schema 与域版本校验；不能传任意外部路径或跨实例备份。

恢复保留备份中的配置和注释，将 revision 单调递增，并把恢复前的完整文件另存为私有备份。
即使当前文件使用较新的整体 schema，也只检查身份和版本元数据来生成恢复预览，不解释其
未知业务字段。语法已损坏、无法核对身份的当前文件仍拒绝自动恢复，原件保留。
恢复结果是待重启；它不会自动切换二进制或启动服务。继续使用受管更新入口核对目标程序兼容性。
