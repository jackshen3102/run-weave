/* global document, fetch */

const state = await fetch("./mock-state.json").then((response) =>
  response.json(),
);

document.querySelector("#severity").textContent = state.finding.severity;
document.querySelector("#title").textContent = state.finding.title;
document.querySelector("#summary").textContent = state.finding.summary;
document.querySelector("#scenario-id").textContent = state.finding.scenarioId;
document.querySelector("#expected").textContent =
  `期望：${state.finding.expected}`;
document.querySelector("#actual").textContent = `实际：${state.finding.actual}`;

const caseList = document.querySelector("#case-list");
for (const item of state.cases) {
  const label = document.createElement("label");
  label.className = "case";
  label.innerHTML = `<input type="checkbox" value="${item.caseId}" /><span><strong>${item.sourceCaseId}</strong> · ${item.text}<span class="source">${item.sourceFilePath} · ${item.caseId}</span></span>`;
  caseList.append(label);
}

const error = document.querySelector("#error");
const reason = document.querySelector("#reason");
for (const button of document.querySelectorAll("button[data-value]")) {
  button.addEventListener("click", () => {
    const disposition = button.dataset.value;
    const selected = [...document.querySelectorAll(".case input:checked")].map(
      (item) => item.value,
    );
    if (!reason.value.trim()) {
      error.textContent = "请填写裁决原因。";
      return;
    }
    if (disposition !== "out_of_scope" && selected.length === 0) {
      error.textContent = "继续修复或本轮豁免必须选择至少一个产品 Case。";
      return;
    }
    document.querySelector("#decision-card").hidden = true;
    const result = document.querySelector("#result");
    result.style.display = "block";
    result.textContent = `已记录 ${disposition} 裁决${selected.length ? ` · ${selected.join(", ")}` : ""}。Finding 事实记录仍保留。`;
  });
}
