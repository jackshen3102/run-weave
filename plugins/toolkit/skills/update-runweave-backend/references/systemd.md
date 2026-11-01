# Linux 服务托管检查

用于 npm 部署和旧部署迁移；程序安装遵循 Server CLI，不使用独立源码安装器。

## systemd：识别、修改和验证

先用只读查询识别具体 unit；下列命令针对已确认的系统级 unit，用户级命令须在实际服务用户的 manager 中加 `--user`：

```bash
systemctl list-unit-files --type=service --no-pager
systemctl list-units --type=service --all --no-pager
systemctl show <unit> -p FragmentPath -p DropInPaths -p User -p Group \
  -p Type -p MainPID -p ActiveState -p SubState -p UnitFileState \
  -p Restart -p NRestarts -p KillMode -p Result
```

随后定向读取 unit/drop-in 的 ExecStart、WorkingDirectory、配置及依赖，过滤敏感值。即使 unit 未运行也要纳入盘点；同一机器可有多个实例，不把其中一个的健康当成全部健康。

需要补齐托管时：

- 系统级 unit 优先沿用原服务用户，设置实际 `User`/`Group`、绝对 Node/入口路径、可访问的 WorkingDirectory、HOME 和必要 PATH。实例参数显式写入，不能依赖交互 shell 的 nvm 初始化或当前目录；不为了安装方便把业务改为 root 运行。
- 持续运行的 Node 入口采用 `Type=simple` 或目标 systemd 支持的 `Type=exec`，配置有退避的 `Restart=on-failure`，启动后另做健康等待。仅 `After=` 表示排序，不能证明上游可用，也不会自动拉起上游；按实际拓扑选择 Wants/Requires 与应用重连，避免给可降级依赖制造硬性级联停服。
- Backend 为保留终端进程需要 `KillMode=process`，且旧进程确实采用 tmux `preserve`。该例外不复制到其他 daemon；不要附加清理全部 tmux 的 ExecStop。尊重定时任务排空所需的停止时间，不能用短超时强杀来获得重启成功。
- 系统级服务通常由 `multi-user.target` 启动；用户级服务通常由 `default.target` 启动。用户级跨登出/开机运行还需要目标用户的 linger，先查 `loginctl show-user <用户> -p Linger`，在本次授权和系统权限内按需 `loginctl enable-linger <用户>`。只执行 `systemctl --user enable` 不能证明未登录时会启动。
- 写入前保留原文件并用 `systemd-analyze verify <候选 unit 路径>` 校验；使用正确 manager 的 `daemon-reload`，对本次应启用服务执行持久 `enable`，再按依赖启动/重启。已有 enable/mask/停用意图逐项核对，不批量 unmask、enable 所有匹配项。
- 若已有 supervisor/Compose 可满足持久运行，先沿用并检查其开机入口与恢复策略。迁移 manager 前准备具体文件、明确唯一 owner 和回退路径；采用 npm 产物不要求替换已经正常工作的 supervisor。

systemd 语义参考：[服务类型与进程跟踪](https://github.com/systemd/systemd/blob/main/man/systemd.service.xml)、[用户 linger](https://github.com/systemd/systemd/blob/main/man/loginctl.xml)。执行时同时核对目标机器安装版本的帮助。

## 停止条件与恢复

发现目标不明、控制通道会随服务消失、必需产物未准备好、配置无法兼容、旧任务无法安全排空时，先完成不依赖该条件的准备，再报告具体缺口；不要通过停用鉴权、删除数据/锁、杀端口占用者或强制 Git reset 来继续。

有安全回退条件时恢复原发布入口和 unit/drop-in，reload 后按依赖启动，再重跑实际健康与业务检查；保留失败候选及诊断证据。配置/schema 不兼容时不能把“切回旧包”称为已恢复。更新中断后重新读取实际指针、unit 和 owner，以现状继续，不凭上次日志重放整套操作。
