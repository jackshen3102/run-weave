/** Service names shared by the field reference and service-based editors. */
export const CONFIGURATION_DOMAIN_LABELS: Readonly<Record<string, string>> = {
  "backend.server": "Backend 服务", "backend.auth": "登录认证", "backend.tunnelAuth": "隧道认证",
  "services.snapshotPublisher": "终端分享", "services.snapshotHost": "分享托管服务",
  "services.pushSender": "设备通知", "services.pushGateway": "推送网关", "services.feishu": "飞书",
  "services.suiji": "随记", "agents.codex": "Codex", "agents.traex": "Traex", "agents.team": "Agent Team",
  "agents.companion": "伴随窗口", "desktop.browser": "桌面浏览器", "desktop.preferences": "桌面偏好",
  "desktop.tunnels": "远程访问", cli: "CLI 连接", developer: "开发与签名", knowledge: "知识库",
  logging: "日志", scheduledTasks: "后台任务", storage: "数据存储", terminal: "终端",
  updates: "更新", voice: "语音", appServer: "App Server",
};
