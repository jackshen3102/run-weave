import { createRoot, type Root } from "react-dom/client";
import { useLayoutEffect, useRef, useState } from "react";
import { useMemoizedFn } from "ahooks";
import { RunweaveImagePreview, RunweaveImageLightbox } from "@runweave/common/terminal";
import "@runweave/common/terminal/image-lightbox.css";
import { OverlayProvider } from "../features/overlay/provider";
import { setBrowserPresentationHost, setBrowserPresentationBounds, useBrowserPresentation, setPresentationAcceptanceTransport } from "../features/terminal/browser-presentation/coordinator";
import { useOverlayRef } from "../features/overlay/use-overlay-ref";
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogTrigger } from "../components/ui/dialog";
import { AlertDialog, AlertDialogContent, AlertDialogTitle, AlertDialogDescription, AlertDialogCancel } from "../components/ui/alert-dialog";
import { Sheet, SheetContent, SheetTitle, SheetDescription } from "../components/ui/sheet";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSub, DropdownMenuSubTrigger, DropdownMenuSubContent } from "../components/ui/dropdown-menu";
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem } from "../components/ui/context-menu";
import { Tooltip } from "../components/ui/tooltip";
import type { TerminalBrowserProfileId } from "@runweave/shared/terminal-browser-profile";

const image = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="orange"/></svg>';
let root: Root | null = null;
let host: HTMLDivElement | null = null;
let selectTab: ((id: string) => void) | null = null;
let setToolActive: ((active: boolean) => void) | null = null;
const created: string[] = [];
let profile: TerminalBrowserProfileId = "profile-1";

export async function createHarnessTab(profileId: TerminalBrowserProfileId = "profile-1") {
  const api = window.electronAPI;
  if (!api?.terminalBrowserCreateTab) return null;
  profile = profileId;
  await api.terminalBrowserCreateTab({ profileId, placement: "new-group", url: "about:blank" });
  const workspace = await api.terminalBrowserGetWorkspace?.(profileId);
  const id = workspace?.activeTabId;
  if (id) { created.push(id); selectTab?.(id); }
  return id;
}
export function setHarnessToolActive(active: boolean) { setToolActive?.(active); }
export function injectPresentationFault(mode: "none" | "reject" | "delay") {
  const real = window.electronAPI?.terminalBrowserSetPresentation;
  setPresentationAcceptanceTransport(mode === "none" || !real ? null : async (state) => {
    if (mode === "reject") throw new Error("Fixture presentation rejection");
    await new Promise((resolve) => setTimeout(resolve, 500));
    await real(state);
  });
}

function Harness() {
  const [tab, setTab] = useState<string | null>(null);
  const [active, setActive] = useState(true);
  const [modal, setModal] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [alert, setAlert] = useState(false);
  const [lightbox, setLightbox] = useState(false);
  const [overlap, setOverlap] = useState(false);
  const [notice, setNotice] = useState(false);
  const viewport = useRef<HTMLDivElement>(null);
  const noticeRef = useOverlayRef<HTMLDivElement>();
  const presentation = useBrowserPresentation();
  const sync = useMemoizedFn(() => {
    const rect = viewport.current?.getBoundingClientRect();
    if (!rect) return;
    const bounds = { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
    setBrowserPresentationBounds(bounds);
    if (tab) void window.electronAPI?.terminalBrowserSetBounds?.(tab, bounds);
  });
  useLayoutEffect(() => {
    selectTab = setTab; setToolActive = setActive;
    const unsubscribe = window.electronAPI?.onTerminalBrowserStateChanged?.((event) => {
      if (event.kind === "workspace" && event.workspace.profileId === profile) setTab(event.workspace.activeTabId);
    });
    return () => { unsubscribe?.(); selectTab = null; setToolActive = null; void setBrowserPresentationHost(false, null); };
  }, []);
  useLayoutEffect(() => {
    sync();
    void setBrowserPresentationHost(active, tab);
    if (tab && active) void window.electronAPI?.terminalBrowserShow?.(tab);
    const observer = new ResizeObserver(sync);
    if (viewport.current) observer.observe(viewport.current);
    window.addEventListener("resize", sync);
    return () => { observer.disconnect(); window.removeEventListener("resize", sync); };
  }, [tab, active, sync]);
  return <OverlayProvider><div className="fixed inset-0 bg-slate-900 text-white p-5" style={{ zIndex: 30 }}>
    <h1>Browser overlay acceptance</h1>
    <div className="flex gap-3 py-3 flex-wrap" style={{ maxWidth: 480 }}>
      <button onClick={() => void createHarnessTab()}>Create fixture tab</button>
      <Dialog open={modal} onOpenChange={setModal}><DialogTrigger asChild><button>Open dialog</button></DialogTrigger><DialogContent><DialogTitle>Fixture dialog</DialogTitle><DialogDescription>Native view must yield</DialogDescription><input aria-label="Overlay input" placeholder="Type here" className="text-black" /><button onClick={() => setModal(false)}>Dismiss dialog</button></DialogContent></Dialog>
      <button onClick={() => setAlert(true)}>Open alert</button>
      <button onClick={() => setSheet(true)}>Open sheet</button>
      <button onClick={() => setOverlap(!overlap)}>Move triggers</button>
      <button onClick={() => setNotice(!notice)}>Toggle notice</button>
      <button onClick={() => setLightbox(true)}>Open image</button>
      <div style={{ width: 100, height: 48 }}><RunweaveImagePreview src={image} alt="Fixture thumbnail" className="[&_.rw-image-preview__button]:min-h-0 [&_.rw-image-preview__open]:hidden" /></div>
    </div>
    <p data-presentation-state="">{active ? "active" : "inactive"} / {presentation.suppressed ? "suppressed" : "live"} / {tab}</p>
    {presentation.error ? <p role="alert" className="fixed top-5 right-5 z-50 bg-red-900 p-3">{presentation.error}<button onClick={presentation.retry}>Retry presentation</button></p> : null}
    <div ref={viewport} data-fixture-viewport="" style={{ position: "absolute", left: "50%", right: 10, top: 240, bottom: 10, background: "#172554" }}>
      {presentation.suppressed ? "关闭浮层后继续浏览" : "Native Browser viewport"}
    </div>
    <div style={{ position: "absolute", top: 205, left: overlap ? "55%" : 20 }} className="flex gap-2">
      <Popover><PopoverTrigger>Popover</PopoverTrigger><PopoverContent><button>Popover action</button></PopoverContent></Popover>
      <Select><SelectTrigger aria-label="Fixture select"><SelectValue placeholder="Select" /></SelectTrigger><SelectContent><SelectItem value="one">Choice one</SelectItem><SelectItem value="two">Choice two</SelectItem></SelectContent></Select>
      <DropdownMenu><DropdownMenuTrigger>Menu</DropdownMenuTrigger><DropdownMenuContent><DropdownMenuItem>Menu action</DropdownMenuItem><DropdownMenuSub><DropdownMenuSubTrigger>Submenu</DropdownMenuSubTrigger><DropdownMenuSubContent><DropdownMenuItem>Nested action</DropdownMenuItem></DropdownMenuSubContent></DropdownMenuSub></DropdownMenuContent></DropdownMenu>
      <ContextMenu><ContextMenuTrigger>Right click</ContextMenuTrigger><ContextMenuContent><ContextMenuItem>Context action</ContextMenuItem></ContextMenuContent></ContextMenu>
      <Tooltip content="Tooltip over browser"><button>Tooltip</button></Tooltip>
    </div>
    {notice ? <div ref={noticeRef} role="status" className="fixed bottom-6 right-6 z-50 bg-orange-700 p-5">Fixture notice<button onClick={() => setNotice(false)}>Dismiss notice</button></div> : null}
    <AlertDialog open={alert} onOpenChange={setAlert}><AlertDialogContent><AlertDialogTitle>Fixture alert</AlertDialogTitle><AlertDialogDescription>Safe cancellation</AlertDialogDescription><AlertDialogCancel>Dismiss alert</AlertDialogCancel></AlertDialogContent></AlertDialog>
    <Sheet open={sheet} onOpenChange={setSheet}><SheetContent className="w-[480px]"><SheetTitle>Fixture sheet</SheetTitle><SheetDescription>Nested layer fixture</SheetDescription>
      <Dialog><DialogTrigger>Nested dialog</DialogTrigger><DialogContent><DialogTitle>Nested fixture</DialogTitle><DialogDescription>Close only inner layer</DialogDescription><Select><SelectTrigger><SelectValue placeholder="Nested select" /></SelectTrigger><SelectContent><SelectItem value="one">Nested choice</SelectItem></SelectContent></Select><button onClick={() => setSheet(false)}>Unmount outer sheet</button></DialogContent></Dialog>
    </SheetContent></Sheet>
    <RunweaveImageLightbox src={image} alt="Fixture explicit image" open={lightbox} onClose={() => setLightbox(false)} />
  </div></OverlayProvider>;
}

export function mountBrowserOverlayHarness() {
  if (!import.meta.env.DEV && import.meta.env.VITE_RUNWEAVE_CHANNEL !== "beta") throw new Error("Development fixture only");
  root?.unmount(); host?.remove();
  host = document.createElement("div"); host.id = "browser-overlay-harness";
  document.body.append(host); root = createRoot(host); root.render(<Harness />);
}
export async function unmountBrowserOverlayHarness() {
  injectPresentationFault("none");
  root?.unmount(); host?.remove(); root = null; host = null;
  for (const id of created.splice(0)) await window.electronAPI?.terminalBrowserCloseTab?.(id);
}

declare global {
  interface Window {
    browserOverlayHarness?: {
      createTab: typeof createHarnessTab;
      setActive: typeof setHarnessToolActive;
      cleanup: typeof unmountBrowserOverlayHarness;
      injectFault: typeof injectPresentationFault;
    };
  }
}
if (import.meta.env.DEV || import.meta.env.VITE_RUNWEAVE_CHANNEL === "beta") {
  window.browserOverlayHarness = { createTab: createHarnessTab, setActive: setHarnessToolActive, cleanup: unmountBrowserOverlayHarness, injectFault: injectPresentationFault };
}
