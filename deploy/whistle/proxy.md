# Whistle Rules For `www.coze.cn`

这份文档用于把 `https://www.coze.cn` 的大部分页面流量转到本地开发服务 `127.0.0.1:3000`，同时保留少数线上路径继续直连线上。

## Expected Result

- 页面和静态资源默认走本地 `127.0.0.1:3000`
- 以下路径继续走线上，不被本地代理接管：
  - `/api/`
  - `/vibe/`
  - `/s/`
  - `/passport/`
  - `/sign/`
  - `/auth/callback/`
- HMR WebSocket 只代理 `/rsbuild-hmr`，不要扩大到整个域名

## Recommended Rules

按下面顺序添加到 Whistle 规则中：

```text
https://www.coze.cn/ http://127.0.0.1:3000 excludeFilter://https://www.coze.cn/api/ excludeFilter://https://www.coze.cn/vibe/ excludeFilter://https://www.coze.cn/s/ excludeFilter://https://www.coze.cn/passport/ excludeFilter://https://www.coze.cn/sign/ excludeFilter://https://www.coze.cn/auth/callback
wss://www.coze.cn/rsbuild-hmr ws://127.0.0.1:3000/rsbuild-hmr
```

## Why These Rules

- 用整站转发加 `excludeFilter://...`，比“把某些 URL 映射回自己”更直观，也更不容易配错。
- 规则里显式写完整协议和目标地址，可以减少 Whistle 对规则的歧义解析。
- WebSocket 只代理 `/rsbuild-hmr`，范围足够小，不会误伤站点上其他线上 WS 连接。

## Do Not Do This

不要默认加整站 WebSocket 代理，例如：

```text
wss://www.coze.cn ws://127.0.0.1:3000
```

原因：

- 会把 `www.coze.cn` 下所有 WebSocket 都转到本地
- 很容易影响本应继续走线上的连接
- 问题定位会更难，因为影响面太大

如果后续确实需要代理其他 WebSocket，也只增加具体路径规则，不要代理整个域名。

## Notes

- 本地开发服务需要监听 `127.0.0.1:3000`
- 本地服务需要能接受 `Host: www.coze.cn` 的访问方式
- 代理 `https://www.coze.cn` 前，Whistle 根证书需要正确安装并被系统信任
- 不要再叠加影响这些 URL 的 `filter://`、整域名转发或更宽泛的 host/proxy 规则，否则容易冲突
