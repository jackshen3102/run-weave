export const repository = "https://github.com/jackshen3102/run-weave";
export const guide = "/start/";
export const machines = [
  { name: "Mac", role: "日常工作", detail: "浏览器与本地工具", icon: "laptop" },
  { name: "Linux", role: "开发服务器", detail: "项目与长任务", icon: "server" },
  {
    name: "Windows",
    role: "工作机",
    detail: "专属应用与环境",
    icon: "windows",
  },
];
export const products = [
  {
    name: "随记",
    description: "记下想法，整理待办、浏览与工作。",
    path: "packages/suiji-ios/README.md",
    kind: "notes",
  },
  {
    name: "ScreenJournal",
    description: "记录屏幕活动，回看当时的现场。",
    path: "packages/screen-recording-macos/README.md",
    kind: "journal",
  },
  {
    name: "RemoteDesk",
    description: "从手机连接 Mac，直接操作桌面。",
    path: "packages/remote-desktop-host/README.md",
    kind: "remote",
  },
];
