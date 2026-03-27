# Whistle Rules For `www.coze.cn`

目标：

- `www.coze.cn` 大部分页面和静态资源走本地开发服务 `127.0.0.1:3000`
- 以下路径继续走线上，不被本地代理接管：
  - `/api/`
  - `/vibe/`
  - `/s/`
  - `/passport/`
  - `/sign/`
  - `/auth/callback/`

## Recommended Rules

按从上到下的顺序放到 Whistle 规则里：

```text
https://www.coze.cn/ http://127.0.0.1:3000 excludeFilter://https://www.coze.cn/api/ excludeFilter://https://www.coze.cn/vibe/ excludeFilter://https://www.coze.cn/s/ excludeFilter://https://www.coze.cn/passport/ excludeFilter://https://www.coze.cn/sign/ excludeFilter://https://www.coze.cn/auth/callback
```

## Why This Form

- 用整站转发配合 `excludeFilter://...` 排除例外路径，比“把 URL 映射回自己”更明确。
- 所有规则都带完整协议，避免裸域名规则带来的歧义。
- 本地目标明确写成 `http://127.0.0.1:3000`，避免 Whistle 按非预期方式解释。

## Do Not Add By Default

先不要加下面这种整站 WebSocket 规则：

```text
wss://www.coze.cn ws://localhost:3000
```

原因：

- 这会把整站 WebSocket 都转到本地，范围过大。
- 除非已经确认本地服务需要接管某个明确的 WS 路径，否则很容易误伤线上连接。

如果后续确实要代理 WebSocket，只代理具体路径，不要代理整个域名。

## Notes

- 你的本地开发服务需要监听 `127.0.0.1:3000`，并且能接受 `Host: www.coze.cn` 的访问方式。
- 如果要代理 `https://www.coze.cn`，Whistle 需要正确安装并信任根证书。
- 不要再叠加会影响这些 URL 的 `filter://`、整域名转发或更宽泛的 host/proxy 规则，否则容易和这里的规则冲突。
