const data = await fetch("./mock-state.json").then((response) =>
  response.json(),
);
const params = new URLSearchParams(location.search);
const draft = document.querySelector("#draft");
const attachments = document.querySelector("#attachments");
const send = document.querySelector("#send");
const preview = document.querySelector("#preview");
const status = document.querySelector("#input-status");
let files = [];
let selectedId = null;
let toastTimer;
let attachmentNumber = 0;

function newAttachment(text) {
  attachmentNumber += 1;
  return {
    id: crypto.randomUUID(),
    name:
      attachmentNumber === 1
        ? data.attachmentName
        : `粘贴的文本 (${attachmentNumber}).txt`,
    text,
    pending: false,
  };
}

function describe(file) {
  return `${file.text.length.toLocaleString("zh-CN")} 字符 · ${(new Blob([file.text]).size / 1024).toFixed(1)} KB`;
}

function notify(message) {
  const toast = document.querySelector("#toast");
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.hidden = false;
  toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, 2600);
}

function syncInput() {
  draft.style.height = "auto";
  draft.style.height = `${Math.min(96, draft.scrollHeight)}px`;
  const pending = files.some((file) => file.pending);
  send.disabled = pending || (!draft.value.trim() && files.length === 0);
  status.hidden = !pending;
  status.textContent = pending ? "正在保存文本附件…" : "";
}

function renderAttachments() {
  attachments.replaceChildren();
  for (const file of files) {
    const card = document.createElement("div");
    card.className = `attachment${file.pending ? " pending" : ""}`;
    const open = document.createElement("button");
    open.className = "attachment-open";
    open.setAttribute("aria-label", `预览 ${file.name}`);
    open.disabled = file.pending;
    const icon = document.createElement("span");
    icon.className = "file-icon";
    icon.textContent = "TXT";
    const text = document.createElement("span");
    text.className = "attachment-text";
    const name = document.createElement("span");
    name.className = "attachment-name";
    name.textContent = file.name;
    const meta = document.createElement("span");
    meta.className = "attachment-meta";
    meta.textContent = file.pending ? "正在保存…" : describe(file);
    text.append(name, meta);
    open.append(icon, text);
    open.onclick = () => openPreview(file.id);
    const remove = document.createElement("button");
    remove.className = "attachment-remove";
    remove.textContent = "×";
    remove.setAttribute("aria-label", `移除 ${file.name}`);
    remove.onclick = () => removeAttachment(file.id);
    card.append(open, remove);
    attachments.append(card);
  }
  syncInput();
}

function removeAttachment(id) {
  files = files.filter((file) => file.id !== id);
  if (preview.open && selectedId === id) preview.close();
  renderAttachments();
  draft.focus();
}

function openPreview(id) {
  const file = files.find((file) => file.id === id);
  if (!file) return;
  selectedId = id;
  document.querySelector("#preview-title").textContent = file.name;
  document.querySelector("#preview-meta").textContent = describe(file);
  document.querySelector("#preview-content").textContent = file.text;
  preview.showModal();
}

function insertText(text) {
  draft.setRangeText(text, draft.selectionStart, draft.selectionEnd, "end");
  syncInput();
}

draft.addEventListener("input", syncInput);
window.addEventListener("resize", syncInput);
draft.addEventListener("paste", (event) => {
  const text = event.clipboardData?.getData("text/plain");
  if (!text || text.length < data.threshold) return;
  event.preventDefault();
  const file = newAttachment(text);
  file.pending = true;
  files.push(file);
  renderAttachments();
  setTimeout(() => {
    if (!files.some((candidate) => candidate.id === file.id)) return;
    file.pending = false;
    renderAttachments();
  }, 650);
});

document.querySelector("#close-preview").onclick = () => preview.close();
preview.addEventListener("click", (event) => {
  const rect = preview.getBoundingClientRect();
  if (
    event.target === preview &&
    (event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom)
  )
    preview.close();
});
document.querySelector("#remove-preview").onclick = () =>
  removeAttachment(selectedId);
document.querySelector("#restore").onclick = () => {
  const file = files.find((file) => file.id === selectedId);
  if (!file) return;
  insertText(file.text);
  removeAttachment(file.id);
  notify("文本已放回输入框");
};

function submitDraft() {
  if (send.disabled) return;
  const message = document.createElement("div");
  message.className = "sent-message";
  message.textContent = `› ${draft.value}`;
  for (const file of files) {
    const reference = document.createElement("span");
    reference.className = "sent-file";
    reference.textContent = `▤ ${file.name} · ${file.text.length.toLocaleString("zh-CN")} 字符`;
    message.append(reference);
  }
  document.querySelector("#terminal-output").append(message);
  message.scrollIntoView({ block: "nearest" });
  draft.value = "";
  files = [];
  renderAttachments();
  draft.focus();
}
send.onclick = submitDraft;
draft.addEventListener("keydown", (event) => {
  if (
    event.key === "Enter" &&
    !event.shiftKey &&
    !event.isComposing &&
    event.keyCode !== 229
  ) {
    event.preventDefault();
    submitDraft();
  }
});

draft.value = params.get("state") === "empty" ? "" : data.draft;
if (params.get("state") !== "empty")
  files.push(newAttachment(data.attachmentText));
renderAttachments();
draft.setSelectionRange(draft.value.length, draft.value.length);
if (params.get("state") === "preview") openPreview(files[0].id);

// This TUI is an interaction mock; no file or terminal input is sent.
if (params.get("mode") === "tui") {
  document.querySelector("#attachments").closest("section").hidden = true;
  const surface = document.querySelector("#tui-input");
  const tui = document.querySelector("#tui-draft");
  const notice = document.querySelector("#tui-notice");
  surface.hidden = false;
  tui.value = data.tuiDraft;
  let generation = 0;
  let dismissed = false;
  tui.addEventListener("input", () => generation++);
  const showNotice = (file, label) => {
    if (dismissed) return;
    notice.replaceChildren(document.createTextNode(`${file.name} · ${label}`));
    notice.hidden = false;
    for (const [label, action] of [
      ["预览", () => openPreview(file.id)],
      [
        "复制原文",
        () =>
          navigator.clipboard
            .writeText(file.text)
            .then(() => notify("原文已复制")),
      ],
      [
        "关闭",
        () => {
          dismissed = true;
          notice.hidden = true;
        },
      ],
    ]) {
      const button = document.createElement("button");
      button.textContent = label;
      button.onclick = action;
      notice.append(button);
    }
  };
  tui.addEventListener("paste", (event) => {
    const text = event.clipboardData?.getData("text/plain");
    if (!text || text.length < data.threshold) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const file = newAttachment(text);
    files.push(file);
    dismissed = false;
    const savedGeneration = generation;
    const start = tui.selectionStart;
    const end = tui.selectionEnd;
    showNotice(file, "正在保存…");
    setTimeout(
      () => {
        if (
          savedGeneration !== generation ||
          params.get("state") === "changed"
        ) {
          showNotice(file, "目标或输入已变化，未插入路径");
          return;
        }
        const reference = ` ${JSON.stringify(data.tuiFilePath)} `;
        tui.setRangeText(reference, start, end, "end");
        showNotice(file, "已插入");
      },
      params.get("state") === "saving" ? 60000 : 650,
    );
  });
  document.querySelector("#restore").hidden = true;
  document.querySelector("#remove-preview").hidden = true;
}
