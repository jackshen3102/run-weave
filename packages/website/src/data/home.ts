export const repository = "https://github.com/jackshen3102/run-weave";
export const guide = "/start/";
export const platforms = [
  { name: "macOS", icon: "macos" },
  { name: "Windows", icon: "windows" },
  { name: "Linux", icon: "linux" },
] as const;
export const products = [
  {
    name: "随记",
    description: "记下想法，整理待办、浏览与工作。",
    path: "packages/suiji-ios/README.md",
    kind: "notes",
  },
  {
    name: "屏幕日记",
    description: "记录屏幕活动，回看当时的现场。",
    path: "packages/screen-recording-macos/README.md",
    kind: "journal",
  },
  {
    name: "远程桌面",
    description: "从手机连接 Mac，直接操作桌面。",
    path: "packages/remote-desktop-host/README.md",
    kind: "remote",
  },
] as const;
