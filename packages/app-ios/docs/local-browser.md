# 电脑本地网页预览

iOS 17 及以上可从 Runweave 终端链接菜单打开当前电脑的 `localhost`、127/8、`::1` 和
`.localhost` 服务。服务仍可只监听电脑回环地址；手机只需能连接所选 Backend。
普通私网地址仍由手机直接访问，`172.0.0.1` 不属于回环地址。

手机 WebKit 不会为字面回环主机使用公开代理 API，因此页面转换到随机 `.localhost` 预览域名。
路径、query、fragment 保留；已有 `.localhost` Workspace Service 保留其 Host。
更多菜单复制原服务地址，外部浏览器不具备此通道。页面会提示临时数据与兼容限制。

使用相对资源/API，以及从页面位置推导的 WebSocket/HMR。硬编码 localhost、跨本地端口、
原 origin 登录回调或服务端 allowedHosts 限制需要由站点调整；Runweave 不重写页面脚本、CORS 或 Origin。
内容规则阻止预览页的回环资源误连手机，仅当前预览 host/port 可通过原生 CONNECT。

HTTP 上游按原字节转发。HTTPS 上游由电脑 Backend 校验原 URL host 和证书，信任库属于 Node，
不是手机；页面仍运行于 HTTP 预览 origin，Secure Cookie、原 secure context 等不保证兼容。
不忽略证书错误。手机与 Backend 的传输采用已有连接协议，公网连接需使用 HTTPS/WSS。

## 实现与隔离

- [宿主注入](../Sources/RunweaveIOS/State/AppSession+Browser.swift)：当前连接和终端产生 BrowserContext；随记不注入此能力。
- [原生转发](../Sources/RunweaveIOS/Services/BrowserLocalTransport.swift)：随机手机回环端口与每页临时 Basic 凭据；每条 CONNECT 对应一个认证 WS，不重放业务请求。
- [共享浏览器 lease](../../browser-ios/Sources/RunweaveBrowser/BrowserLocalPreview.swift)：创建 WebView 前配置 proxy 与非持久网站数据；无 App API、凭据或网页原生桥。
- [Backend owner](../../../backend/src/browser-local/service.ts)：不解析任意 DNS，只连回环目标；通过现有资源域释放出站连接。
- [共享合同](../../shared/src/browser/local-tunnel.ts)：版本 1；`GET /api/browser/local/capabilities` 与 `/ws/browser-local`。

WS 使用活跃原生 App Bearer，并遵循已有入口认证；拒绝网页 Origin 和查询参数。
首帧绑定终端、网页会话、host、port、secure，每连接只开一个目标。32 个并发、64 KiB 数据帧、
1 MiB 积压上限，双向背压和 eof。5 秒首帧超时、10 秒 TCP 超时，每 5 秒重新验证来源；
Backend ping/pong 检测失联。`RUNWEAVE_BROWSER_LOCAL_ENABLED=0` 禁用能力，旧 Backend 返回兼容提示。

收起保留同一页面；关闭、替换、退出来源会先关闭 listener/WS，再按既有屏障卸载文档。
各本地会话使用独立非持久存储，不与普通网站、另一电脑或随记共享 Cookie。

## 验证入口

[页面合同](../../../docs/testing/app/ios-local-browser.testplan.yaml)、
[授权与生命周期](../../../docs/testing/app/ios-local-browser-lifecycle.testplan.yaml) 与
[可运行 fixtures](../../../scripts/verify/browser-local/README.md)。
Simulator 共享 Mac 网络，不能证明真机回环转发。构建、协议集成与原生入口分别记录结果。
