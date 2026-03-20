import type { ViewerTab } from "@browser-viewer/shared";
import { Button } from "../ui/button";

interface ViewerTabListProps {
  tabs: ViewerTab[];
  onSwitchTab: (tabId: string) => void;
}

export function ViewerTabList({ tabs, onSwitchTab }: ViewerTabListProps) {
  return (
    <div className="mb-3 flex flex-wrap gap-2" data-testid="tab-list">
      {tabs.map((tab) => (
        <Button
          key={tab.id}
          size="sm"
          variant={tab.active ? "default" : "secondary"}
          className="max-w-[220px] truncate"
          aria-pressed={tab.active}
          data-tab-id={tab.id}
          onClick={() => {
            if (tab.active) {
              return;
            }
            onSwitchTab(tab.id);
          }}
          title={tab.title || tab.url}
        >
          {tab.title || tab.url}
        </Button>
      ))}
      {tabs.length === 0 && (
        <p className="text-xs text-muted-foreground">Waiting for tabs...</p>
      )}
    </div>
  );
}
