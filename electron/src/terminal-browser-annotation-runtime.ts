import { TERMINAL_BROWSER_ANNOTATION_STYLE } from "./terminal-browser-annotation-style.js";

export const TERMINAL_BROWSER_ANNOTATION_RUNTIME_GLOBAL =
  "__runweaveTerminalBrowserAnnotation";

export function buildAnnotationRuntimeScript(): string {
  return `(() => {
    const globalName = ${JSON.stringify(TERMINAL_BROWSER_ANNOTATION_RUNTIME_GLOBAL)};
    if (window[globalName]?.active) {
      return window[globalName].setSelecting(true);
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
    const normalizeComment = (value, max = 4000) => {
      const text = String(value ?? "").replace(/\\r\\n?/g, "\\n").trim();
      return text.length > max ? text.slice(0, max) : text;
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

    style.textContent = ${JSON.stringify(TERMINAL_BROWSER_ANNOTATION_STYLE)};
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
      <textarea class="rw-annotation-input" aria-label="Browser annotation comment" placeholder="描述你希望 Agent 修改什么..."></textarea>
      <button type="button" class="rw-annotation-send" aria-label="添加评论">添加</button>
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
    let selecting = true;
    let submitting = false;
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
    const clampEditorLeft = (left, editorWidth) => Math.min(
      Math.max(12, left),
      Math.max(12, window.innerWidth - editorWidth - 12),
    );
    const placeEditorNearPoint = (point, editorWidth, editorHeight) => {
      const anchor = point ?? { x: window.innerWidth / 2, y: window.innerHeight / 2 };
      const left = clampEditorLeft(anchor.x - 36, editorWidth);
      const below = anchor.y + 12;
      const top = below + editorHeight <= window.innerHeight - 12
        ? below
        : Math.max(12, anchor.y - editorHeight - 12);
      editor.style.left = Math.round(left) + "px";
      editor.style.top = Math.round(top) + "px";
    };
    const showEditor = (element, point) => {
      hidePreview();
      selectedElement = element;
      selectedTarget = targetForElement(element);
      editingAnnotationId = null;
      editor.classList.remove("rw-annotation-editor-editing");
      const editorWidth = Math.min(420, Math.max(280, window.innerWidth - 24));
      editor.style.display = "flex";
      editor.style.width = Math.round(editorWidth) + "px";
      input.value = "";
      sendButton.disabled = true;
      menu.hidden = true;
      placeEditorNearPoint(point, editorWidth, editor.getBoundingClientRect().height);
      input.focus();
    };
    const showEditEditor = (annotation) => {
      hidePreview();
      selectedElement = null;
      selectedTarget = null;
      editingAnnotationId = annotation.id;
      const editorWidth = Math.min(420, Math.max(280, window.innerWidth - 24));
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
          if (submitting) {
            return;
          }
          showEditEditor(annotation);
        });
        lockLayer.appendChild(marker);
      }
    };
    const list = () => ({
      active: true,
      selecting,
      annotations: annotations.map((annotation) => ({
        id: annotation.id,
        index: annotation.index,
        comment: annotation.comment,
        target: annotation.target,
      })),
      pendingSubmitRequestId,
    });

    const onPointerMove = (event) => {
      if (submitting || !selecting) {
        hoverBox.style.display = "none";
        return;
      }
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
      if (submitting || !selecting) {
        return;
      }
      if (isEditorEvent(event)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const element = targetElementFromEvent(event);
      if (!element) {
        return;
      }
      showEditor(element, { x: event.clientX, y: event.clientY });
    };
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        hideEditor();
      }
    };
    const save = (submitNow = false) => {
      if (submitting) {
        return list();
      }
      const comment = normalizeComment(input.value);
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
      if (submitting) {
        return list();
      }
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
      if (submitting) {
        return list();
      }
      const comment = normalizeComment(input.value);
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
      if (submitting || !editingAnnotationId) {
        return list();
      }
      const state = remove(editingAnnotationId);
      hideEditor();
      return state;
    };
    const focus = (id) => {
      if (submitting) {
        return list();
      }
      const annotation = annotations.find((item) => item.id === id);
      if (!annotation) {
        return list();
      }
      selecting = false;
      hoverBox.style.display = "none";
      showEditEditor(annotation);
      return list();
    };
    const consumeSubmitRequest = () => {
      pendingSubmitRequestId = null;
      return list();
    };
    const setSelecting = (nextSelecting) => {
      if (submitting) {
        return list();
      }
      selecting = nextSelecting === true;
      if (!selecting) {
        hoverBox.style.display = "none";
        hideEditor();
      }
      return list();
    };
    const setSubmitting = (nextSubmitting) => {
      submitting = nextSubmitting === true;
      if (submitting) {
        selecting = false;
        hoverBox.style.display = "none";
        hideEditor();
      }
      return list();
    };
    const stop = () => {
      document.removeEventListener("pointermove", onPointerMove, true);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKeyDown, true);
      root.remove();
      delete window[globalName];
      return { active: false, selecting: false, annotations: [] };
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
      save(false);
    });
    menuAddButton.addEventListener("click", () => {
      save(false);
    });
    cancelButton.addEventListener("click", hideEditor);
    editSaveButton.addEventListener("click", saveEdit);
    deleteButton.addEventListener("click", deleteEdit);
    input.addEventListener("input", () => {
      sendButton.disabled = normalizeComment(input.value).length === 0;
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
    });
    document.addEventListener("pointermove", onPointerMove, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKeyDown, true);

    window[globalName] = {
      active: true,
      list,
      remove,
      focus,
      consumeSubmitRequest,
      setSelecting,
      setSubmitting,
      stop,
      submit: () => setSubmitting(true),
    };
    return list();
  })()`;
}
