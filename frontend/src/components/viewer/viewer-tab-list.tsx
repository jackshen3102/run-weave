import { useEffect, useRef, useState } from "react";
import type { ViewerTab } from "@browser-viewer/shared";
import { Globe } from "lucide-react";
import { HttpError } from "../../services/http";
import { getSessionTabFavicon } from "../../services/session";
import { Button } from "../ui/button";

interface ViewerTabListProps {
  apiBase: string;
  sessionId: string;
  token: string;
  tabs: ViewerTab[];
  disabled: boolean;
  onSwitchTab: (tabId: string) => void;
  onAuthExpired?: () => void;
}

export function ViewerTabList({
  apiBase,
  sessionId,
  token,
  tabs,
  disabled,
  onSwitchTab,
  onAuthExpired,
}: ViewerTabListProps) {
  const [faviconObjectUrlByTabId, setFaviconObjectUrlByTabId] = useState<
    Record<string, string>
  >({});
  const faviconObjectUrlByTabIdRef = useRef(new Map<string, string>());
  const faviconSignatureByTabIdRef = useRef(new Map<string, string>());
  const faviconRequestByTabIdRef = useRef(new Map<string, AbortController>());

  useEffect(() => {
    const faviconRequests = faviconRequestByTabIdRef.current;
    const faviconObjectUrls = faviconObjectUrlByTabIdRef.current;
    const faviconSignatures = faviconSignatureByTabIdRef.current;

    return () => {
      for (const controller of faviconRequests.values()) {
        controller.abort();
      }
      faviconRequests.clear();

      for (const objectUrl of faviconObjectUrls.values()) {
        URL.revokeObjectURL(objectUrl);
      }
      faviconObjectUrls.clear();
      faviconSignatures.clear();
    };
  }, []);

  useEffect(() => {
    const nextObjectUrls = new Map(faviconObjectUrlByTabIdRef.current);
    const nextSignatures = new Map(
      tabs.map((tab) => [tab.id, `${tab.url}|${tab.faviconUrl ?? ""}`]),
    );

    for (const [tabId, currentSignature] of faviconSignatureByTabIdRef.current) {
      const nextSignature = nextSignatures.get(tabId);
      if (nextSignature === currentSignature) {
        continue;
      }

      faviconRequestByTabIdRef.current.get(tabId)?.abort();
      faviconRequestByTabIdRef.current.delete(tabId);
      faviconSignatureByTabIdRef.current.delete(tabId);

      const existingObjectUrl = nextObjectUrls.get(tabId);
      if (!existingObjectUrl) {
        continue;
      }
      URL.revokeObjectURL(existingObjectUrl);
      nextObjectUrls.delete(tabId);
    }

    faviconObjectUrlByTabIdRef.current = nextObjectUrls;
    setFaviconObjectUrlByTabId(Object.fromEntries(nextObjectUrls.entries()));

    for (const tab of tabs) {
      if (!tab.faviconUrl) {
        continue;
      }

      const signature = `${tab.url}|${tab.faviconUrl}`;
      if (faviconSignatureByTabIdRef.current.get(tab.id) === signature) {
        continue;
      }

      const controller = new AbortController();
      faviconRequestByTabIdRef.current.set(tab.id, controller);
      faviconSignatureByTabIdRef.current.set(tab.id, signature);

      void getSessionTabFavicon(
        apiBase,
        token,
        sessionId,
        tab.id,
        controller.signal,
      )
        .then((blob) => {
          if (controller.signal.aborted) {
            return;
          }

          const objectUrl = URL.createObjectURL(blob);
          const existingObjectUrl =
            faviconObjectUrlByTabIdRef.current.get(tab.id);
          if (existingObjectUrl) {
            URL.revokeObjectURL(existingObjectUrl);
          }

          faviconObjectUrlByTabIdRef.current.set(tab.id, objectUrl);
          setFaviconObjectUrlByTabId(
            Object.fromEntries(faviconObjectUrlByTabIdRef.current.entries()),
          );
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) {
            return;
          }

          if (error instanceof HttpError && error.status === 401) {
            onAuthExpired?.();
            return;
          }

          if (
            !(error instanceof HttpError) ||
            (error.status !== 404 && error.status !== 502)
          ) {
            faviconSignatureByTabIdRef.current.delete(tab.id);
            console.error("[viewer-fe] failed to load tab favicon", {
              sessionId,
              tabId: tab.id,
              error: String(error),
            });
          }
        })
        .finally(() => {
          const currentRequest =
            faviconRequestByTabIdRef.current.get(tab.id);
          if (currentRequest === controller) {
            faviconRequestByTabIdRef.current.delete(tab.id);
          }
        });
    }
  }, [apiBase, onAuthExpired, sessionId, tabs, token]);

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
          className="max-w-[220px] shrink-0 overflow-hidden rounded-full border border-white/10 px-4 text-stone-200 data-[active=true]:border-sky-200/20 data-[active=true]:bg-[#4d8097] data-[active=true]:text-white data-[active=true]:shadow-[0_14px_36px_-20px_rgba(89,151,179,0.85)] hover:bg-white/8 hover:text-white data-[active=true]:hover:bg-[#568aa2]"
          aria-pressed={tab.active}
          data-active={tab.active}
          data-tab-id={tab.id}
          disabled={disabled}
          onClick={() => {
            if (disabled || tab.active) {
              return;
            }
            onSwitchTab(tab.id);
          }}
          title={tab.title || tab.url}
        >
          <span className="flex min-w-0 items-center gap-2">
            {faviconObjectUrlByTabId[tab.id] ? (
              <img
                src={faviconObjectUrlByTabId[tab.id]}
                alt=""
                className="h-4 w-4 shrink-0 rounded-sm"
                loading="lazy"
              />
            ) : (
              <Globe className="h-4 w-4 shrink-0 text-stone-500" />
            )}
            <span className="truncate">{tab.title || tab.url}</span>
          </span>
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
