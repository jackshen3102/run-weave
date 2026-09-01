# Whistle Rules For `app.example.com`

这份文档用于把 `https://app.example.com` 的页面流量转到当前 Browser Profile
配置的本地开发服务，同时保留业务 API 等线上路径继续直连线上。

Runweave 会为每个 Profile 维护保留 Value `runweave-dev-server`，值为当前绑定的
`127.0.0.1:<dev-server-port>`。Rules 由用户在各 Profile 的 Whistle 控制台中维护，
Runweave 不会自动创建或覆盖。

## Expected Result

- 页面和静态资源的 GET 请求默认走 `runweave-dev-server`
- 非 GET 请求继续走线上
- 以下路径继续走线上，不被本地代理接管：
  - `/api/`
  - `/vibe/`
  - `/s/`
  - `/passport/`
  - `/sign/`
  - `/auth/callback/`
  - `/v1/api/`
  - `/base-agent/api/`
- HMR WebSocket 只代理 `/rsbuild-hmr`，不要扩大到整个域名

## Recommended Rules

在每个需要使用本地开发服务的 Profile 中添加同一份规则：

```text
line`
https://app.example.com/
host://{runweave-dev-server}
includeFilter://m:get
excludeFilter://app.example.com/api/
excludeFilter://app.example.com/vibe/
excludeFilter://app.example.com/s/
excludeFilter://app.example.com/passport/
excludeFilter://app.example.com/sign
excludeFilter://app.example.com/auth/callback
excludeFilter://app.example.com/v1/api/
excludeFilter://app.example.com/base-agent/api/
`

line`
^wss://app.example.com:*/rsbuild-hmr
host://{runweave-dev-server}
`
```

## Why These Rules

- `host://{runweave-dev-server}` 只替换上游地址并保留原始请求路径；切换
  Worktree 的 Dev Server 端口时只需由 Runweave 更新 Value。
- `includeFilter://m:get` 保证页面和静态资源走本地，同时让写请求继续走线上。
- `^wss://app.example.com:*/rsbuild-hmr` 能匹配 Rsbuild 生成的带端口 WSS 地址，
  例如 `wss://app.example.com:3000/rsbuild-hmr`。
- WebSocket 只代理 `/rsbuild-hmr`，范围足够小，不会误伤站点上其他线上 WS 连接。

## Do Not Do This

不要默认加整站 WebSocket 代理，例如：

```text
wss://app.example.com ws://127.0.0.1:3000
```

原因：

- 会把 `app.example.com` 下所有 WebSocket 都转到本地
- 很容易影响本应继续走线上的连接
- 问题定位会更难，因为影响面太大

如果后续确实需要代理其他 WebSocket，也只增加具体路径规则，不要代理整个域名。

也不要使用不带协议和端口通配的 HMR pattern：

```text
app.example.com/rsbuild-hmr
```

Whistle 2.10.9 不会用它匹配 `wss://app.example.com:<port>/rsbuild-hmr`。

## Notes

- 同一份 Rules 可以复用到 Profile 1/2/3；每个 Profile 的
  `runweave-dev-server` Value 决定实际 Dev Server 端口
- 本地开发服务需要监听对应的 `127.0.0.1:<dev-server-port>`
- 本地服务需要能接受 `Host: app.example.com` 的访问方式
- 代理 `https://app.example.com` 前，Whistle 根证书需要正确安装并被系统信任
- 不要再叠加影响这些 URL 的 `filter://`、整域名转发或更宽泛的 host/proxy 规则，否则容易冲突
