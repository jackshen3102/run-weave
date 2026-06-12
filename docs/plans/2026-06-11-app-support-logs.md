{
"manifest": {
"bundleVersion": 1,
"createdAt": "2026-06-11T17:00:19.223Z",
"appVersion": "0.1.0",
"platform": "web",
"scope": {
"source": "login"
},
"eventCount": 21
},
"logs": [
{
"at": "2026-06-11T16:59:56.209Z",
"level": "info",
"source": "app",
"event": "app.startup.ready",
"fields": {
"appVersion": "0.1.0",
"platform": "web",
"route": "/login",
"apiBaseHost": "127.0.0.1:5174",
"online": true,
"userAgent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) @browser-viewer/electron/0.99.0 Chrome/130.0.6723.191 Electron/33.4.11 Safari/537.36"
}
},
{
"at": "2026-06-11T16:59:56.210Z",
"level": "info",
"source": "app",
"event": "app.startup.ready",
"fields": {
"appVersion": "0.1.0",
"platform": "web",
"route": "/login",
"apiBaseHost": "127.0.0.1:5174",
"online": true,
"userAgent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) @browser-viewer/electron/0.99.0 Chrome/130.0.6723.191 Electron/33.4.11 Safari/537.36"
}
},
{
"at": "2026-06-11T16:59:56.242Z",
"level": "warn",
"source": "app",
"event": "auth.verify.failed",
"fields": {
"appVersion": "0.1.0",
"platform": "web",
"route": "/login",
"apiBaseHost": "127.0.0.1:5174",
"online": true,
"userAgent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) @browser-viewer/electron/0.99.0 Chrome/130.0.6723.191 Electron/33.4.11 Safari/537.36",
"error": "Unauthorized"
}
},
{
"at": "2026-06-11T16:59:56.242Z",
"level": "info",
"source": "app",
"event": "auth.refresh.started",
"fields": {
"appVersion": "0.1.0",
"platform": "web",
"route": "/login",
"apiBaseHost": "127.0.0.1:5174",
"online": true,
"userAgent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) @browser-viewer/electron/0.99.0 Chrome/130.0.6723.191 Electron/33.4.11 Safari/537.36"
}
},
{
"at": "2026-06-11T16:59:56.242Z",
"level": "warn",
"source": "app",
"event": "api.request.failed",
"fields": {
"appVersion": "0.1.0",
"platform": "web",
"route": "/login",
"apiBaseHost": "",
"online": true,
"userAgent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) @browser-viewer/electron/0.99.0 Chrome/130.0.6723.191 Electron/33.4.11 Safari/537.36",
"durationMs": 33,
"errorMessage": "Unauthorized",
"errorName": "ApiError",
"method": "GET",
"path": "/api/auth/verify",
"status": 401
}
},
{
"at": "2026-06-11T16:59:56.244Z",
"level": "info",
"source": "app",
"event": "auth.refresh.started",
"fields": {
"appVersion": "0.1.0",
"platform": "web",
"route": "/login",
"apiBaseHost": "127.0.0.1:5174",
"online": true,
"userAgent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) @browser-viewer/electron/0.99.0 Chrome/130.0.6723.191 Electron/33.4.11 Safari/537.36"
}
},
{
"at": "2026-06-11T16:59:56.244Z",
"level": "warn",
"source": "app",
"event": "auth.verify.failed",
"fields": {
"appVersion": "0.1.0",
"platform": "web",
"route": "/login",
"apiBaseHost": "127.0.0.1:5174",
"online": true,
"userAgent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) @browser-viewer/electron/0.99.0 Chrome/130.0.6723.191 Electron/33.4.11 Safari/537.36",
"error": "Unauthorized"
}
},
{
"at": "2026-06-11T16:59:56.244Z",
"level": "warn",
"source": "app",
"event": "api.request.failed",
"fields": {
"appVersion": "0.1.0",
"platform": "web",
"route": "/login",
"apiBaseHost": "",
"online": true,
"userAgent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) @browser-viewer/electron/0.99.0 Chrome/130.0.6723.191 Electron/33.4.11 Safari/537.36",
"durationMs": 33,
"errorMessage": "Unauthorized",
"errorName": "ApiError",
"method": "GET",
"path": "/api/auth/verify",
"status": 401
}
},
{
"at": "2026-06-11T16:59:56.249Z",
"level": "warn",
"source": "app",
"event": "api.request.failed",
"fields": {
"appVersion": "0.1.0",
"platform": "web",
"route": "/login",
"apiBaseHost": "",
"online": true,
"userAgent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) @browser-viewer/electron/0.99.0 Chrome/130.0.6723.191 Electron/33.4.11 Safari/537.36",
"durationMs": 5,
"errorMessage": "Unauthorized",
"errorName": "ApiError",
"method": "POST",
"path": "/api/auth/refresh",
"status": 401
}
},
{
"at": "2026-06-11T16:59:56.249Z",
"level": "warn",
"source": "app",
"event": "auth.refresh.failed",
"fields": {
"appVersion": "0.1.0",
"platform": "web",
"route": "/login",
"apiBaseHost": "127.0.0.1:5174",
"online": true,
"userAgent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) @browser-viewer/electron/0.99.0 Chrome/130.0.6723.191 Electron/33.4.11 Safari/537.36",
"error": "Unauthorized"
}
},
{
"at": "2026-06-11T16:59:56.264Z",
"level": "info",
"source": "app",
"event": "api.request.completed",
"fields": {
"appVersion": "0.1.0",
"platform": "web",
"route": "/login",
"apiBaseHost": "",
"online": true,
"userAgent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) @browser-viewer/electron/0.99.0 Chrome/130.0.6723.191 Electron/33.4.11 Safari/537.36",
"durationMs": 23,
"method": "POST",
"path": "/api/auth/refresh",
"status": 200
}
},
{
"at": "2026-06-11T16:59:56.280Z",
"level": "info",
"source": "app",
"event": "auth.refresh.completed",
"fields": {
"appVersion": "0.1.0",
"platform": "web",
"route": "/login",
"apiBaseHost": "127.0.0.1:5174",
"online": true,
"userAgent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) @browser-viewer/electron/0.99.0 Chrome/130.0.6723.191 Electron/33.4.11 Safari/537.36"
}
},
{
"at": "2026-06-11T16:59:56.284Z",
"level": "info",
"source": "app",
"event": "auth.verify.started",
"fields": {
"appVersion": "0.1.0",
"platform": "web",
"route": "/home",
"apiBaseHost": "127.0.0.1:5174",
"online": true,
"userAgent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) @browser-viewer/electron/0.99.0 Chrome/130.0.6723.191 Electron/33.4.11 Safari/537.36"
}
},
{
"at": "2026-06-11T16:59:56.300Z",
"level": "info",
"source": "app",
"event": "api.request.completed",
"fields": {
"appVersion": "0.1.0",
"platform": "web",
"route": "/home",
"apiBaseHost": "",
"online": true,
"userAgent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) @browser-viewer/electron/0.99.0 Chrome/130.0.6723.191 Electron/33.4.11 Safari/537.36",
"durationMs": 16,
"method": "GET",
"path": "/api/auth/verify",
"status": 200
}
},
{
"at": "2026-06-11T16:59:56.305Z",
"level": "info",
"source": "app",
"event": "auth.verify.completed",
"fields": {
"appVersion": "0.1.0",
"platform": "web",
"route": "/home",
"apiBaseHost": "127.0.0.1:5174",
"online": true,
"userAgent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) @browser-viewer/electron/0.99.0 Chrome/130.0.6723.191 Electron/33.4.11 Safari/537.36"
}
},
{
"at": "2026-06-11T16:59:56.311Z",
"level": "info",
"source": "app",
"event": "api.request.completed",
"fields": {
"appVersion": "0.1.0",
"platform": "web",
"route": "/home",
"apiBaseHost": "",
"online": true,
"userAgent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) @browser-viewer/electron/0.99.0 Chrome/130.0.6723.191 Electron/33.4.11 Safari/537.36",
"durationMs": 6,
"method": "GET",
"path": "/api/app/home/overview",
"status": 200
}
},
{
"at": "2026-06-11T16:59:56.312Z",
"level": "info",
"source": "app",
"event": "app.home.overview.loaded",
"fields": {
"appVersion": "0.1.0",
"platform": "web",
"route": "/home",
"apiBaseHost": "127.0.0.1:5174",
"online": true,
"userAgent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) @browser-viewer/electron/0.99.0 Chrome/130.0.6723.191 Electron/33.4.11 Safari/537.36"
}
},
{
"at": "2026-06-11T17:00:07.471Z",
"level": "info",
"source": "app",
"event": "app.startup.ready",
"fields": {
"appVersion": "0.1.0",
"platform": "web",
"route": "/login",
"apiBaseHost": "127.0.0.1:5174",
"online": true,
"userAgent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) @browser-viewer/electron/0.99.0 Chrome/130.0.6723.191 Electron/33.4.11 Safari/537.36"
}
},
{
"at": "2026-06-11T17:00:07.471Z",
"level": "info",
"source": "app",
"event": "app.startup.ready",
"fields": {
"appVersion": "0.1.0",
"platform": "web",
"route": "/login",
"apiBaseHost": "127.0.0.1:5174",
"online": true,
"userAgent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) @browser-viewer/electron/0.99.0 Chrome/130.0.6723.191 Electron/33.4.11 Safari/537.36"
}
},
{
"at": "2026-06-11T17:00:12.228Z",
"level": "info",
"source": "app",
"event": "support.sheet.opened",
"fields": {
"appVersion": "0.1.0",
"platform": "web",
"route": "/login",
"apiBaseHost": "127.0.0.1:5174",
"online": true,
"userAgent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) @browser-viewer/electron/0.99.0 Chrome/130.0.6723.191 Electron/33.4.11 Safari/537.36",
"scope": {
"source": "login"
}
}
},
{
"at": "2026-06-11T17:00:19.223Z",
"level": "info",
"source": "app",
"event": "support.export.started",
"fields": {
"appVersion": "0.1.0",
"platform": "web",
"route": "/login",
"apiBaseHost": "127.0.0.1:5174",
"online": true,
"userAgent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) @browser-viewer/electron/0.99.0 Chrome/130.0.6723.191 Electron/33.4.11 Safari/537.36",
"method": "download",
"scope": {
"source": "login"
}
}
}
],
"redactionReport": {
"tokens": 0,
"cookies": 0,
"authorizationHeaders": 0,
"sensitiveUrls": 0
}
}
