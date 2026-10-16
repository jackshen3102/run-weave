/* HTML approximation of a native terminal. No xterm, PTY, Codex or product API. */
const scenario =
  new URLSearchParams(location.search).get("scenario") || "default";
const fixture = await fetch("./mock-state.json").then((response) =>
  response.json(),
);
const sessions = structuredClone(fixture.sessions).map((session) => ({
  ...session,
  side: null,
  surface: "main",
  creating: false,
  createFailed: false,
  error: "",
  parentStatus: null,
}));
let activeId = fixture.activeSessionId;
const current = () => sessions.find((session) => session.id === activeId);
const input = document.querySelector("#draft");
function resizeInput() {
  input.style.height = "auto";
  input.style.height = `${input.scrollHeight}px`;
}
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );
const inSide = (session) => session.surface === "side" && session.side;
const target = (session) => inSide(session) || session;
const labels = {
  finished: "main finished",
  approval: "main needs approval",
  input: "main needs input",
  failed: "main failed",
  interrupted: "main interrupted",
  closed: "main closed",
};
for (const [id, value] of Object.entries({
  project: fixture.project,
  worktree: fixture.worktree,
  "workspace-name": "⑂ " + fixture.worktree,
  "workspace-path": fixture.project + " / " + fixture.worktree,
}))
  document.getElementById(id).textContent = value;
function render() {
  const session = current();
  const child = inSide(session);
  const messages = child
    ? child.messages
    : [
        { role: "user", text: session.request },
        ...session.lines.map((line) => ({
          role:
            line.kind === "tool"
              ? "tool"
              : line.kind === "user"
                ? "user"
                : "assistant",
          text: line.text,
        })),
      ];
  const transcript = document.querySelector("#transcript");
  const terminal = document.querySelector("#terminal");
  const wasAtBottom =
    terminal.scrollHeight - terminal.scrollTop - terminal.clientHeight <
    40;
  document.querySelector("#sessions").innerHTML = sessions
    .map(
      (item) =>
        `<button class="session-tab ${item.id === activeId ? "active" : ""}" data-session="${item.id}" aria-pressed="${item.id === activeId}">${esc(item.title)}</button>`,
    )
    .join("");
  transcript.innerHTML = `${child ? "" : `<div class="cli-header"><strong>OpenAI Codex <span>(v${esc(fixture.codexVersion)})</span></strong><div>directory: ${esc(fixture.worktree)}</div></div>`}${messages.map((message) => `<div class="terminal-line ${message.role}"><span class="marker" aria-hidden="true">${message.role === "user" ? "›" : message.role === "tool" ? "└" : "•"}</span><div class="line-body">${esc(message.text)}</div></div>`).join("")}`;
  document.querySelector("#terminal").dataset.surface = child ? "side" : "main";
  document.querySelector("#activity").textContent = session.creating
    ? "Starting side conversation…"
    : child?.running
      ? "Working…"
      : !child && session.status === "running"
        ? "Working…"
        : "";
  const error = document.querySelector("#error");
  error.textContent = session.error;
  error.hidden = !session.error;
  input.readOnly = session.creating;
  input.placeholder = child
    ? "Ask a follow-up question"
    : "Ask Codex to do anything";
  if (input.value !== target(session).draft)
    input.value = target(session).draft;
  resizeInput();
  document.querySelector("#context").textContent = child
    ? [
        "Side from main thread",
        labels[session.parentStatus],
        "ctrl+/ to switch",
        "ctrl+c to close",
      ]
        .filter(Boolean)
        .join(" · ")
    : session.side
      ? "ctrl+/ for side"
      : "";
  document.querySelectorAll("[data-session]").forEach((button) =>
    button.addEventListener("click", () => {
      activeId = button.dataset.session;
      // Host tab navigation does not navigate inside, or destroy, the native CLI.
      render();
      input.focus();
    }),
  );
  if (wasAtBottom) terminal.scrollTop = terminal.scrollHeight;
}
function discard(session) {
  session.side = null;
  session.surface = "main";
  session.parentStatus = null;
}
function toggle(session) {
  if (!session.side || session.creating) return;
  session.surface = inSide(session) ? "main" : "side";
  session.error = "";
  render();
}
async function start(session, question) {
  if (inSide(session)) {
    session.error =
      "A side conversation is already open. Press ctrl + c to return before starting another.";
    render();
    return;
  }
  if (scenario === "review" || scenario === "not-started") {
    session.error =
      scenario === "review"
        ? "'/side' is unavailable in review mode."
        : "'/side' is unavailable until the current conversation has started. Send a message first, then try /side again.";
    if (question) session.draft = question;
    render();
    return;
  }
  discard(session);
  session.creating = true;
  session.error = "";
  render();
  await new Promise((resolve) => setTimeout(resolve, fixture.timing.createMs));
  session.creating = false;
  if (scenario === "create-error" && !session.createFailed) {
    session.createFailed = true;
    if (question) session.draft = question;
    session.error = "Failed to start side conversation: transport disconnected";
    if (current() === session) render();
    return;
  }
  session.side = {
    parentId: session.threadId,
    draft: "",
    messages: [],
    running: false,
  };
  session.surface = "side";
  if (question) answer(session, question);
  else if (current() === session) render();
}
function answer(session, question) {
  const child = session.side;
  child.draft = "";
  child.messages.push({ role: "user", text: question });
  child.running = true;
  const response = { role: "assistant", text: "" };
  child.messages.push(response);
  const text = fixture.replies[session.id];
  if (current() === session) render();
  for (let part = 1; part <= 4; part++)
    setTimeout(
      () => {
        if (session.side !== child) return;
        response.text = text.slice(0, Math.ceil((text.length * part) / 4));
        if (part === 4) child.running = false;
        if (current() === session) render();
      },
      (fixture.timing.replyMs * part) / 4,
    );
}
function submit() {
  const session = current(),
    destination = target(session);
  const text = destination.draft.trim();
  if (!text || session.creating || destination.running) return;
  session.error = "";
  const command = text.match(/^\/(side|btw)(?:\s+([\s\S]*))?$/);
  if (command) {
    if (!inSide(session)) destination.draft = "";
    start(session, command[2] || "");
    return;
  }
  if (inSide(session)) answer(session, text);
  else {
    session.lines.push({ kind: "user", text });
    session.draft = "";
    render();
  }
}
input.addEventListener("input", () => {
  target(current()).draft = input.value;
  resizeInput();
});
input.addEventListener("keydown", (event) => {
  if (event.isComposing) return;
  const session = current();
  if (event.ctrlKey && (event.key === "/" || event.key === "7")) {
    event.preventDefault();
    toggle(session);
    return;
  }
  if (
    event.ctrlKey &&
    event.key.toLowerCase() === "c" &&
    inSide(session) &&
    !input.value &&
    !getSelection().toString()
  ) {
    event.preventDefault();
    discard(session);
    session.error = "";
    render();
    return;
  }
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    submit();
  }
});
document.querySelector("#transcript").addEventListener("click", () => {
  if (!getSelection().toString()) input.focus();
});
if (scenario === "conversation") {
  current().side = {
    parentId: current().threadId,
    draft: "",
    messages: structuredClone(fixture.sampleConversation),
    running: false,
  };
  current().surface = "side";
}
if (scenario === "review") current().status = "idle";
render();
input.focus();
fixture.parentEvents.forEach((event, index) =>
  setTimeout(
    () => {
      const session = sessions[0];
      session.status = event.status;
      if (session.side) session.parentStatus = event.status;
      session.lines.push({ kind: "answer", text: event.text });
      if (current() === session) render();
    },
    fixture.timing.mainProgressMs * (index + 1),
  ),
);
