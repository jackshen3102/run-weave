# Mac Remote Host

- 独立 macOS 15+ 原生 App，采集与输入不进入 Backend / Electron；只依赖 Apple 框架与本地 Swift 协议包。
- 最终部署与权限验收使用 `build-host.sh` 产出的 `.app`。开发编译、签名、启动、授权、真实会话是不同证据层。
- 默认停用服务，用户本机点击启动后才监听所选物理 LAN IPv4 接口；配对不自动开始屏幕采集或输入。
- 不导入 launchd、公网端口映射、Tunnel、音频、剪贴板、文件或 shell 能力；不更改 TCC / SIP / AMFI。
- TLS 1.2+、精确证书 pin、有效期、唯一 trust anchor 与系统 SecTrust 评估缺一不可。长期身份和设备令牌仅存独立 Keychain service。
- 默认只读配对；本机用户分别批准观察/控制。撤销和停止立即失效会话，输入 lease 超时必须释放。
- 编码、发送与采集队列必须有上限。丢弃依赖帧后等待含 SPS/PPS 的 IDR；不得把 P 帧断链当成正常恢复。
- 不新增单元测试。手工协议探针用 ignored 输出目录；UI/真机验收由主 Agent 执行，未执行不得声称通过。
- 修改上游衍生文件同时维护来源与 MIT 许可。默认仅 Mirador 的本次精确 SHA 可进入导入范围。
