import { ANNOTATION_TARGET_RUNTIME } from "./target-runtime.js";
import { TERMINAL_BROWSER_ANNOTATION_STYLE } from "./style.js";

export const TERMINAL_BROWSER_ANNOTATION_RUNTIME_GLOBAL =
  "__runweaveTerminalBrowserAnnotation";

/** @param {{ changeEvent?: string, commentLimit?: number, maxAnnotations?: number, requestSubmit?: boolean }} [options] */
export function buildAnnotationRuntimeScript(options = {}) {
  return `(() => {
    const globalName = ${JSON.stringify(TERMINAL_BROWSER_ANNOTATION_RUNTIME_GLOBAL)};
    const options = ${JSON.stringify(options)};
    if (window[globalName]?.active) {
      return window[globalName].setSelecting(true);
    }

    ${ANNOTATION_TARGET_RUNTIME}
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
    const validation = document.createElement("div");
    validation.style.cssText = "position:absolute;top:calc(100% + 4px);left:0;width:100%;background:#2f2f2f;border-radius:8px;color:#fda4af;font-size:12px;padding:4px 8px";
    validation.hidden = true;
    validation.setAttribute("role", "status");
    editor.appendChild(validation);

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
    const annotationElements = new Map();
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
      validation.textContent = "";
      validation.hidden = true;
      notify();
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
      notify();
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
      validation.textContent = "";
      validation.hidden = true;
      editSaveButton.disabled = false;
      sendButton.disabled = true;
      input.focus();
      input.select();
      notify();
    };
    const renderAnnotations = (capturingId = null) => {
      lockLayer.replaceChildren();
      for (const annotation of annotations) {
        if (capturingId && annotation.id !== capturingId) continue;
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

    let queued = false;
    const notify = () => {
      if (!options.changeEvent || queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        if (window[globalName]?.active) window.dispatchEvent(new CustomEvent(options.changeEvent, {
          detail: { state: list(), hasDraft: input.value.length > 0, error: validation.textContent || null },
        }));
      });
    };
    const validComment = (comment, adding = false) => {
      const error = options.commentLimit && comment.length > options.commentLimit
        ? "每条评论不超过 " + options.commentLimit + " 字符；原文已保留"
        : adding && options.maxAnnotations && annotations.length >= options.maxAnnotations
          ? "最多 " + options.maxAnnotations + " 条评论；原文已保留" : "";
      validation.textContent = error;
      validation.hidden = !error;
      notify();
      return !error && comment.trim().length > 0;
    };
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
      if (!validComment(comment, !editingAnnotationId)) return list();
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
      annotationElements.set(annotation.id, selectedElement);
      if (submitNow) {
        pendingSubmitRequestId = annotation.id;
      }
      hideEditor();
      renderAnnotations();
      notify();
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
      if (editingAnnotationId === id) hideEditor();
      annotations.splice(index, 1);
      annotationElements.delete(id);
      annotations.forEach((annotation, nextIndex) => {
        annotation.index = nextIndex + 1;
      });
      renderAnnotations();
      notify();
      return list();
    };
    const saveEdit = () => {
      if (submitting) {
        return list();
      }
      const comment = normalizeComment(input.value);
      const annotation = annotations.find((item) => item.id === editingAnnotationId);
      if (!validComment(comment)) return list();
      if (!annotation || !comment) {
        return list();
      }
      annotation.comment = comment;
      hideEditor();
      renderAnnotations();
      notify();
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
      notify();
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
      notify();
      return list();
    };
    const setSubmitting = (nextSubmitting) => {
      submitting = nextSubmitting === true;
      if (submitting) {
        selecting = false;
        hoverBox.style.display = "none";
        hideEditor();
      }
      renderAnnotations();
      notify();
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
      save(options.requestSubmit === true);
    });
    menuAddButton.addEventListener("click", () => {
      save(false);
    });
    cancelButton.addEventListener("click", hideEditor);
    editSaveButton.addEventListener("click", saveEdit);
    deleteButton.addEventListener("click", deleteEdit);
    input.addEventListener("input", () => {
      sendButton.disabled = !validComment(normalizeComment(input.value), !editingAnnotationId);
      editSaveButton.disabled = sendButton.disabled;
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
      prepareCapture: async (id) => {
        const annotation = annotations.find((item) => item.id === id);
        const element = annotationElements.get(id);
        if (!submitting || !annotation || !element?.isConnected) {
          throw new Error("评论目标已变化，请删除该评论并重新圈选。评论仍已保留。");
        }
        element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
        hidePreview();
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        annotation.target = targetForElement(element);
        renderAnnotations(id);
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return list();
      },
    };
    notify();
    return list();
  })()`;
}
