const settingsTrigger = document.querySelector("#modelSettingsTrigger");
const modelPanel = document.querySelector("#modelPanel");
const reasoningPanel = document.querySelector("#reasoningPanel");
const modelList = document.querySelector("#modelList");
const reasoningList = document.querySelector("#reasoningList");
const modelCurrent = document.querySelector("#modelCurrent");
const reasoningModel = document.querySelector("#reasoningModel");
const activeSettings = document.querySelector("#activeSettings");
let state;

function selectedModel() {
  return state.models.find((model) => model.id === state.activeModelId);
}

function updateSummary() {
  const effort = state.reasoningLabels[state.activeReasoning];
  activeSettings.textContent = `${selectedModel().name} · ${effort}`;
  modelCurrent.textContent = selectedModel().name;
  reasoningModel.textContent = selectedModel().name;
}

function activeStep() {
  if (modelPanel.classList.contains("visible")) return "model";
  if (reasoningPanel.classList.contains("visible")) return "reasoning";
  return null;
}

function showStep(step) {
  modelPanel.classList.toggle("visible", step === "model");
  reasoningPanel.classList.toggle("visible", step === "reasoning");
  settingsTrigger.setAttribute("aria-expanded", String(step !== null));
  settingsTrigger.lastElementChild.textContent = step === null ? "⌄" : "⌃";
}

function renderModels() {
  modelList.replaceChildren();
  state.models.forEach((model) => {
    const selected = model.id === state.activeModelId;
    const row = document.createElement("button");
    row.className = `model-row${selected ? " selected" : ""}`;
    row.dataset.modelId = model.id;
    row.setAttribute("role", "menuitemradio");
    row.setAttribute("aria-checked", String(selected));
    row.innerHTML = `<span class="provider">${model.mark}</span><span class="copy"><strong>${model.name}</strong><small>${model.detail}</small></span><span class="check">›</span>`;
    row.addEventListener("click", () => {
      state.activeModelId = model.id;
      if (!model.reasoning.includes(state.activeReasoning)) state.activeReasoning = model.defaultReasoning;
      updateSummary();
      renderModels();
      renderReasoning();
      showStep("reasoning");
    });
    modelList.append(row);
  });
}

function renderReasoning() {
  reasoningList.replaceChildren();
  selectedModel().reasoning.forEach((effort) => {
    const selected = effort === state.activeReasoning;
    const button = document.createElement("button");
    button.className = `reasoning-option${selected ? " selected" : ""}`;
    button.dataset.reasoning = effort;
    button.setAttribute("aria-pressed", String(selected));
    button.textContent = state.reasoningLabels[effort];
    button.addEventListener("click", () => {
      state.activeReasoning = effort;
      updateSummary();
      renderReasoning();
      showStep(null);
    });
    reasoningList.append(button);
  });
}

settingsTrigger.addEventListener("click", () => showStep(activeStep() ? null : "model"));
document.querySelector("[data-close-panel]").addEventListener("click", () => showStep(null));
document.querySelector("#reasoningBack").addEventListener("click", () => showStep("model"));
document.addEventListener("keydown", (event) => { if (event.key === "Escape") showStep(null); });

fetch("./mock-state.json").then((response) => response.json()).then((value) => {
  state = value;
  updateSummary();
  renderModels();
  renderReasoning();
  showStep("model");
});
