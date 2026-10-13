import {
  Activity,
  Bell,
  Keyboard,
  Link,
  LockKeyhole,
  Monitor,
  Server,
  Sparkles,
  SlidersHorizontal,
  Sun,
  User,
  CalendarClock,
  PanelsTopLeft,
} from "lucide-react";
export const appNavigationItems = [
  { path: "/activity", title: "Activity", icon: Activity },
  { path: "/evolution", title: "Evolution", icon: Sparkles },
  { path: "/system-monitor", title: "System Monitor", icon: Activity },
  { path: "/dev-resources", title: "开发资源", icon: Server },
  { path: "/scheduled-tasks", title: "定时任务", icon: CalendarClock },
  { path: "/prototypes", title: "原型库", icon: PanelsTopLeft },
] as const;
export const settingsPages = [
  {
    id: "appearance",
    title: "外观",
    group: "本台应用",
    scope: "local",
    icon: Sun,
  },
  {
    id: "notifications",
    title: "桌面通知",
    group: "本台应用",
    scope: "local",
    icon: Bell,
  },
  {
    id: "shortcuts",
    title: "快捷键",
    group: "本台应用",
    scope: "local",
    icon: Keyboard,
  },
  {
    id: "connections",
    title: "连接管理",
    group: "连接与服务",
    scope: "local",
    icon: Link,
  },
  {
    id: "suiji",
    title: "随记账户",
    group: "连接与服务",
    scope: "account",
    icon: User,
  },
  {
    id: "access",
    title: "登录与手机接入",
    group: "所选电脑",
    scope: "computer",
    icon: LockKeyhole,
  },
  {
    id: "monitoring",
    title: "资源监控与提醒",
    group: "所选电脑",
    scope: "computer",
    icon: Activity,
  },
  {
    id: "advanced",
    title: "高级配置",
    group: "所选电脑",
    scope: "computer",
    icon: SlidersHorizontal,
  },
  {
    id: "status",
    title: "电脑状态",
    group: "状态与诊断",
    scope: "computer",
    icon: Activity,
  },
  {
    id: "desktop",
    title: "本台桌面诊断",
    group: "状态与诊断",
    scope: "local",
    icon: Monitor,
  },
] as const;
export type SettingsPageId = (typeof settingsPages)[number]["id"];
export type SettingsScope = (typeof settingsPages)[number]["scope"];
export function settingsPage(id: string) {
  return settingsPages.find((page) => page.id === id) ?? settingsPages[0];
}
