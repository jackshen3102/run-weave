import {
  Clock3,
  Database,
  History,
  ShieldCheck,
  Unplug,
  Users,
  type LucideIcon,
} from "lucide-react";

export type ActivityView =
  | "terminals"
  | "runs"
  | "facts"
  | "timeline"
  | "sources"
  | "policy";

export const ACTIVITY_NAVIGATION: Array<{
  id: ActivityView;
  label: string;
  icon: LucideIcon;
  group: "Work history" | "Raw data" | "Data";
}> = [
  {
    id: "terminals",
    label: "Terminal History",
    icon: History,
    group: "Work history",
  },
  { id: "runs", label: "Multi-Agent Runs", icon: Users, group: "Work history" },
  { id: "facts", label: "Events", icon: Database, group: "Raw data" },
  { id: "timeline", label: "Timeline", icon: Clock3, group: "Raw data" },
  { id: "sources", label: "Sources", icon: Unplug, group: "Raw data" },
  { id: "policy", label: "Data Policy", icon: ShieldCheck, group: "Data" },
];
