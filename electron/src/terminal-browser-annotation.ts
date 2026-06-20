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
        pointer-events: auto;
        cursor: pointer;
        box-shadow: 0 8px 24px rgba(2, 6, 23, 0.35);
      }
      .rw-annotation-preview {
        position: fixed;
        max-width: 260px;
        min-height: 48px;
        border-radius: 22px;
        background: #2d2d2d;
        color: #ffffff;
        padding: 13px 18px;
        pointer-events: none;
        box-shadow: 0 16px 50px rgba(0, 0, 0, 0.34);
        font: 18px/1.25 ui-sans-serif, system-ui, sans-serif;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }
      .rw-annotation-editor {
        position: fixed;
        width: min(560px, calc(100vw - 24px));
        min-height: 64px;
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 999px;
        background: #2d2d2d;
        color: #e2e8f0;
        padding: 10px 10px 10px 16px;
        pointer-events: auto;
        box-shadow: 0 18px 60px rgba(0, 0, 0, 0.42);
        display: flex;
        align-items: center;
        gap: 12px;
      }
      .rw-annotation-tools {
        width: 30px;
        height: 30px;
        border: 0;
        border-radius: 999px;
        background: transparent;
        color: #b8b8b8;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        font: 20px/1 ui-sans-serif, system-ui, sans-serif;
      }
      .rw-annotation-tools:hover { background: rgba(255, 255, 255, 0.08); color: #ffffff; }
      .rw-annotation-input {
        flex: 1;
        min-width: 0;
        height: 40px;
        border: 0;
        background: transparent;
        color: #f8fafc;
        padding: 0;
        font: 18px/1.3 ui-sans-serif, system-ui, sans-serif;
        outline: none;
      }
      .rw-annotation-input::placeholder { color: rgba(248, 250, 252, 0.48); }
      .rw-annotation-send {
        width: 44px;
        height: 44px;
        border: 0;
        border-radius: 999px;
        background: #e5e7eb;
        color: #111827;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        font: 26px/1 ui-sans-serif, system-ui, sans-serif;
        cursor: pointer;
      }
      .rw-annotation-send:disabled { opacity: 0.45; cursor: default; }
      .rw-annotation-menu {
        position: fixed;
        min-width: 130px;
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 12px;
        background: #2f2f2f;
        color: #ffffff;
        padding: 6px;
        pointer-events: auto;
        box-shadow: 0 18px 60px rgba(0, 0, 0, 0.35);
      }
      .rw-annotation-menu[hidden] { display: none; }
      .rw-annotation-menu button {
        width: 100%;
        min-height: 36px;
        border: 0;
        border-radius: 8px;
        background: transparent;
        color: #ffffff;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 0 10px;
        font: 15px/1 ui-sans-serif, system-ui, sans-serif;
        cursor: pointer;
      }
      .rw-annotation-menu button:hover { background: rgba(255, 255, 255, 0.08); }
      .rw-annotation-shortcut {
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.16);
        color: rgba(255, 255, 255, 0.88);
        padding: 4px 8px;
        font-size: 13px;
      }
      .rw-annotation-edit-actions {
        display: none;
      }
      .rw-annotation-editor.rw-annotation-editor-editing {
        min-height: 156px;
        border-radius: 24px;
        align-items: flex-start;
        padding: 22px 22px 18px 22px;
        display: grid;
        grid-template-columns: 34px minmax(0, 1fr);
        grid-template-rows: minmax(44px, 1fr) auto;
        gap: 12px 16px;
      }
      .rw-annotation-editor.rw-annotation-editor-editing .rw-annotation-send,
      .rw-annotation-editor.rw-annotation-editor-editing .rw-annotation-menu {
        display: none;
      }
      .rw-annotation-editor.rw-annotation-editor-editing .rw-annotation-tools {
        margin-top: 3px;
      }
      .rw-annotation-editor.rw-annotation-editor-editing .rw-annotation-input {
        height: auto;
        min-height: 44px;
        align-self: start;
      }
      .rw-annotation-editor.rw-annotation-editor-editing .rw-annotation-edit-actions {
        grid-column: 1 / 3;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
      }
      .rw-annotation-editor.rw-annotation-editor-editing .rw-annotation-edit-buttons {
        display: flex;
        align-items: center;
        gap: 10px;
      }
      .rw-annotation-edit-delete,
      .rw-annotation-edit-cancel,
      .rw-annotation-edit-save {
        height: 44px;
        border: 0;
        border-radius: 999px;
        padding: 0 18px;
        font: 18px/1 ui-sans-serif, system-ui, sans-serif;
        cursor: pointer;
      }
      .rw-annotation-edit-delete {
        width: 44px;
        padding: 0;
        background: transparent;
        color: #ffffff;
        font-size: 24px;
      }
      .rw-annotation-edit-delete:hover,
      .rw-annotation-edit-cancel:hover {
        background: rgba(255, 255, 255, 0.08);
      }
      .rw-annotation-edit-cancel {
        background: transparent;
        border: 1px solid rgba(255, 255, 255, 0.14);
        color: #ffffff;
      }
      .rw-annotation-edit-save {
        background: #ffffff;
        color: #1f2937;
      }
    \`;
    root.appendChild(style);

    const hoverBox = document.createElement("div");
    hoverBox.className = "rw-annotation-hover";
    hoverBox.style.display = "none";
    root.appendChild(hoverBox);

    const lockLayer = document.createElement("div");
    root.appendChild(lockLayer);

    const preview = document.createElement("div");
    preview.className = "rw-annotation-preview";
    preview.style.display = "none";
    root.appendChild(preview);

    const editor = document.createElement("div");
    editor.className = "rw-annotation-editor";
    editor.style.display = "none";
    editor.innerHTML = \`
      <button type="button" class="rw-annotation-tools" aria-label="Comment options">⌘</button>
      <input class="rw-annotation-input" aria-label="Browser annotation comment" placeholder="添加评论..." />
      <button type="button" class="rw-annotation-send" aria-label="发送评论">↑</button>
      <div class="rw-annotation-edit-actions">
        <button type="button" class="rw-annotation-edit-delete" aria-label="删除评论">⌫</button>
        <div class="rw-annotation-edit-buttons">
          <button type="button" class="rw-annotation-edit-cancel">取消</button>
          <button type="button" class="rw-annotation-edit-save">保存</button>
        </div>
      </div>
    \`;
    root.appendChild(editor);

    const menu = document.createElement("div");
    menu.className = "rw-annotation-menu";
    menu.hidden = true;
    menu.innerHTML = \`
      <button type="button" class="rw-annotation-menu-send"><span>发送</span><span class="rw-annotation-shortcut">↵</span></button>
      <button type="button" class="rw-annotation-menu-add"><span>添加</span><span class="rw-annotation-shortcut">⌘↵</span></button>
    \`;
    root.appendChild(menu);

    document.documentElement.appendChild(root);

    const input = editor.querySelector(".rw-annotation-input");
    const toolsButton = editor.querySelector(".rw-annotation-tools");
    const sendButton = editor.querySelector(".rw-annotation-send");
    const deleteButton = editor.querySelector(".rw-annotation-edit-delete");
    const cancelButton = editor.querySelector(".rw-annotation-edit-cancel");
    const editSaveButton = editor.querySelector(".rw-annotation-edit-save");
    const menuSendButton = menu.querySelector(".rw-annotation-menu-send");
    const menuAddButton = menu.querySelector(".rw-annotation-menu-add");
    const annotations = [];
    let pendingSubmitRequestId = null;
    let selectedElement = null;
    let selectedTarget = null;
    let editingAnnotationId = null;

    const placeBox = (box, rect) => {
      box.style.left = Math.round(rect.left) + "px";
      box.style.top = Math.round(rect.top) + "px";
      box.style.width = Math.max(1, Math.round(rect.width)) + "px";
      box.style.height = Math.max(1, Math.round(rect.height)) + "px";
      box.style.display = "block";
    };
    const isEditorEvent = (event) => root.contains(event.target);
    const targetElementFromEvent = (event) => {
      const element = currentElementAt(event);
      if (element) {
        return element;
      }
      const target = event.target;
      if (target instanceof Element && target !== document.documentElement && target !== document.body) {
        return target;
      }
      return null;
    };
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
      editor.classList.remove("rw-annotation-editor-editing");
      menu.hidden = true;
      selectedElement = null;
      selectedTarget = null;
      editingAnnotationId = null;
      input.value = "";
      sendButton.disabled = true;
    };
    const hidePreview = () => {
      preview.style.display = "none";
      preview.textContent = "";
    };
    const placePreview = (annotation) => {
      preview.textContent = annotation.comment;
      preview.style.display = "block";
      const markerLeft = annotation.target.rect.x + annotation.target.rect.width - 16;
      const markerTop = annotation.target.rect.y - 16;
      const rect = preview.getBoundingClientRect();
      const left = Math.min(
        Math.max(8, markerLeft + 40),
        Math.max(8, window.innerWidth - rect.width - 8),
      );
      const top = Math.min(
        Math.max(8, markerTop - 8),
        Math.max(8, window.innerHeight - rect.height - 8),
      );
      preview.style.left = Math.round(left) + "px";
      preview.style.top = Math.round(top) + "px";
    };
    const placeMenu = () => {
      const editorRect = editor.getBoundingClientRect();
      const menuWidth = 130;
      const left = Math.min(
        Math.max(8, editorRect.right - menuWidth - 28),
        Math.max(8, window.innerWidth - menuWidth - 8),
      );
      const top = Math.max(8, editorRect.top - 90);
      menu.style.left = Math.round(left) + "px";
      menu.style.top = Math.round(top) + "px";
    };
    const toggleMenu = () => {
      if (menu.hidden) {
        placeMenu();
        menu.hidden = false;
      } else {
        menu.hidden = true;
      }
    };
    const showEditor = (element) => {
      hidePreview();
      selectedElement = element;
      selectedTarget = targetForElement(element);
      editingAnnotationId = null;
      editor.classList.remove("rw-annotation-editor-editing");
      const rect = element.getBoundingClientRect();
      const editorWidth = Math.min(560, Math.max(320, window.innerWidth - 24));
      const left = Math.min(Math.max(12, rect.left), Math.max(12, window.innerWidth - editorWidth - 12));
      const below = rect.bottom + 10;
      const top = below + 76 < window.innerHeight ? below : Math.max(12, rect.top - 80);
      editor.style.left = Math.round(left) + "px";
      editor.style.top = Math.round(top) + "px";
      editor.style.display = "flex";
      editor.style.width = Math.round(editorWidth) + "px";
      input.value = "";
      sendButton.disabled = true;
      menu.hidden = true;
      input.focus();
    };
    const showEditEditor = (annotation) => {
      hidePreview();
      selectedElement = null;
      selectedTarget = null;
      editingAnnotationId = annotation.id;
      const editorWidth = Math.min(560, Math.max(320, window.innerWidth - 24));
      const left = Math.min(
        Math.max(12, annotation.target.rect.x),
        Math.max(12, window.innerWidth - editorWidth - 12),
      );
      const below = annotation.target.rect.y + annotation.target.rect.height + 10;
      const top = below + 168 < window.innerHeight
        ? below
        : Math.max(12, annotation.target.rect.y - 170);
      editor.style.left = Math.round(left) + "px";
      editor.style.top = Math.round(top) + "px";
      editor.style.width = Math.round(editorWidth) + "px";
      editor.classList.add("rw-annotation-editor-editing");
      editor.style.display = "grid";
      menu.hidden = true;
      input.value = annotation.comment;
      sendButton.disabled = true;
      input.focus();
      input.select();
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
        marker.addEventListener("mouseenter", () => placePreview(annotation));
        marker.addEventListener("mouseleave", hidePreview);
        marker.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          showEditEditor(annotation);
        });
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
      pendingSubmitRequestId,
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
      event.preventDefault();
      event.stopPropagation();
      const element = targetElementFromEvent(event);
      if (!element) {
        return;
      }
      showEditor(element);
    };
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        hideEditor();
      }
    };
    const save = (submitNow = false) => {
      const comment = trimText(input.value, 4000);
      if (!comment || !selectedElement || !selectedTarget) {
        if (editingAnnotationId) {
          const annotation = annotations.find((item) => item.id === editingAnnotationId);
          if (annotation && comment) {
            annotation.comment = comment;
            hideEditor();
            renderAnnotations();
            return list();
          }
        }
        return list();
      }
      const annotation = {
        id: "annotation-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8),
        index: annotations.length + 1,
        comment,
        target: selectedTarget,
      };
      annotations.push(annotation);
      if (submitNow) {
        pendingSubmitRequestId = annotation.id;
      }
      hideEditor();
      renderAnnotations();
      return list();
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
    const saveEdit = () => {
      const comment = trimText(input.value, 4000);
      const annotation = annotations.find((item) => item.id === editingAnnotationId);
      if (!annotation || !comment) {
        return list();
      }
      annotation.comment = comment;
      hideEditor();
      renderAnnotations();
      return list();
    };
    const deleteEdit = () => {
      if (!editingAnnotationId) {
        return list();
      }
      const state = remove(editingAnnotationId);
      hideEditor();
      return state;
    };
    const consumeSubmitRequest = () => {
      pendingSubmitRequestId = null;
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

    toolsButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (editingAnnotationId) {
        return;
      }
      toggleMenu();
    });
    sendButton.addEventListener("click", () => {
      save(false);
    });
    menuSendButton.addEventListener("click", () => {
      save(true);
    });
    menuAddButton.addEventListener("click", () => {
      save(false);
    });
    cancelButton.addEventListener("click", hideEditor);
    editSaveButton.addEventListener("click", saveEdit);
    deleteButton.addEventListener("click", deleteEdit);
    input.addEventListener("input", () => {
      sendButton.disabled = trimText(input.value, 4000).length === 0;
    });
    input.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Escape") {
        event.preventDefault();
        hideEditor();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        if (editingAnnotationId) {
          saveEdit();
        } else {
          save(false);
        }
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        if (editingAnnotationId) {
          saveEdit();
        } else {
          save(false);
        }
      }
    });
    document.addEventListener("pointermove", onPointerMove, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKeyDown, true);

    window[globalName] = {
      active: true,
      list,
      remove,
      consumeSubmitRequest,
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
    pendingSubmitRequestId:
      typeof record.pendingSubmitRequestId === "string"
        ? record.pendingSubmitRequestId
        : null,
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
