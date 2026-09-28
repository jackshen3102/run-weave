const byId = (id) => document.getElementById(id);
const clone = (value) => structuredClone(value);
let mock;
let lexicon = [];
let savedLexicon = [];
let correction = null;
let pendingTimer = null;
let toastTimer = null;
let currentKind = "note";
let selectedWord = "";
const dialogFocus = new Map();

function showToast(message, undo) {
  const toast = byId("toast");
  toast.replaceChildren(document.createTextNode(message));
  if (undo) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "撤销";
    button.addEventListener("click", () => {
      undo();
      showToast("已撤销词库添加");
    });
    toast.append(button);
  }
  toast.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add("hidden"), undo ? 8000 : 2400);
}

function setStatus(message, warning = false) {
  const status = byId("draft-status");
  status.textContent = message;
  status.classList.toggle("warning", warning);
}

function setDialog(name, open) {
  const overlay = byId(name + "-overlay");
  if (open) dialogFocus.set(name, document.activeElement);
  overlay.classList.toggle("hidden", !open);
  if (open) overlay.querySelector("input, button")?.focus();
  else dialogFocus.get(name)?.focus();
}

function showEditor() {
  byId("editor-view").classList.remove("hidden");
  byId("detail-view").classList.add("hidden");
}

function showDetail() {
  clearTimeout(pendingTimer);
  pendingTimer = null;
  correction = null;
  byId("correction-label").textContent = "纠正文字";
  setDialog("preview", false);
  updateCount();
  byId("editor-view").classList.add("hidden");
  byId("detail-view").classList.remove("hidden");
}

function updateCount() {
  const body = byId("record-body").value;
  byId("body-count").textContent = Array.from(body).length.toLocaleString() + " / 20,000";
  byId("correct-text").disabled = !body.trim() || Boolean(pendingTimer);
}

function updateKind() {
  document.querySelectorAll("[data-kind]").forEach((button) => {
    button.classList.toggle("active", button.dataset.kind === currentKind);
  });
}

function renderLexicon() {
  const list = byId("lexicon-list");
  list.replaceChildren();
  lexicon.forEach((entry, index) => {
    const item = document.createElement("div");
    item.className = "lexicon-item";
    const title = document.createElement("div");
    const canonical = document.createElement("strong");
    canonical.textContent = entry.canonical;
    const variants = document.createElement("span");
    variants.textContent = entry.variants.length
      ? "常见误识别：" + entry.variants.join("、")
      : "暂无常见误识别写法";
    title.append(canonical, variants);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "移除";
    remove.setAttribute("aria-label", "移除" + entry.canonical);
    remove.addEventListener("click", () => {
      lexicon.splice(index, 1);
      renderLexicon();
    });
    item.append(title, remove);
    list.append(item);
  });
}

function addLexiconEntry(event) {
  event.preventDefault();
  const canonical = byId("canonical-input").value.trim();
  const variants = byId("variant-input").value
    .split(/[，,]/)
    .map((value) => value.trim())
    .filter(Boolean);
  const error = byId("lexicon-error");
  const existing = new Set(lexicon.flatMap((entry) => [entry.canonical, ...entry.variants]));
  const proposed = [canonical, ...variants];
  let problem = "";
  if (!canonical) problem = "请输入标准写法。";
  else if (variants.length > 5) problem = "每条最多添加 5 个常见误识别写法。";
  else if (proposed.some((term) => Array.from(term).length > 80)) problem = "词条最多 80 个字符。";
  else if (new Set(proposed).size !== proposed.length || proposed.some((term) => existing.has(term)))
    problem = "词条不能重复。";
  else if (lexicon.length >= 200) problem = "词库最多 200 条。";
  error.textContent = problem;
  error.classList.toggle("hidden", !problem);
  if (problem) return;
  lexicon.push({ canonical, variants });
  byId("lexicon-form").reset();
  renderLexicon();
  byId("canonical-input").focus();
}

function correctedText(source, entries) {
  let text = source;
  for (const entry of entries) {
    for (const variant of entry.variants) text = text.replaceAll(variant, entry.canonical);
  }
  for (const replacement of mock.correction.replacements) {
    text = text.replaceAll(replacement.from, replacement.to);
  }
  return text;
}

function spellingChanges(source, candidate, entries) {
  const pairs = entries.flatMap((entry) => entry.variants.map((variant) => ({
    from: variant, to: entry.canonical,
  })));
  pairs.push(...mock.correction.replacements.filter((item) => item.kind === "spelling"));
  return pairs.filter((pair) => source.includes(pair.from) && candidate.includes(pair.to));
}

function renderCandidate() {
  const container = byId("preview-candidate");
  container.replaceChildren();
  const words = [...new Set(correction.spelling.map((pair) => pair.to))];
  let remaining = correction.candidate;
  while (remaining) {
    const next = words.map((word) => ({ word, index: remaining.indexOf(word) }))
      .filter((item) => item.index >= 0).sort((a, b) => a.index - b.index)[0];
    if (!next) {
      container.append(document.createTextNode(remaining));
      break;
    }
    container.append(document.createTextNode(remaining.slice(0, next.index)));
    const pair = correction.spelling.find((item) => item.to === next.word);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "corrected-word";
    button.textContent = next.word;
    button.setAttribute("aria-label", "记住写法：" + next.word);
    button.title = pair.from + " → " + next.word;
    button.addEventListener("click", () => openRemember(next.word, pair.from));
    container.append(button);
    remaining = remaining.slice(next.index + next.word.length);
  }
}

function updateSelection() {
  const editor = byId("record-body");
  selectedWord = editor.value.slice(editor.selectionStart, editor.selectionEnd).trim();
  const valid = selectedWord.length > 0 && Array.from(selectedWord).length <= 80 && !selectedWord.includes("\n");
  byId("remember-selection").classList.toggle("hidden", !valid);
}

function openRemember(canonical, variant = "") {
  byId("remember-canonical").value = canonical;
  byId("remember-variant").value = variant;
  byId("remember-error").classList.add("hidden");
  setDialog("remember", true);
  byId("remember-canonical").focus();
}

function rememberWord(event) {
  event.preventDefault();
  const canonical = byId("remember-canonical").value.trim();
  const variant = byId("remember-variant").value.trim();
  const entry = savedLexicon.find((item) => item.canonical === canonical);
  const conflict = savedLexicon.some((item) =>
    item.variants.includes(canonical) || (variant && item !== entry &&
      (item.canonical === variant || item.variants.includes(variant))));
  let problem = "";
  if (!canonical) problem = "请输入正确写法。";
  else if (canonical === variant) problem = "两种写法相同，请清空误识别写法。";
  else if (conflict) problem = "这个写法已属于其他词条，请在词库中修改。";
  else if (entry && (!variant || entry.variants.includes(variant))) problem = "词库已记住这个写法。";
  else if (entry?.variants.length >= 5) problem = "该词条已有 5 个误识别写法，请在词库中修改。";
  else if (!entry && savedLexicon.length >= 200) problem = "词库最多 200 条。";
  byId("remember-error").textContent = problem;
  byId("remember-error").classList.toggle("hidden", !problem);
  if (problem) return;
  const added = entry ?? { canonical, variants: [] };
  if (variant) added.variants.push(variant);
  if (!entry) savedLexicon.push(added);
  lexicon = clone(savedLexicon);
  setDialog("remember", false);
  showToast("已记住 " + canonical, () => {
    if (entry) added.variants = added.variants.filter((item) => item !== variant);
    else savedLexicon = savedLexicon.filter((item) => item !== added);
    lexicon = clone(savedLexicon);
  });
}

function openPreview() {
  byId("preview-original").textContent = correction.source;
  renderCandidate();
  byId("original-disclosure").open = false;
  const uncertain = mock.correction.uncertainTerms.filter(
    (term) =>
      correction.source.includes(term) &&
      !correction.entries.some((entry) => entry.canonical === term || entry.variants.includes(term)),
  );
  byId("uncertain-note").textContent = uncertain.length
    ? "尚不确定：" + uncertain.join("、") + "。已保留原文，请自行核对。"
    : "";
  byId("uncertain-note").classList.toggle("hidden", !uncertain.length);
  const stale = byId("record-body").value !== correction.source;
  byId("stale-note").classList.toggle("hidden", !stale);
  byId("apply-correction").disabled = stale;
  setDialog("preview", true);
}

function startCorrection() {
  const source = byId("record-body").value;
  if (!source.trim() || pendingTimer) return;
  const entries = clone(savedLexicon);
  byId("correction-label").textContent = "正在纠正…";
  setStatus("正在生成候选，草稿仍可编辑");
  updateCount();
  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    const candidate = correctedText(source, entries);
    correction = {
      source,
      candidate,
      entries,
      spelling: spellingChanges(source, candidate, entries),
    };
    byId("correction-label").textContent = "纠正文字";
    setStatus("候选已生成，尚未应用到草稿");
    updateCount();
    openPreview();
  }, 1000);
  updateCount();
}

function applyCorrection() {
  if (!correction) return;
  if (byId("record-body").value !== correction.source) {
    openPreview();
    return;
  }
  byId("record-body").value = correction.candidate;
  correction = null;
  updateCount();
  setDialog("preview", false);
  updateSelection();
  setStatus("已应用到草稿，尚未保存");
  showToast("已应用到草稿");
}

function saveRecord() {
  const body = byId("record-body").value;
  if (!body.trim()) {
    setStatus("请输入正文后再保存", true);
    return;
  }
  mock.record.savedBody = body;
  byId("saved-body").textContent = body;
  byId("list-record-body").textContent = body;
  showDetail();
  showToast("已保存");
}

function bindEvents() {
  byId("record-body").addEventListener("input", () => {
    updateCount();
    setStatus("本机草稿已保存");
    updateSelection();
  });
  for (const eventName of ["select", "keyup", "mouseup", "touchend"]) {
    byId("record-body").addEventListener(eventName, updateSelection);
  }
  byId("remember-selection").addEventListener("click", () => openRemember(selectedWord));
  byId("remember-form").addEventListener("submit", rememberWord);
  for (const id of ["cancel-remember", "close-remember"]) {
    byId(id).addEventListener("click", () => setDialog("remember", false));
  }
  byId("correct-text").addEventListener("click", startCorrection);
  byId("apply-correction").addEventListener("click", applyCorrection);
  byId("cancel-preview").addEventListener("click", () => setDialog("preview", false));
  byId("close-preview").addEventListener("click", () => setDialog("preview", false));
  byId("save-record").addEventListener("click", saveRecord);
  byId("close-editor").addEventListener("click", showDetail);
  byId("back-to-list").addEventListener("click", showEditor);
  byId("edit-again").addEventListener("click", showEditor);
  byId("new-record").addEventListener("click", () => {
    clearTimeout(pendingTimer);
    pendingTimer = null;
    correction = null;
    byId("correction-label").textContent = "纠正文字";
    byId("record-body").value = "";
    currentKind = "note";
    updateKind();
    updateCount();
    setStatus("本机草稿已保存");
    showEditor();
  });
  document.querySelectorAll("[data-kind]").forEach((button) => {
    button.addEventListener("click", () => {
      currentKind = button.dataset.kind;
      updateKind();
    });
  });
  byId("open-lexicon").addEventListener("click", () => {
    byId("toast").classList.add("hidden");
    lexicon = clone(savedLexicon);
    byId("lexicon-form").reset();
    byId("lexicon-error").classList.add("hidden");
    renderLexicon();
    setDialog("lexicon", true);
  });
  byId("lexicon-form").addEventListener("submit", addLexiconEntry);
  byId("save-lexicon").addEventListener("click", () => {
    savedLexicon = clone(lexicon);
    setDialog("lexicon", false);
    showToast("词库已保存");
  });
  for (const id of ["cancel-lexicon", "close-lexicon"]) {
    byId(id).addEventListener("click", () => {
      lexicon = clone(savedLexicon);
      setDialog("lexicon", false);
    });
  }
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    for (const name of ["remember", "lexicon", "preview"]) {
      if (!byId(name + "-overlay").classList.contains("hidden")) {
        setDialog(name, false);
        break;
      }
    }
  });
}

fetch("./mock-state.json")
  .then((response) => {
    if (!response.ok) throw new Error("无法读取模拟数据");
    return response.json();
  })
  .then((data) => {
    mock = data;
    lexicon = clone(data.lexicon);
    savedLexicon = clone(data.lexicon);
    byId("record-body").value = data.record.body;
    byId("saved-body").textContent = data.record.savedBody;
    byId("list-record-body").textContent = data.record.savedBody;
    currentKind = data.record.kind;
    updateKind();
    updateCount();
    renderLexicon();
    bindEvents();
  })
  .catch((error) => {
    byId("draft-status").textContent = String(error);
    byId("draft-status").classList.add("warning");
  });
