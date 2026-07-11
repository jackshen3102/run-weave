import { IonIcon } from "@ionic/react";
import {
  chatbubbleEllipsesOutline,
  folderOpenOutline,
  gitCompareOutline,
} from "ionicons/icons";

import type { AppTerminalDetailTab } from "../features/terminal/types";

export type { AppTerminalDetailTab } from "../features/terminal/types";

const TABS: Array<{
  id: AppTerminalDetailTab;
  label: string;
  icon: string;
}> = [
  { id: "chat", label: "Chat", icon: chatbubbleEllipsesOutline },
  { id: "changes", label: "Changes", icon: gitCompareOutline },
  { id: "files", label: "Files", icon: folderOpenOutline },
];

export function TerminalDetailTabBar({
  activeTab,
  changesCount,
  onTabChange,
}: {
  activeTab: AppTerminalDetailTab;
  changesCount: number;
  onTabChange: (tab: AppTerminalDetailTab) => void;
}) {
  return (
    <nav aria-label="Terminal detail tabs" className="terminal-detail-tabs">
      {TABS.map((tab) => (
        <button
          aria-current={activeTab === tab.id ? "page" : undefined}
          className={`terminal-detail-tab ${
            activeTab === tab.id ? "is-active" : ""
          }`}
          key={tab.id}
          onClick={() => onTabChange(tab.id)}
          type="button"
        >
          <IonIcon aria-hidden="true" icon={tab.icon} />
          <span>{tab.label}</span>
          {tab.id === "changes" && changesCount > 0 ? (
            <strong>{changesCount > 99 ? "99+" : changesCount}</strong>
          ) : null}
        </button>
      ))}
    </nav>
  );
}
