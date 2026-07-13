/* global document, fetch */

const app = document.querySelector("#app");

const state = {
  data: null,
  route: "terminals",
  selectedTerminalId: "d5023252",
  selectedRunId: "atr_406e9cdd_20260712050528",
  selectedEventId: null,
  selectedRunEventId: null,
  eventFilter: "journal",
  runTab: "journal",
  search: "",
};

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function shortId(value) {
  return value ? `${value.slice(0, 8)}…` : "—";
}

function terminalTurnCount(terminal) {
  return terminal.threads.reduce(
    (count, thread) => count + (thread.turnCount ?? thread.turns.length),
    0,
  );
}

function countLabel(count, singular) {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

function formatStatus(value) {
  return String(value ?? "unknown")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function formatTimestamp(value) {
  const date = timestampDate(value);
  if (!date) return String(value ?? "—");
  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone: "UTC",
  }).format(date);
}

function formatTime(value) {
  const date = timestampDate(value);
  if (!date) return String(value ?? "—");
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  }).format(date);
}

function formatDateHeading(value) {
  const date = timestampDate(value);
  if (!date) return "日期未记录";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "long",
    day: "numeric",
    weekday: "long",
    timeZone: "UTC",
  }).format(date);
}

function formatDuration(value) {
  if (value === null || value === undefined) return "未完成";
  if (typeof value === "string") return value;
  const seconds = Math.max(0, Math.round(value / 1_000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function timestampDate(value, fallbackDate) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    const date = new Date(value * 1_000);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value === "string" && /^\d{2}:\d{2}/.test(value)) {
    const base = timestampDate(fallbackDate);
    if (!base) return null;
    const [hours, minutes, seconds = "0"] = value.split(":");
    base.setUTCHours(Number(hours), Number(minutes), Number(seconds), 0);
    return base;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function timestampValue(value, fallbackDate) {
  return (
    timestampDate(value, fallbackDate)?.getTime() ?? Number.MAX_SAFE_INTEGER
  );
}

function combineTimeWithDate(time, fallbackDate) {
  return timestampDate(time, fallbackDate)?.toISOString() ?? time;
}

function statusBadge(status) {
  const value = String(status ?? "unknown");
  const tone = ["running", "completed", "done", "pass", "idle"].includes(value)
    ? "good"
    : ["interrupted", "need_human"].includes(value)
      ? "warn"
      : "blue";
  return `<span class="badge ${tone}">${escapeHtml(formatStatus(value))}</span>`;
}

function currentItems() {
  return state.route === "terminals"
    ? state.data.terminals
    : state.data.agentTeamRuns;
}

function selectedItem() {
  const id =
    state.route === "terminals"
      ? state.selectedTerminalId
      : state.selectedRunId;
  return (
    currentItems().find((item) => item.id === id) ?? currentItems()[0] ?? null
  );
}

function matchesSearch(item) {
  const query = state.search.trim().toLowerCase();
  if (!query) return true;
  const values =
    state.route === "terminals"
      ? [
          item.id,
          item.project,
          item.cwd,
          item.agent,
          item.preview,
          ...item.threads.flatMap((thread) => [thread.id, thread.preview]),
        ]
      : [
          item.id,
          item.project,
          item.task,
          item.status,
          item.phase,
          ...item.workers.map((worker) => worker.role),
        ];
  return values.filter(Boolean).join(" ").toLowerCase().includes(query);
}

function buildTerminalEvents(terminal) {
  const events = [
    {
      id: `session:${terminal.id}`,
      kind: "session",
      timestamp: terminal.createdAt,
      title:
        terminal.status === "history-only"
          ? "Terminal session retained in history"
          : "Terminal session started",
      summary:
        terminal.command && terminal.command !== "Not retained"
          ? `${terminal.command} · ${terminal.cwd}`
          : terminal.cwd,
      terminal,
    },
  ];

  terminal.threads.forEach((thread, threadIndex) => {
    const firstTurnTimestamp = /^\d{2}:\d{2}/.test(
      String(thread.turns[0]?.startedAt),
    )
      ? combineTimeWithDate(thread.turns[0].startedAt, thread.createdAt)
      : thread.turns[0]?.startedAt;
    const threadTimestamp =
      firstTurnTimestamp &&
      timestampValue(firstTurnTimestamp) < timestampValue(thread.createdAt)
        ? firstTurnTimestamp
        : (thread.createdAt ?? firstTurnTimestamp ?? terminal.createdAt);
    events.push({
      id: `thread:${thread.id}`,
      kind: "thread",
      timestamp: threadTimestamp,
      title:
        threadIndex === 0 ? "Codex thread started" : "New Codex thread started",
      summary: thread.preview,
      thread,
      terminal,
    });

    thread.turns.forEach((turn) => {
      const timestamp = /^\d{2}:\d{2}/.test(String(turn.startedAt))
        ? combineTimeWithDate(turn.startedAt, threadTimestamp)
        : turn.startedAt;
      events.push({
        id: `turn:${turn.id}`,
        kind: "turn",
        timestamp,
        title: turn.prompt ? "User request" : `Codex turn ${shortId(turn.id)}`,
        summary: turn.result,
        turn,
        thread,
        terminal,
      });
    });

    if (thread.lastActivityAt) {
      events.push({
        id: `thread-state:${thread.id}`,
        kind: "thread-state",
        timestamp: thread.lastActivityAt,
        title: `Thread became ${formatStatus(thread.status).toLowerCase()}`,
        summary: thread.lastCompletionReason
          ? `Recorded completion reason: ${thread.lastCompletionReason}`
          : "No completion reason was retained.",
        thread,
        terminal,
      });
    }
  });

  terminal.facts.forEach((fact, index) => {
    events.push({
      id: `fact:${terminal.id}:${index}`,
      kind: "fact",
      timestamp:
        fact.occurredAt ??
        combineTimeWithDate(
          fact.time,
          terminal.lastActivityAt ?? terminal.createdAt,
        ),
      title: fact.event,
      summary: fact.detail,
      fact,
      terminal,
    });
  });

  return events.sort(
    (left, right) =>
      timestampValue(left.timestamp, terminal.createdAt) -
      timestampValue(right.timestamp, terminal.createdAt),
  );
}

function filterTerminalEvents(events) {
  if (state.eventFilter === "all") return events;
  if (state.eventFilter === "journal") {
    return events.filter((event) => event.kind !== "fact");
  }
  if (state.eventFilter === "threads") {
    return events.filter((event) =>
      ["thread", "thread-state"].includes(event.kind),
    );
  }
  if (state.eventFilter === "turns") {
    return events.filter((event) => event.kind === "turn");
  }
  return events.filter((event) => event.kind === "fact");
}

function groupEventsByDate(events) {
  const groups = [];
  events.forEach((event) => {
    const date = timestampDate(event.timestamp);
    const key = date
      ? `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`
      : "unknown";
    const current = groups.at(-1);
    if (current?.key === key) {
      current.events.push(event);
    } else {
      groups.push({ key, timestamp: event.timestamp, events: [event] });
    }
  });
  return groups;
}

function defaultEventId(terminal) {
  const events = buildTerminalEvents(terminal);
  return (
    events.find((event) => event.kind === "turn" && event.turn?.prompt)?.id ??
    events.find((event) => event.kind === "thread")?.id ??
    events[0]?.id ??
    null
  );
}

function render() {
  const item = selectedItem();
  app.innerHTML = `
    <div class="app-shell">
      ${renderGlobalNavigation()}
      ${renderRecordList()}
      ${
        item
          ? state.route === "terminals"
            ? renderTerminalWorkspace(item)
            : renderRunPage(item)
          : renderEmpty("No records match the current search.")
      }
    </div>
  `;
}

function renderGlobalNavigation() {
  return `
    <aside class="global-nav">
      <div class="brand">
        <div class="brand-mark">R</div>
        <div>
          <strong>RUNWEAVE</strong>
          <span>${escapeHtml(state.data.product.title)}</span>
        </div>
      </div>
      <div class="nav-label">Recorded work</div>
      <nav class="route-list" aria-label="Work history views">
        ${state.data.routes
          .map(
            (route) => `
              <button
                class="route-button ${state.route === route.id ? "active" : ""}"
                data-route="${route.id}"
              >
                <span class="route-title">
                  <span class="route-icon">${route.id === "terminals" ? ">_" : "◇"}</span>
                  ${escapeHtml(route.label)}
                </span>
                <p>${escapeHtml(route.description)}</p>
              </button>
            `,
          )
          .join("")}
      </nav>
      <div class="nav-foot">
        <strong>One Terminal, one archive</strong>
        Restarting Codex creates another Thread segment inside the same Terminal record.
      </div>
    </aside>
  `;
}

function renderRecordList() {
  const isTerminal = state.route === "terminals";
  const items = currentItems().filter(matchesSearch);
  return `
    <aside class="record-list">
      <header class="list-header">
        <h1>${isTerminal ? "Terminal history" : "Multi-Agent runs"}</h1>
        <p>${isTerminal ? "Terminal ID is the stable archive key" : "Orchestrated execution stays separate"}</p>
      </header>
      <div class="search-wrap">
        <input
          class="search"
          data-search
          type="search"
          placeholder="Search ${isTerminal ? "Terminal or Thread" : "Run or Worker"}…"
          value="${escapeHtml(state.search)}"
        />
      </div>
      <div class="records">
        ${
          items
            .map((item) =>
              isTerminal ? renderTerminalRecord(item) : renderRunRecord(item),
            )
            .join("") || renderEmpty("No matching records.")
        }
      </div>
    </aside>
  `;
}

function renderTerminalRecord(terminal) {
  const dotTone =
    terminal.status === "running"
      ? "good"
      : terminal.status === "history-only"
        ? ""
        : "warn";
  return `
    <button
      class="record ${state.selectedTerminalId === terminal.id ? "active" : ""}"
      data-terminal-id="${terminal.id}"
    >
      <div class="record-top">
        <span class="status-dot ${dotTone}"></span>
        <strong>${escapeHtml(terminal.project)}</strong>
        <span class="record-id">${escapeHtml(terminal.id)}</span>
      </div>
      <p>${escapeHtml(terminal.preview)}</p>
      <div class="record-meta">
        ${statusBadge(terminal.status)}
        <span class="badge">${countLabel(terminal.threads.length, "thread")}</span>
        <span class="badge">${countLabel(terminalTurnCount(terminal), "turn")}</span>
      </div>
    </button>
  `;
}

function renderRunRecord(run) {
  return `
    <button
      class="record ${state.selectedRunId === run.id ? "active" : ""}"
      data-run-id="${run.id}"
    >
      <div class="record-top">
        <span class="status-dot ${run.status === "done" ? "good" : ""}"></span>
        <strong>${escapeHtml(run.task)}</strong>
        <span class="record-id">${run.completedRoundCount}R done</span>
      </div>
      <p>${escapeHtml(run.id)}</p>
      <div class="record-meta">
        ${statusBadge(run.status)}
        <span class="badge">${countLabel(run.workers.length, "worker")}</span>
        <span class="badge">${countLabel(run.completedRoundCount, "round")} completed</span>
        <span class="badge good">${run.bestPassCount}/${run.acceptanceCount} pass</span>
      </div>
    </button>
  `;
}

function renderTerminalWorkspace(terminal) {
  const allEvents = buildTerminalEvents(terminal);
  const events = filterTerminalEvents(allEvents);
  const selectedEvent =
    allEvents.find((event) => event.id === state.selectedEventId) ?? null;
  const groups = groupEventsByDate(events);
  return `
    <section class="workspace ${selectedEvent ? "inspector-open" : ""}">
      <div class="journal">
        ${renderJournalHeader(terminal, events, allEvents.length)}
        <div class="timeline" data-event-timeline>
          ${
            groups.length
              ? groups.map((group) => renderDateGroup(group)).join("")
              : renderEmpty("No events match this filter.")
          }
        </div>
      </div>
      ${selectedEvent ? renderInspector(selectedEvent, terminal) : ""}
      ${selectedEvent ? '<button class="drawer-scrim" data-close-inspector aria-label="Dismiss event details"></button>' : ""}
    </section>
  `;
}

function renderJournalHeader(terminal, events, totalEventCount) {
  const filterOptions = [
    ["journal", "Journal"],
    ["all", "All events"],
    ["threads", "Threads"],
    ["turns", "Turns"],
    ["facts", "Raw facts"],
  ];
  return `
    <header class="journal-header">
      <div class="journal-title-row">
        <div>
          <span class="eyebrow">Terminal session · ${escapeHtml(terminal.id)}</span>
          <h2>${escapeHtml(terminal.project)}</h2>
          <p>${escapeHtml(terminal.cwd)}</p>
        </div>
        <div class="header-meta">
          ${statusBadge(terminal.status)}
          <span class="badge blue">${escapeHtml(terminal.agent)}</span>
          <span class="badge">${countLabel(terminal.threads.length, "thread")}</span>
        </div>
      </div>
      <div class="journal-toolbar">
        <span class="journal-summary">${events.length} shown · ${totalEventCount} recorded · chronological</span>
        <div class="filter-list" role="group" aria-label="Event filters">
          ${filterOptions
            .map(
              ([id, label]) => `
                <button
                  class="filter-button ${state.eventFilter === id ? "active" : ""}"
                  data-event-filter="${id}"
                >${label}</button>
              `,
            )
            .join("")}
        </div>
      </div>
    </header>
  `;
}

function renderDateGroup(group) {
  return `
    <section class="date-group">
      <h3 class="date-heading">${escapeHtml(formatDateHeading(group.timestamp))}</h3>
      <div>
        ${group.events.map((event) => renderEvent(event)).join("")}
      </div>
    </section>
  `;
}

function renderEvent(event) {
  const active = state.selectedEventId === event.id;
  const kindClass =
    event.kind === "fact"
      ? "fact-event compact"
      : event.kind === "thread" || event.kind === "thread-state"
        ? "thread-boundary"
        : event.kind === "session"
          ? "compact"
          : "";
  const icon = {
    session: ">_",
    thread: "◎",
    "thread-state": "○",
    turn: "↗",
    fact: "·",
  }[event.kind];

  let body = "";
  if (event.kind === "turn") {
    body = `
      ${event.turn.prompt ? `<p class="event-quote">“${escapeHtml(event.turn.prompt)}”</p>` : ""}
      ${event.turn.result ? `<p class="event-result">${escapeHtml(event.turn.result)}</p>` : ""}
      <div class="event-meta">
        ${statusBadge(event.turn.status)}
        <span class="badge">${event.turn.itemCount} items</span>
        <span class="badge">${escapeHtml(formatDuration(event.turn.durationMs ?? event.turn.duration))}</span>
      </div>
    `;
  } else if (event.kind === "thread") {
    body = `
      <p class="event-quote">${escapeHtml(event.summary || "No thread preview available")}</p>
      <div class="event-meta">
        ${statusBadge(event.thread.status)}
        <span class="badge">${event.thread.turnCount ?? event.thread.turns.length} turns</span>
        <span class="badge blue">Thread ${shortId(event.thread.id)}</span>
      </div>
    `;
  } else if (event.kind === "thread-state") {
    body = `
      <p class="event-result">${escapeHtml(event.summary)}</p>
      <div class="event-meta">
        <span class="badge blue">Thread ${shortId(event.thread.id)}</span>
      </div>
    `;
  } else if (event.kind === "fact") {
    body = `
      <p class="event-result">${escapeHtml(event.summary)}</p>
      <div class="event-meta"><span class="badge">${escapeHtml(event.fact.source)}</span></div>
    `;
  } else {
    body = `<p class="event-result">${escapeHtml(event.summary)}</p>`;
  }

  return `
    <article class="event-row ${active ? "active" : ""}">
      <time class="event-time">${escapeHtml(formatTime(event.timestamp))}</time>
      <span class="event-marker"><span></span></span>
      <button
        class="event-card ${kindClass}"
        data-event-id="${event.id}"
        aria-pressed="${active ? "true" : "false"}"
      >
        <span class="event-title">
          <span class="event-icon">${icon}</span>
          <span>${escapeHtml(event.title)}</span>
          <span class="chevron">›</span>
        </span>
        ${body}
      </button>
    </article>
  `;
}

function renderInspector(event, terminal) {
  const inspectorTitles = {
    session: ["Terminal session", ">_"],
    thread: ["Codex thread", "◎"],
    "thread-state": ["Thread state", "○"],
    turn: ["Codex turn", "↗"],
    fact: ["Recorded fact", "·"],
  };
  const [label, icon] = inspectorTitles[event.kind];
  return `
    <aside class="inspector" aria-label="Event details">
      <header class="inspector-header">
        <span class="inspector-icon">${icon}</span>
        <div class="inspector-heading">
          <span class="eyebrow">${label}</span>
          <h3>${escapeHtml(event.title)}</h3>
        </div>
        <button class="close-button" data-close-inspector aria-label="Close event details">×</button>
      </header>
      <div class="inspector-body">
        ${renderInspectorBody(event, terminal)}
      </div>
    </aside>
  `;
}

function renderInspectorBody(event, terminal) {
  if (event.kind === "session") return renderSessionInspector(terminal, event);
  if (event.kind === "thread") return renderThreadInspector(event.thread);
  if (event.kind === "thread-state") {
    return `
      ${renderDetailSection("Recorded state", [
        ["Status", event.thread.status],
        ["Last activity", formatTimestamp(event.thread.lastActivityAt)],
        [
          "Completion reason",
          event.thread.lastCompletionReason ?? "Not recorded",
        ],
      ])}
      ${renderRelatedThread(event.thread)}
    `;
  }
  if (event.kind === "turn") return renderTurnInspector(event);
  return renderFactInspector(event, terminal);
}

function renderSessionInspector(terminal, event) {
  return `
    ${renderDetailSection("Identity", [
      ["Terminal ID", terminal.id],
      ["Project", terminal.project],
      ["Working directory", terminal.cwd],
      ["Command", terminal.command],
      ["Created", formatTimestamp(event.timestamp)],
      ["Last activity", formatTimestamp(terminal.lastActivityAt)],
      ["Status", formatStatus(terminal.status)],
    ])}
    <section class="inspector-section">
      <h4 class="section-label">Available sources</h4>
      <div class="detail-list">
        ${terminal.sourceSummary
          .map(
            (item) => `
              <div class="detail-row">
                <span>${escapeHtml(item.label)}</span>
                <strong>${escapeHtml(item.value)}</strong>
              </div>
            `,
          )
          .join("")}
      </div>
    </section>
  `;
}

function renderThreadInspector(thread) {
  return `
    ${renderDetailSection("Thread identity", [
      ["Thread ID", thread.id],
      ["Status", formatStatus(thread.status)],
      ["Created", formatTimestamp(thread.createdAt)],
      ["Last activity", formatTimestamp(thread.lastActivityAt)],
      ["Turns", String(thread.turnCount ?? thread.turns.length)],
      ["Completion reason", thread.lastCompletionReason ?? "Not recorded"],
    ])}
    <section class="inspector-section">
      <h4 class="section-label">Conversation</h4>
      ${renderThreadMessages(thread)}
    </section>
  `;
}

function renderThreadMessages(thread) {
  if (!thread.turns.length) {
    return '<p class="unavailable">This Thread is linked, but its Turns were not loaded in the fixed prototype snapshot.</p>';
  }

  return `
    <div class="message-list">
      ${thread.turns
        .map((turn) => {
          const messages = [];
          if (turn.prompt) {
            messages.push(`
              <article class="message user">
                <div class="message-role">
                  <span>User</span>
                  <time>${escapeHtml(formatTime(turn.startedAt))}</time>
                </div>
                <p>${escapeHtml(turn.prompt)}</p>
              </article>
            `);
          }
          if (turn.result) {
            messages.push(`
              <article class="message assistant">
                <div class="message-role">
                  <span>Assistant</span>
                  <time>${escapeHtml(formatDuration(turn.durationMs ?? turn.duration))}</time>
                </div>
                <p>${escapeHtml(turn.result)}</p>
              </article>
            `);
          }
          if (!messages.length) {
            messages.push(`
              <p class="unavailable">
                Turn ${escapeHtml(shortId(turn.id))}: ${turn.itemCount} items are recorded,
                but message content is not included in this snapshot.
              </p>
            `);
          }
          return messages.join("");
        })
        .join("")}
    </div>
  `;
}

function renderTurnInspector(event) {
  const { turn, thread } = event;
  return `
    <section class="inspector-section">
      <h4 class="section-label">User message</h4>
      ${
        turn.prompt
          ? `<div class="code-block">${escapeHtml(turn.prompt)}</div>`
          : '<p class="unavailable">The message content was not included in this snapshot.</p>'
      }
    </section>
    <section class="inspector-section">
      <h4 class="section-label">Recorded response</h4>
      ${
        turn.result
          ? `<div class="code-block">${escapeHtml(turn.result)}</div>`
          : '<p class="unavailable">No response text is available in this snapshot.</p>'
      }
    </section>
    ${renderDetailSection("Turn metadata", [
      ["Turn ID", turn.id],
      ["Status", formatStatus(turn.status)],
      ["Started", formatTimestamp(event.timestamp)],
      ["Duration", formatDuration(turn.durationMs ?? turn.duration)],
      ["Items", String(turn.itemCount)],
    ])}
    ${renderRelatedThread(thread)}
  `;
}

function renderFactInspector(event, terminal) {
  const relatedThread = terminal.threads.find((thread) =>
    String(event.fact.detail).includes(thread.id.slice(0, 8)),
  );
  return `
    <section class="inspector-section">
      <h4 class="section-label">Recorded payload</h4>
      <div class="code-block">${escapeHtml(event.fact.detail)}</div>
    </section>
    ${renderDetailSection("Fact metadata", [
      ["Event name", event.fact.event],
      ["Occurred", formatTimestamp(event.timestamp)],
      ["Source", event.fact.source],
      ["Terminal ID", terminal.id],
    ])}
    ${relatedThread ? renderRelatedThread(relatedThread) : ""}
  `;
}

function renderRelatedThread(thread) {
  return `
    <section class="inspector-section">
      <h4 class="section-label">Related Thread</h4>
      <button class="related-button" data-related-thread-id="${thread.id}">
        <span>View the complete recorded conversation</span>
        <strong>${escapeHtml(thread.id)}</strong>
      </button>
    </section>
  `;
}

function renderDetailSection(label, rows) {
  return `
    <section class="inspector-section">
      <h4 class="section-label">${escapeHtml(label)}</h4>
      <div class="detail-list">
        ${rows
          .map(
            ([rowLabel, value]) => `
              <div class="detail-row">
                <span>${escapeHtml(rowLabel)}</span>
                <strong>${escapeHtml(value ?? "Not recorded")}</strong>
              </div>
            `,
          )
          .join("")}
      </div>
    </section>
  `;
}

function buildRunSections(run) {
  const setupTitles = [
    "Task submitted from test case file",
    "Split proposal ready",
    "Human confirmed split",
  ];
  const setupEvents = run.logs.slice(0, 3).map((log, index) => ({
    id: `run-setup:${index}`,
    kind: "setup-log",
    title: setupTitles[index] ?? `Setup step ${index + 1}`,
    summary: log,
    sequence: index + 1,
  }));
  const sections = [
    {
      id: "setup",
      title: "Setup",
      tone: "setup",
      meta: "Recorded orchestration",
      events: setupEvents,
    },
  ];

  run.roundHistory.forEach((roundRecord) => {
    const events = [];
    run.workers
      .filter((worker) => worker.dispatchRound === roundRecord.round)
      .forEach((worker) => {
        events.push({
          id: `worker-dispatch:${worker.id}`,
          kind: "worker-dispatch",
          title: "Worker dispatched",
          summary: `${worker.role} → pane ${worker.tmuxPaneId}`,
          round: roundRecord.round,
          worker,
        });
      });
    run.workers
      .filter((worker) => worker.resultRound === roundRecord.round)
      .forEach((worker) => {
        events.push({
          id: `worker-result:${worker.id}`,
          kind: "worker-result",
          title: "Worker result recorded",
          summary: worker.summary,
          round: roundRecord.round,
          worker,
        });
      });
    events.push({
      id: `round-progress:${roundRecord.round}`,
      kind: "round-progress",
      title: "Round progress recorded",
      summary: roundRecord.summary,
      round: roundRecord.round,
      roundRecord,
    });
    sections.push({
      id: `round-${roundRecord.round}`,
      title: `Round ${roundRecord.round}`,
      tone: "round",
      meta: roundRecord.status,
      events,
    });
  });

  const acceptanceEvents = run.acceptance.map((item) => ({
    id: `case:${item.caseId}`,
    kind: "case",
    title: `${item.caseId} · ${item.title}`,
    summary: item.resultSummary,
    round: item.resultRound,
    acceptance: item,
  }));
  acceptanceEvents.push({
    id: `run-completed:${run.id}`,
    kind: "run-completed",
    title: "Run completed",
    summary: run.retrospective.taskResult,
    completedRound: run.completedRoundCount,
  });
  sections.push({
    id: "acceptance",
    title: "Acceptance",
    tone: "acceptance",
    meta: `${run.bestPassCount}/${run.acceptanceCount} passed`,
    events: acceptanceEvents,
  });
  return sections;
}

function defaultRunEventId(run) {
  return run.workers.find((worker) => worker.resultRound)?.id
    ? `worker-result:${run.workers.find((worker) => worker.resultRound).id}`
    : (buildRunSections(run).flatMap((section) => section.events)[0]?.id ??
        null);
}

function defaultRunTabEventId(run, tab) {
  if (tab === "workers") {
    return run.workers[0] ? `worker-result:${run.workers[0].id}` : null;
  }
  if (tab === "acceptance") {
    return run.acceptance[0] ? `case:${run.acceptance[0].caseId}` : null;
  }
  if (tab === "facts") {
    return run.activityFacts[0] ? "run-fact:0" : null;
  }
  return defaultRunEventId(run);
}

function findRunEvent(run, eventId) {
  if (!eventId) return null;
  const sectionEvent = buildRunSections(run)
    .flatMap((section) => section.events)
    .find((event) => event.id === eventId);
  if (sectionEvent) return sectionEvent;
  if (eventId.startsWith("run-fact:")) {
    const index = Number(eventId.slice("run-fact:".length));
    const fact = run.activityFacts[index];
    return fact
      ? {
          id: eventId,
          kind: "run-fact",
          title: fact.event,
          summary: fact.detail,
          fact,
        }
      : null;
  }
  if (eventId.startsWith("evidence:")) {
    const [, caseId, rawIndex] = eventId.split(":");
    const acceptance = run.acceptance.find((item) => item.caseId === caseId);
    const evidence = acceptance?.evidence[Number(rawIndex)];
    return evidence
      ? {
          id: eventId,
          kind: "evidence",
          title: evidence.label,
          summary: evidence.summary,
          evidence,
          acceptance,
          evidenceIndex: Number(rawIndex),
        }
      : null;
  }
  return null;
}

function renderRunPage(run) {
  const selectedEvent = findRunEvent(run, state.selectedRunEventId);
  const tabs = [
    ["journal", "Journal"],
    ["workers", "Workers"],
    ["acceptance", "Acceptance"],
    ["facts", "Raw facts"],
  ];
  return `
    <section class="workspace run-workspace ${selectedEvent ? "inspector-open" : ""}">
      <div class="run-journal">
        <header class="run-journal-header">
          <div class="run-heading">
            <div>
              <span class="eyebrow">Agent Team Run</span>
              <h2>${escapeHtml(run.id)}</h2>
              <p>${escapeHtml(run.task)} · Terminal ${escapeHtml(run.terminalSessionId)}</p>
            </div>
            <div class="header-meta">
              ${statusBadge(run.status)}
              <span class="badge blue">${run.completedRoundCount} round completed</span>
              <span class="badge">${run.workers.length} worker</span>
              <span class="badge good">${run.bestPassCount}/${run.acceptanceCount} pass</span>
            </div>
          </div>
          <nav class="run-tabs" aria-label="Multi-Agent run views">
            ${tabs
              .map(
                ([id, label]) => `
                  <button
                    class="run-tab ${state.runTab === id ? "active" : ""}"
                    data-run-tab="${id}"
                  >${label}</button>
                `,
              )
              .join("")}
          </nav>
        </header>
        <div class="run-content">
          ${renderRunTab(run)}
        </div>
      </div>
      ${selectedEvent ? renderRunInspector(selectedEvent, run) : ""}
      ${selectedEvent ? '<button class="drawer-scrim" data-close-inspector aria-label="Dismiss run event details"></button>' : ""}
    </section>
  `;
}

function renderRunTab(run) {
  if (state.runTab === "workers") return renderRunWorkers(run);
  if (state.runTab === "acceptance") return renderRunAcceptance(run);
  if (state.runTab === "facts") return renderRunFacts(run);
  return renderRunJournal(run);
}

function renderRunJournal(run) {
  return `
    <div class="run-phase-list">
      ${buildRunSections(run)
        .map((section) => renderRunPhase(section))
        .join("")}
    </div>
  `;
}

function renderRunPhase(section) {
  return `
    <section class="run-phase ${section.tone}">
      <header class="run-phase-header">
        <span class="phase-icon">${section.tone === "setup" ? "◎" : section.tone === "round" ? "↻" : "✓"}</span>
        <h3>${escapeHtml(section.title)}</h3>
        <span>${escapeHtml(section.meta)}</span>
      </header>
      <div class="run-phase-events">
        ${section.events.map((event) => renderRunJournalEvent(event)).join("")}
      </div>
    </section>
  `;
}

function renderRunJournalEvent(event) {
  const active = state.selectedRunEventId === event.id;
  const icon = {
    "setup-log": "·",
    "worker-dispatch": "▷",
    "worker-result": "✓",
    "round-progress": "↻",
    case: "◇",
    "run-completed": "⚑",
  }[event.kind];
  const status =
    event.kind === "worker-result"
      ? statusBadge(event.worker.status)
      : event.kind === "case"
        ? statusBadge(event.acceptance.status)
        : event.kind === "run-completed"
          ? '<span class="badge good">Done</span>'
          : "";
  return `
    <button
      class="run-event ${active ? "active" : ""}"
      data-run-event-id="${event.id}"
    >
      <span class="run-event-icon">${icon}</span>
      <span class="run-event-copy">
        <strong>${escapeHtml(event.title)}</strong>
        <span>${escapeHtml(event.summary)}</span>
      </span>
      <span class="run-event-meta">
        ${event.round ? `<span class="badge blue">Round ${event.round}</span>` : ""}
        ${status}
        <span class="run-chevron">›</span>
      </span>
    </button>
  `;
}

function renderRunWorkers(run) {
  return `
    <section class="run-directory">
      <header class="directory-heading">
        <div><span class="eyebrow">Workers</span><h3>Pane-scoped execution</h3></div>
        <span class="badge">${run.workers.length} recorded</span>
      </header>
      <div class="directory-list">
        ${run.workers
          .map(
            (worker) => `
              <button
                class="directory-card ${state.selectedRunEventId === `worker-result:${worker.id}` ? "active" : ""}"
                data-run-event-id="worker-result:${worker.id}"
              >
                <span class="directory-icon">W</span>
                <span>
                  <strong>${escapeHtml(worker.role)}</strong>
                  <p>${escapeHtml(worker.intent)}</p>
                  <span class="record-meta">
                    <span class="badge blue">Round ${worker.resultRound}</span>
                    <span class="badge">Pane ${escapeHtml(worker.tmuxPaneId)}</span>
                    ${statusBadge(worker.status)}
                  </span>
                </span>
                <span class="run-chevron">›</span>
              </button>
            `,
          )
          .join("")}
      </div>
    </section>
  `;
}

function renderRunAcceptance(run) {
  return `
    <section class="run-directory">
      <header class="directory-heading">
        <div><span class="eyebrow">Acceptance</span><h3>Recorded checkpoints</h3></div>
        <span class="badge good">${run.bestPassCount}/${run.acceptanceCount} passed</span>
      </header>
      <div class="directory-list">
        ${run.acceptance
          .map(
            (item) => `
              <button
                class="directory-card ${state.selectedRunEventId === `case:${item.caseId}` ? "active" : ""}"
                data-run-event-id="case:${item.caseId}"
              >
                <span class="directory-icon">✓</span>
                <span>
                  <strong>${escapeHtml(item.caseId)} · ${escapeHtml(item.title)}</strong>
                  <p>${escapeHtml(item.resultSummary)}</p>
                  <span class="record-meta">
                    ${statusBadge(item.status)}
                    <span class="badge blue">Round ${item.resultRound}</span>
                    <span class="badge">${item.evidence.length} evidence</span>
                  </span>
                </span>
                <span class="run-chevron">›</span>
              </button>
            `,
          )
          .join("")}
      </div>
    </section>
  `;
}

function renderRunFacts(run) {
  return `
    <section class="run-directory">
      <header class="directory-heading">
        <div><span class="eyebrow">Raw facts</span><h3>Activity facts by Run ID</h3></div>
        <span class="badge">${run.activityFacts.length} recorded</span>
      </header>
      <div class="raw-run-facts">
        ${run.activityFacts
          .map(
            (fact, index) => `
              <button
                class="raw-run-fact ${state.selectedRunEventId === `run-fact:${index}` ? "active" : ""}"
                data-run-event-id="run-fact:${index}"
              >
                <span class="badge blue">${runFactRoundLabel(fact)}</span>
                <code>${escapeHtml(fact.event)}</code>
                <span>${escapeHtml(fact.detail)}</span>
                <span class="run-chevron">›</span>
              </button>
            `,
          )
          .join("")}
      </div>
    </section>
  `;
}

function runFactRoundLabel(fact) {
  if (fact.round == null) return "Round absent";
  if (fact.event === "agent_team.run.completed") {
    return `Next index ${fact.round}`;
  }
  return `Round ${fact.round}`;
}

function renderRunInspector(event, run) {
  const icon = {
    "setup-log": "·",
    "worker-dispatch": "▷",
    "worker-result": "W",
    "round-progress": "↻",
    case: "✓",
    "run-completed": "⚑",
    "run-fact": "·",
    evidence: "E",
  }[event.kind];
  return `
    <aside class="inspector" aria-label="Run event details">
      <header class="inspector-header">
        <span class="inspector-icon">${icon}</span>
        <div class="inspector-heading">
          <span class="eyebrow">${escapeHtml(run.id)}</span>
          <h3>${escapeHtml(event.title)}</h3>
        </div>
        <button class="close-button" data-close-inspector aria-label="Close run event details">×</button>
      </header>
      <div class="inspector-body">
        ${renderRunInspectorBody(event, run)}
      </div>
    </aside>
  `;
}

function renderRunInspectorBody(event, run) {
  if (event.kind === "worker-dispatch" || event.kind === "worker-result") {
    return renderRunWorkerInspector(event, run);
  }
  if (event.kind === "case")
    return renderRunCaseInspector(event.acceptance, run);
  if (event.kind === "evidence") return renderRunEvidenceInspector(event, run);
  if (event.kind === "run-fact") {
    return `
      <section class="inspector-section">
        <h4 class="section-label">Recorded payload</h4>
        <div class="code-block">${escapeHtml(event.fact.detail)}</div>
      </section>
      ${renderDetailSection("Fact metadata", [
        ["Event ID", event.fact.eventId ?? "Not retained in snapshot"],
        ["Event name", event.fact.event],
        [
          "Captured round",
          event.fact.round == null
            ? "Not recorded in legacy payload"
            : runFactRoundLabel(event.fact),
        ],
        ...(event.fact.attributedRound
          ? [
              ["Journal attribution", `Round ${event.fact.attributedRound}`],
              ["Attribution source", event.fact.roundSource],
            ]
          : []),
        ["Run ID", run.id],
        ["Source", event.fact.source],
      ])}
    `;
  }
  if (event.kind === "round-progress") {
    return `
      ${renderDetailSection("Round state", [
        ["Round", String(event.round)],
        ["Status", formatStatus(event.roundRecord.status)],
        ["Source", event.roundRecord.source],
        ["Summary", event.roundRecord.summary],
      ])}
      ${renderDetailSection("Loop snapshot", [
        ["Completed rounds", String(run.completedRoundCount)],
        ["Next round index", String(run.round)],
        ["Best pass count", String(run.bestPassCount)],
      ])}
    `;
  }
  if (event.kind === "run-completed") {
    return `
      ${renderDetailSection("Run result", [
        ["Status", formatStatus(run.status)],
        ["Completed rounds", String(run.completedRoundCount)],
        ["Next round index", String(run.round)],
        ["Acceptance", `${run.bestPassCount}/${run.acceptanceCount} passed`],
      ])}
      <section class="inspector-section">
        <h4 class="section-label">Recorded outcome</h4>
        <div class="code-block">${escapeHtml(run.retrospective.taskResult)}</div>
      </section>
    `;
  }
  return `
    <section class="inspector-section">
      <h4 class="section-label">Recorded orchestration</h4>
      <div class="code-block">${escapeHtml(event.summary)}</div>
    </section>
    ${renderDetailSection("Run identity", [
      ["Run ID", run.id],
      ["Terminal", run.terminalSessionId],
      ["Project", run.project],
      ["Sequence", String(event.sequence)],
    ])}
  `;
}

function renderRunWorkerInspector(event, run) {
  const worker = event.worker;
  const relatedCase = run.acceptance.find(
    (item) => item.resultRound === worker.resultRound,
  );
  return `
    ${renderDetailSection("Worker identity", [
      ["Role", worker.role],
      ["Worker ID", worker.id],
      ["Panel ID", worker.panelId],
      ["tmux pane", worker.tmuxPaneId],
      ["Round", String(event.round)],
      ["Round source", worker.roundSource],
      ["Status", formatStatus(worker.status)],
    ])}
    <section class="inspector-section">
      <h4 class="section-label">Intent</h4>
      <div class="code-block">${escapeHtml(worker.intent)}</div>
    </section>
    <section class="inspector-section">
      <h4 class="section-label">Recorded result</h4>
      <div class="code-block">${escapeHtml(worker.summary)}</div>
    </section>
    ${
      relatedCase
        ? `
          <section class="inspector-section">
            <h4 class="section-label">Related acceptance</h4>
            <button class="related-button" data-run-event-id="case:${relatedCase.caseId}">
              <span>View recorded checkpoint</span>
              <strong>${escapeHtml(relatedCase.caseId)}</strong>
            </button>
          </section>
        `
        : ""
    }
  `;
}

function renderRunCaseInspector(item, run) {
  return `
    ${renderDetailSection("Checkpoint", [
      ["Case ID", item.caseId],
      ["Status", formatStatus(item.status)],
      ["Attempt", String(item.attempt)],
      ["Round", String(item.resultRound)],
      ["Round source", item.roundSource],
      ["Result", item.resultSummary],
      ["Source", run.verification.source],
    ])}
    <section class="inspector-section">
      <h4 class="section-label">Evidence · ${item.evidence.length}</h4>
      <div class="inspector-evidence-list">
        ${item.evidence
          .map(
            (evidence, index) => `
              <button
                class="inspector-evidence"
                data-run-event-id="evidence:${item.caseId}:${index}"
              >
                <span class="badge blue">${escapeHtml(evidence.type)}</span>
                <span><strong>${escapeHtml(evidence.label)}</strong><small>${escapeHtml(evidence.summary)}</small></span>
                <span class="run-chevron">›</span>
              </button>
            `,
          )
          .join("")}
      </div>
    </section>
    ${renderDetailSection("Verification source", [
      ["Type", run.verification.source],
      ["Test cases", run.verification.testCaseFilePath],
    ])}
  `;
}

function renderRunEvidenceInspector(event, run) {
  return `
    <section class="inspector-section">
      <h4 class="section-label">Evidence summary</h4>
      <div class="code-block">${escapeHtml(event.evidence.summary)}</div>
    </section>
    ${renderDetailSection("Evidence metadata", [
      ["Type", event.evidence.type],
      ["Case ID", event.acceptance.caseId],
      ["Round", String(event.acceptance.resultRound)],
      ["Run ID", run.id],
      [
        "Position",
        `${event.evidenceIndex + 1} of ${event.acceptance.evidence.length}`,
      ],
    ])}
    <section class="inspector-section">
      <h4 class="section-label">Related checkpoint</h4>
      <button class="related-button" data-run-event-id="case:${event.acceptance.caseId}">
        <span>Back to acceptance details</span>
        <strong>${escapeHtml(event.acceptance.caseId)}</strong>
      </button>
    </section>
  `;
}

function renderEmpty(message) {
  return `<div class="empty">${escapeHtml(message)}</div>`;
}

app.addEventListener("click", (event) => {
  const target = event.target.closest("button");
  if (!target) return;

  if (target.dataset.route) {
    state.route = target.dataset.route;
    state.search = "";
    state.selectedEventId = null;
    if (state.route === "agent-team") {
      state.runTab = "journal";
      state.selectedRunEventId = defaultRunEventId(selectedItem());
    }
    render();
    return;
  }

  if (target.dataset.terminalId) {
    state.selectedTerminalId = target.dataset.terminalId;
    state.eventFilter = "journal";
    const terminal = state.data.terminals.find(
      (item) => item.id === target.dataset.terminalId,
    );
    state.selectedEventId = terminal ? defaultEventId(terminal) : null;
    render();
    return;
  }

  if (target.dataset.runId) {
    state.selectedRunId = target.dataset.runId;
    state.runTab = "journal";
    const run = state.data.agentTeamRuns.find(
      (item) => item.id === target.dataset.runId,
    );
    state.selectedRunEventId = run ? defaultRunEventId(run) : null;
    render();
    return;
  }

  if (target.dataset.runTab) {
    state.runTab = target.dataset.runTab;
    const run = selectedItem();
    state.selectedRunEventId = defaultRunTabEventId(run, state.runTab);
    render();
    return;
  }

  if (target.dataset.runEventId) {
    state.selectedRunEventId = target.dataset.runEventId;
    render();
    return;
  }

  if (target.dataset.eventFilter) {
    state.eventFilter = target.dataset.eventFilter;
    const terminal = selectedItem();
    const filteredEvents = filterTerminalEvents(buildTerminalEvents(terminal));
    if (!filteredEvents.some((item) => item.id === state.selectedEventId)) {
      state.selectedEventId = filteredEvents[0]?.id ?? null;
    }
    render();
    return;
  }

  if (target.dataset.eventId) {
    state.selectedEventId = target.dataset.eventId;
    render();
    return;
  }

  if (target.dataset.relatedThreadId) {
    state.selectedEventId = `thread:${target.dataset.relatedThreadId}`;
    state.eventFilter = "journal";
    render();
    return;
  }

  if (target.matches("[data-close-inspector]")) {
    if (state.route === "terminals") {
      state.selectedEventId = null;
    } else {
      state.selectedRunEventId = null;
    }
    render();
  }
});

app.addEventListener("input", (event) => {
  if (!event.target.matches("[data-search]")) return;
  state.search = event.target.value;
  render();
  const searchInput = document.querySelector("[data-search]");
  searchInput?.focus();
  searchInput?.setSelectionRange(state.search.length, state.search.length);
});

fetch("./mock-state.json")
  .then((response) => {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  })
  .then((data) => {
    state.data = data;
    const terminal = data.terminals.find(
      (item) => item.id === state.selectedTerminalId,
    );
    state.selectedEventId = terminal ? defaultEventId(terminal) : null;
    render();
  })
  .catch((error) => {
    app.innerHTML = `
      <div class="empty">
        Failed to load prototype data: ${escapeHtml(error.message)}
      </div>
    `;
  });
