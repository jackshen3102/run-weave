import type { TerminalBrowserAnnotationState } from "@runweave/shared/terminal-browser-annotation";

// Only adapts the shared Browser runtime to this document's capability channel.
// Selection, selectors, markers and the page editor belong to the shared runtime.
export function installReviewGuest(generation: string, globalName: string, changeEvent: string) {
  type Runtime = {
    list: () => TerminalBrowserAnnotationState;
    remove: (id: string) => void;
    focus: (id: string) => void;
    setSelecting: (value: boolean) => void;
    setSubmitting: (value: boolean) => void;
    consumeSubmitRequest: () => void;
    stop: () => void;
  };
  const runtime = (window as unknown as Record<string, Runtime>)[globalName];
  if (!runtime) return;
  let port: MessagePort | null = null;
  let stopped = false;
  let latest = { state: runtime.list(), hasDraft: false, error: null };
  const publish = (event: Event) => {
    latest = (event as CustomEvent<typeof latest>).detail;
    port?.postMessage({ kind: "state", generation, ...latest });
  };
  const stop = () => {
    stopped = true;
    window.removeEventListener("message", connect);
    window.removeEventListener(changeEvent, publish);
    runtime.stop();
    port?.close();
    port = null;
  };
  const connect = (event: MessageEvent) => {
    if (stopped || port || event.source !== parent || event.data?.kind !== "review-connect" ||
      event.data?.generation !== generation || event.ports.length !== 1) return;
    const connectedPort = event.ports[0];
    if (!connectedPort) return;
    port = connectedPort;
    connectedPort.onmessage = (message: MessageEvent) => {
      const data = message.data;
      if (!data || data.generation !== generation) return;
      if (data.kind === "stop") { stop(); return; }
      if (data.kind === "selecting" && typeof data.value === "boolean") runtime.setSelecting(data.value);
      if (data.kind === "submitting" && typeof data.value === "boolean") runtime.setSubmitting(data.value);
      if ((data.kind === "focus" || data.kind === "remove") && typeof data.id === "string" && data.id.length <= 100) (data.kind === "focus" ? runtime.focus : runtime.remove)(data.id);
      if (data.kind === "ack-submit") runtime.consumeSubmitRequest();
    };
    connectedPort.postMessage({ kind: "ready", generation });
    connectedPort.postMessage({ kind: "state", generation, ...latest });
  };
  window.addEventListener(changeEvent, publish);
  window.addEventListener("message", connect);
}

// A trusted outer document supplies frame-src for the guest's own navigation.
// The guest's CSP alone cannot restrict navigating its own browsing context.
export function installReviewFrame(generation: string) {
  const guest = document.querySelector<HTMLIFrameElement>("iframe");
  let connected = false;
  let loaded = false;
  guest?.addEventListener("load", () => {
    if (loaded) parent.postMessage({ kind: "review-navigation", generation }, "*");
    loaded = true;
  });
  window.addEventListener("message", (event: MessageEvent) => {
    if (connected || event.source !== parent || event.data?.kind !== "review-connect" ||
      event.data?.generation !== generation || event.ports.length !== 1 || !guest?.contentWindow) return;
    connected = true;
    guest.contentWindow.postMessage({ kind: "review-connect", generation }, "*", [event.ports[0]!]);
  });
}
