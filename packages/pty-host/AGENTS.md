# PTY Host

独立的本机终端所有者。Backend 连接释放不能关闭 PTY，显式 close 才结束会话。

- 跨进程合同在 `@runweave/shared/terminal/pty-host`，不得依赖 Backend 业务实现。
- Host、输出镜像和输入序列拥有独立生命周期；输入确认不表示 Agent 执行完成。
- 本机管道和 gateway 都要验证实例及凭据；凭据不进入日志、公开 DTO 或命令行。
- 复用不可变发行目录；普通 Backend 更新不能覆盖 Host 正在加载的原生模块。
- 不新增单元测试，使用 `scripts/verify/server/pty-host.mjs` 的真实进程和 Windows ConPTY 验证。
- 修改后执行本包 typecheck/lint，并完成对应 Windows 进程集成验收。
