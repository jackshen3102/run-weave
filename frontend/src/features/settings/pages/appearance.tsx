import { useTheme } from "next-themes";
import { ArrowDown, ArrowUp } from "lucide-react";
import { useTerminalPreviewStore } from "../../terminal/preview/store";
import {
  SIDECAR_TABS,
  getVisibleSidecarTabs,
} from "../../terminal/preview/sidecar-layout";
import { Button } from "../../../components/ui/button";
export default function Appearance() {
  const { theme, setTheme } = useTheme();
  const layout = useTerminalPreviewStore((state) => state.sidecarLayout),
    error = useTerminalPreviewStore((state) => state.sidecarLayoutError);
  const available = SIDECAR_TABS.filter(
    (tab) => tab.id !== "automation" || window.electronAPI?.isElectron,
  ).map((tab) => tab.id);
  const visible = getVisibleSidecarTabs(layout, available);
  // Agent Team only appears for eligible terminals; it cannot guarantee a
  // visible tool when this device preference is reused by another terminal.
  const alwaysVisible = visible.filter((id) => id !== "agent-team");
  const store = useTerminalPreviewStore.getState();
  return (
    <div className="space-y-4">
      <section>
        <h2 className="mb-2 font-medium">主题</h2>
        <div className="grid grid-cols-3 gap-2">
          {(
            [
              ["light", "浅色"],
              ["dark", "深色"],
              ["system", "跟随系统"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              aria-pressed={theme === id}
              onClick={() => setTheme(id)}
              className={`flex items-center gap-2 rounded-md border px-3 py-2 text-left ${theme === id ? "border-primary ring-1 ring-primary" : ""}`}
            >
              <div
                className={`h-5 w-8 shrink-0 rounded border ${id === "light" ? "bg-stone-100" : id === "dark" ? "bg-neutral-900" : "bg-gradient-to-r from-stone-100 to-neutral-900"}`}
              />
              {label}
            </button>
          ))}
        </div>
      </section>
      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="font-medium">右侧工具标签</h2>
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={store.resetSidecarLayout}>
            恢复默认
          </Button>
        </div>
        <div className="divide-y rounded-md border">
          {layout.order.map((id) => {
            const tab = SIDECAR_TABS.find((item) => item.id === id)!;
            const shown = visible.includes(id),
              index = visible.indexOf(id),
              supported = available.includes(id);
            return (
              <div key={id} className="flex items-center gap-2 px-3 py-1">
                <span className="flex-1">{tab.label}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 w-6 p-0"
                  aria-label={`上移 ${tab.label}`}
                  disabled={!shown || index <= 0}
                  onClick={() =>
                    store.reorderSidecarTabs(available, index, index - 1)
                  }
                >
                  <ArrowUp className="size-4" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 w-6 p-0"
                  aria-label={`下移 ${tab.label}`}
                  disabled={!shown || index === visible.length - 1}
                  onClick={() =>
                    store.reorderSidecarTabs(available, index, index + 1)
                  }
                >
                  <ArrowDown className="size-4" />
                </Button>
                <input
                  type="checkbox"
                  aria-label={`显示 ${tab.label}`}
                  checked={!layout.hidden.includes(id)}
                  disabled={
                    !supported ||
                    (shown && id !== "agent-team" && alwaysVisible.length <= 1)
                  }
                  onChange={(event) =>
                    store.setSidecarTabVisible(
                      id,
                      event.target.checked,
                      available,
                    )
                  }
                />
              </div>
            );
          })}
        </div>
        {error && (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {error}
          </p>
        )}
      </section>
    </div>
  );
}
