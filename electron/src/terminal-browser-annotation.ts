import type { WebContents } from "electron";
import type {
  TerminalBrowserAnnotationDraft,
  TerminalBrowserAnnotationRect,
  TerminalBrowserAnnotationState,
  TerminalBrowserAnnotationSubmission,
  TerminalBrowserAnnotationTarget,
} from "@runweave/shared";

interface AnnotationSession {
  webContents: WebContents;
}

const sessions = new Map<string, AnnotationSession>();

const RUNTIME_GLOBAL = "__runweaveTerminalBrowserAnnotation";

function buildAnnotationRuntimeScript(): string {
  return `(() => {
    const globalName = ${JSON.stringify(RUNTIME_GLOBAL)};
    if (window[globalName]?.active) {
      return window[globalName].list();
    }

    const cssEscape = (value) => {
      if (window.CSS?.escape) {
        return window.CSS.escape(value);
      }
      return String(value).replace(/[^a-zA-Z0-9_-]/g, (char) => "\\\\" + char);
    };
    const trimText = (value, max = 120) => {
      const text = String(value ?? "").replace(/\\s+/g, " ").trim();
      return text.length > max ? text.slice(0, max - 1) + "..." : text;
    };
    const elementLabel = (element) => {
      const aria = element.getAttribute("aria-label");
      const title = element.getAttribute("title");
      const text = trimText(element.innerText || element.textContent || "");
      return trimText(aria || title || text || element.tagName.toLowerCase());
    };
    const elementPath = (element) => {
      const parts = [];
      let current = element;
      while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 6) {
        parts.unshift(current.tagName.toLowerCase());
        if (current === document.body) {
          break;
        }
        current = current.parentElement;
      }
      return parts.join(" > ");
    };
    const nthOfType = (element) => {
      let index = 1;
      let sibling = element.previousElementSibling;
      while (sibling) {
        if (sibling.tagName === element.tagName) {
          index += 1;
        }
        sibling = sibling.previousElementSibling;
      }
      return index;
    };
    const elementSelector = (element) => {
      const testId = element.getAttribute("data-testid");
      if (testId) {
        return '[data-testid="' + cssEscape(testId) + '"]';
      }
      if (element.id) {
        return "#" + cssEscape(element.id);
      }
      const aria = element.getAttribute("aria-label");
      if (aria) {
        return element.tagName.toLowerCase() + '[aria-label="' + cssEscape(aria) + '"]';
      }
      const parts = [];
      let current = element;
      while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.body) {
        const tag = current.tagName.toLowerCase();
        parts.unshift(tag + ":nth-of-type(" + nthOfType(current) + ")");
        if (current.id) {
          parts[0] = tag + "#" + cssEscape(current.id);
          break;
        }
        current = current.parentElement;
      }
      return parts.join(" > ") || element.tagName.toLowerCase();
    };
    const targetForElement = (element) => {
      const rect = element.getBoundingClientRect();
      const viewport = {
        width: Math.round(window.innerWidth),
        height: Math.round(window.innerHeight),
      };
      return {
        pageUrl: window.location.href,
        frameLabel: window.self === window.top ? "top document" : window.location.href,
        targetText: elementLabel(element),
        targetSelector: elementSelector(element),
        targetPath: elementPath(element),
        nodePosition: {
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
        },
        viewport,
        rect: {
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
        devicePixelRatio: window.devicePixelRatio || 1,
      };
    };

    const root = document.createElement("div");
    root.id = "runweave-browser-annotation-root";
    root.style.cssText = [
      "position:fixed",
      "inset:0",
      "z-index:2147483647",
      "pointer-events:none",
      "font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif",
    ].join(";");

    const style = document.createElement("style");
    style.textContent = \`
      #runweave-browser-annotation-root * { box-sizing: border-box; }
      .rw-annotation-hover, .rw-annotation-lock {
        position: fixed;
        border: 2px solid #1494ff;
        background: rgba(20, 148, 255, 0.08);
        border-radius: 2px;
        pointer-events: none;
        box-shadow: 0 0 0 1px rgba(2, 6, 23, 0.5);
      }
      .rw-annotation-lock { border-width: 3px; }
      .rw-annotation-marker {
        position: fixed;
        width: 32px;
        height: 32px;
        border-radius: 999px;
        border: 3px solid #ffffff;
        background: #1494ff;
        color: #ffffff;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 14px;
        font-weight: 700;
        line-height: 1;
        pointer-events: none;
        box-shadow: 0 8px 24px rgba(2, 6, 23, 0.35);
      }
      .rw-annotation-editor {
        position: fixed;
        width: 280px;
        border: 1px solid rgba(148, 163, 184, 0.45);
        border-radius: 8px;
        background: #020617;
        color: #e2e8f0;
        padding: 10px;
        pointer-events: auto;
        box-shadow: 0 20px 70px rgba(2, 6, 23, 0.45);
      }
      .rw-annotation-editor textarea {
        width: 100%;
        min-height: 84px;
        resize: vertical;
        border: 1px solid #334155;
        border-radius: 6px;
        background: #0f172a;
        color: #f8fafc;
        padding: 8px;
        font: 12px/1.4 ui-sans-serif, system-ui, sans-serif;
        outline: none;
      }
      .rw-annotation-editor textarea:focus { border-color: #38bdf8; }
      .rw-annotation-editor-row {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        margin-top: 8px;
      }
      .rw-annotation-editor button {
        height: 28px;
        border: 0;
        border-radius: 6px;
        padding: 0 10px;
        font: 12px/1 ui-sans-serif, system-ui, sans-serif;
        cursor: pointer;
      }
      .rw-annotation-editor-cancel { background: #1e293b; color: #cbd5e1; }
      .rw-annotation-editor-save { background: #0284c7; color: #ffffff; }
    \`;
    root.appendChild(style);

    const hoverBox = document.createElement("div");
    hoverBox.className = "rw-annotation-hover";
    hoverBox.style.display = "none";
    root.appendChild(hoverBox);

    const lockLayer = document.createElement("div");
    root.appendChild(lockLayer);

    const editor = document.createElement("div");
    editor.className = "rw-annotation-editor";
    editor.style.display = "none";
    editor.innerHTML = \`
      <textarea aria-label="Browser annotation comment" placeholder="Comment"></textarea>
      <div class="rw-annotation-editor-row">
        <button type="button" class="rw-annotation-editor-cancel">Cancel</button>
        <button type="button" class="rw-annotation-editor-save">Save</button>
      </div>
    \`;
    root.appendChild(editor);

    document.documentElement.appendChild(root);

    const textarea = editor.querySelector("textarea");
    const cancelButton = editor.querySelector(".rw-annotation-editor-cancel");
    const saveButton = editor.querySelector(".rw-annotation-editor-save");
    const annotations = [];
    let selectedElement = null;
    let selectedTarget = null;

    const placeBox = (box, rect) => {
      box.style.left = Math.round(rect.left) + "px";
      box.style.top = Math.round(rect.top) + "px";
      box.style.width = Math.max(1, Math.round(rect.width)) + "px";
      box.style.height = Math.max(1, Math.round(rect.height)) + "px";
      box.style.display = "block";
    };
    const isEditorEvent = (event) => editor.contains(event.target);
    const currentElementAt = (event) => {
      root.style.display = "none";
      const element = document.elementFromPoint(event.clientX, event.clientY);
      root.style.display = "";
      if (!element || element === document.documentElement || element === document.body) {
        return null;
      }
      return element;
    };
    const hideEditor = () => {
      editor.style.display = "none";
      selectedElement = null;
      selectedTarget = null;
      textarea.value = "";
    };
    const showEditor = (element) => {
      selectedElement = element;
      selectedTarget = targetForElement(element);
      const rect = element.getBoundingClientRect();
      const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - 288));
      const below = rect.bottom + 10;
      const top = below + 150 < window.innerHeight ? below : Math.max(8, rect.top - 152);
      editor.style.left = Math.round(left) + "px";
      editor.style.top = Math.round(top) + "px";
      editor.style.display = "block";
      textarea.value = "";
      textarea.focus();
    };
    const renderAnnotations = () => {
      lockLayer.replaceChildren();
      for (const annotation of annotations) {
        const lock = document.createElement("div");
        lock.className = "rw-annotation-lock";
        lock.style.left = annotation.target.rect.x + "px";
        lock.style.top = annotation.target.rect.y + "px";
        lock.style.width = Math.max(1, annotation.target.rect.width) + "px";
        lock.style.height = Math.max(1, annotation.target.rect.height) + "px";
        lockLayer.appendChild(lock);

        const marker = document.createElement("div");
        marker.className = "rw-annotation-marker";
        marker.textContent = String(annotation.index);
        marker.style.left = Math.max(4, annotation.target.rect.x + annotation.target.rect.width - 16) + "px";
        marker.style.top = Math.max(4, annotation.target.rect.y - 16) + "px";
        lockLayer.appendChild(marker);
      }
    };
    const list = () => ({
      active: true,
      annotations: annotations.map((annotation) => ({
        id: annotation.id,
        index: annotation.index,
        comment: annotation.comment,
        target: annotation.target,
      })),
    });

    const onPointerMove = (event) => {
      if (isEditorEvent(event)) {
        return;
      }
      const element = currentElementAt(event);
      if (!element) {
        hoverBox.style.display = "none";
        return;
      }
      placeBox(hoverBox, element.getBoundingClientRect());
    };
    const onClick = (event) => {
      if (isEditorEvent(event)) {
        return;
      }
      const element = currentElementAt(event);
      if (!element) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      showEditor(element);
    };
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        hideEditor();
      }
    };
    const save = () => {
      const comment = trimText(textarea.value, 4000);
      if (!comment || !selectedElement || !selectedTarget) {
        return;
      }
      annotations.push({
        id: "annotation-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8),
        index: annotations.length + 1,
        comment,
        target: selectedTarget,
      });
      hideEditor();
      renderAnnotations();
    };
    const remove = (id) => {
      const index = annotations.findIndex((annotation) => annotation.id === id);
      if (index < 0) {
        return list();
      }
      annotations.splice(index, 1);
      annotations.forEach((annotation, nextIndex) => {
        annotation.index = nextIndex + 1;
      });
      renderAnnotations();
      return list();
    };
    const stop = () => {
      document.removeEventListener("pointermove", onPointerMove, true);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKeyDown, true);
      root.remove();
      delete window[globalName];
      return { active: false, annotations: [] };
    };

    cancelButton.addEventListener("click", hideEditor);
    saveButton.addEventListener("click", save);
    textarea.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Escape") {
        event.preventDefault();
        hideEditor();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        save();
      }
    });
    document.addEventListener("pointermove", onPointerMove, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKeyDown, true);

    window[globalName] = {
      active: true,
      list,
      remove,
      stop,
      submit: list,
    };
    return list();
  })()`;
}

function buildRuntimeCallScript(method: string, argument?: string): string {
  const globalName = JSON.stringify(RUNTIME_GLOBAL);
  const methodName = JSON.stringify(method);
  const args = argument === undefined ? "" : JSON.stringify(argument);
  return `(() => {
    const runtime = window[${globalName}];
    if (!runtime?.active || typeof runtime[${methodName}] !== "function") {
      return { active: false, annotations: [] };
    }
    return runtime[${methodName}](${args});
  })()`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeRect(value: unknown): TerminalBrowserAnnotationRect {
  const record = isRecord(value) ? value : {};
  return {
    x: normalizeNumber(record.x),
    y: normalizeNumber(record.y),
    width: normalizeNumber(record.width),
    height: normalizeNumber(record.height),
  };
}

function normalizeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function normalizeTarget(value: unknown): TerminalBrowserAnnotationTarget {
  const record = isRecord(value) ? value : {};
  const viewport = isRecord(record.viewport) ? record.viewport : {};
  const nodePosition = isRecord(record.nodePosition) ? record.nodePosition : {};
  return {
    pageUrl: normalizeString(record.pageUrl),
    frameLabel: normalizeString(record.frameLabel) || "top document",
    targetText: normalizeString(record.targetText),
    targetSelector: normalizeString(record.targetSelector),
    targetPath: normalizeString(record.targetPath),
    nodePosition: {
      x: normalizeNumber(nodePosition.x),
      y: normalizeNumber(nodePosition.y),
    },
    viewport: {
      width: normalizeNumber(viewport.width),
      height: normalizeNumber(viewport.height),
    },
    rect: normalizeRect(record.rect),
    devicePixelRatio: normalizeNumber(record.devicePixelRatio) || 1,
  };
}

function normalizeDraft(value: unknown): TerminalBrowserAnnotationDraft | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = normalizeString(value.id);
  const comment = normalizeString(value.comment);
  if (!id || !comment) {
    return null;
  }
  return {
    id,
    index: Math.max(1, Math.round(normalizeNumber(value.index))),
    comment,
    target: normalizeTarget(value.target),
  };
}

function normalizeState(value: unknown): TerminalBrowserAnnotationState {
  const record = isRecord(value) ? value : {};
  const annotations = Array.isArray(record.annotations)
    ? record.annotations
        .map(normalizeDraft)
        .filter((draft): draft is TerminalBrowserAnnotationDraft => draft !== null)
    : [];
  return {
    active: record.active === true,
    annotations,
  };
}

async function callAnnotationRuntime(
  key: string,
  method: string,
  argument?: string,
): Promise<TerminalBrowserAnnotationState> {
  const session = sessions.get(key);
  if (!session || session.webContents.isDestroyed()) {
    sessions.delete(key);
    return { active: false, annotations: [] };
  }
  try {
    const result = await session.webContents.executeJavaScript(
      buildRuntimeCallScript(method, argument),
      true,
    );
    const state = normalizeState(result);
    if (!state.active) {
      sessions.delete(key);
    }
    return state;
  } catch {
    sessions.delete(key);
    return { active: false, annotations: [] };
  }
}

export async function startTerminalBrowserAnnotation(
  key: string,
  webContents: WebContents,
): Promise<TerminalBrowserAnnotationState> {
  sessions.set(key, { webContents });
  const result = await webContents.executeJavaScript(buildAnnotationRuntimeScript(), true);
  return normalizeState(result);
}

export async function listTerminalBrowserAnnotations(
  key: string,
): Promise<TerminalBrowserAnnotationState> {
  return await callAnnotationRuntime(key, "list");
}

export async function deleteTerminalBrowserAnnotation(
  key: string,
  annotationId: string,
): Promise<TerminalBrowserAnnotationState> {
  return await callAnnotationRuntime(key, "remove", annotationId);
}

export async function stopTerminalBrowserAnnotation(
  key: string,
): Promise<TerminalBrowserAnnotationState> {
  return await callAnnotationRuntime(key, "stop");
}

export async function submitTerminalBrowserAnnotations(
  key: string,
): Promise<TerminalBrowserAnnotationSubmission> {
  const session = sessions.get(key);
  const state = await callAnnotationRuntime(key, "submit");
  if (!session || session.webContents.isDestroyed() || state.annotations.length === 0) {
    await stopTerminalBrowserAnnotation(key);
    return { annotations: state.annotations, screenshot: null };
  }

  const image = await session.webContents.capturePage();
  const screenshot = {
    mimeType: "image/png" as const,
    dataBase64: image.toPNG().toString("base64"),
  };
  await stopTerminalBrowserAnnotation(key);
  return { annotations: state.annotations, screenshot };
}

export function clearTerminalBrowserAnnotation(key: string): void {
  const session = sessions.get(key);
  sessions.delete(key);
  if (!session || session.webContents.isDestroyed()) {
    return;
  }
  void session.webContents
    .executeJavaScript(buildRuntimeCallScript("stop"), true)
    .catch(() => {
      // The page may already be navigating or destroyed; navigation also clears DOM.
    });
}

export function clearTerminalBrowserAnnotationsForWindow(windowId: number): void {
  const prefix = `${windowId}:`;
  for (const key of sessions.keys()) {
    if (key.startsWith(prefix)) {
      clearTerminalBrowserAnnotation(key);
    }
  }
}
