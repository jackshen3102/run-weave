import type { ViewerTab } from "@browser-viewer/shared";
import { Button } from "../ui/button";

interface ViewerTabListProps {
  tabs: ViewerTab[];
  onSwitchTab: (tabId: string) => void;
}

export function ViewerTabList({ tabs, onSwitchTab }: ViewerTabListProps) {
  return (
    <div
      className="flex min-w-0 gap-2 overflow-x-auto whitespace-nowrap [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      data-testid="tab-list"
    >
      {tabs.map((tab) => (
        <Button
          key={tab.id}
          size="sm"
          variant={tab.active ? "default" : "ghost"}
          className="max-w-[220px] shrink-0 overflow-hidden rounded-full border border-white/10 px-4 text-stone-200 data-[active=true]:border-transparent data-[active=true]:text-primary-foreground data-[active=true]:shadow-sm hover:bg-white/8 hover:text-white"
          aria-pressed={tab.active}
          data-active={tab.active}
          data-tab-id={tab.id}
          onClick={() => {
            if (tab.active) {
              return;
            }
            onSwitchTab(tab.id);
          }}
          title={tab.title || tab.url}
        >
          <span className="truncate">{tab.title || tab.url}</span>
        </Button>
      ))}
      {tabs.length === 0 && (
        <p className="px-1 text-xs uppercase tracking-[0.24em] text-stone-400/75">
          Waiting for tabs...
        </p>
      )}
    </div>
  );
}
