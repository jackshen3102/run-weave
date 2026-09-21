export const escapeHtml = (value = "") =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const paths = {
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  send: '<path d="m5 12 7-7 7 7M12 5v15"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  calendar:
    '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 11h18M8 15h2M14 15h2"/>',
  history: '<path d="M3 12a9 9 0 1 0 2.6-6.4L3 8M3 3v5h5M12 7v5l3 2"/>',
  inbox: '<path d="M4 4h16l2 11v5H2v-5L4 4ZM2 15h6l2 3h4l2-3h6"/>',
  folder:
    '<path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8ZM14 2v6h6M8 13h8M8 17h5"/>',
  code: '<path d="m8 7-5 5 5 5m8-10 5 5-5 5M14 4l-4 16"/>',
  search: '<circle cx="10.5" cy="10.5" r="7.5"/><path d="m16 16 5 5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  play: '<path d="m8 4 12 8-12 8Z"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7v6m0 3v1"/>',
  x: '<path d="m6 6 12 12M6 18 18 6"/>',
  arrow: '<path d="m12 5-7 7 7 7M5 12h14"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  edit: '<path d="m15 5 4 4M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15Z"/>',
  external:
    '<path d="M14 3h7v7m0-7L10 14M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5"/>',
  terminal:
    '<rect x="2" y="3" width="20" height="18" rx="2"/><path d="m6 8 4 4-4 4m7 0h5"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1 1m12 12 1 1M5 19l1-1M18 6l1-1"/>',
  moon: '<path d="M20.9 13a9 9 0 0 1-9.9-9.9A9 9 0 1 0 20.9 13Z"/>',
  git: '<circle cx="6" cy="5" r="3"/><circle cx="18" cy="19" r="3"/><path d="M6 8v13M18 16v-4a4 4 0 0 0-4-4h-2m3-3-3 3 3 3"/>',
  stop: '<rect x="5" y="5" width="14" height="14" rx="1"/>',
};
export function icon(name, cls = "") {
  return `<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.clock}</svg>`;
}
export const statusLabels = {
  queued: "排队中",
  running: "运行中",
  waiting: "等待处理",
  completed: "已完成",
  failed: "失败",
  cancelled: "已停止",
};
export function pill(status) {
  const symbols = {
    completed: "check",
    failed: "x",
    waiting: "alert",
    running: "clock",
    queued: "clock",
    cancelled: "stop",
  };
  return `<span class="pill ${status}">${icon(symbols[status])}${statusLabels[status]}</span>`;
}
export function button(label, action, id = "", variant = "", symbol = "") {
  return `<button type="button" class="button ${variant}" data-action="${action}" data-id="${escapeHtml(id)}">${symbol ? icon(symbol) : ""}${label}</button>`;
}
export function formatTime(date, zone = "Asia/Shanghai") {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: zone,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(date));
}
const weekdays = ["日", "一", "二", "三", "四", "五", "六"];
export function scheduleLabel(s) {
  return (
    {
      daily: "每天",
      weekdays: "工作日",
      weekly: `每周${s.days.map((d) => weekdays[d]).join("、")}`,
      once: s.date,
    }[s.frequency] + ` ${s.time}`
  );
}
// A small preview calculator for the four exposed scheduling controls; no scheduler runs here.
export function nextRun(schedule, now) {
  const zoneNow = new Date(
    new Date(now).toLocaleString("en-US", { timeZone: schedule.timezone }),
  );
  const [h, m] = schedule.time.split(":").map(Number);
  if (schedule.frequency === "once") {
    const date = new Date(`${schedule.date}T${schedule.time}:00`);
    return date > zoneNow
      ? `${schedule.date.replaceAll("-", "/")} ${schedule.time}`
      : null;
  }
  if (schedule.frequency === "weekly" && !schedule.days.length) return null;
  for (let offset = 0; offset < 8; offset++) {
    const candidate = new Date(zoneNow);
    candidate.setDate(candidate.getDate() + offset);
    candidate.setHours(h, m, 0, 0);
    const day = candidate.getDay();
    if (
      candidate <= zoneNow ||
      (schedule.frequency === "weekdays" && (day === 0 || day === 6)) ||
      (schedule.frequency === "weekly" && !schedule.days.includes(day))
    )
      continue;
    return `${candidate.getFullYear()}/${String(candidate.getMonth() + 1).padStart(2, "0")}/${String(candidate.getDate()).padStart(2, "0")} ${schedule.time}`;
  }
  return null;
}
export function showDialog(id, content) {
  const dialog = document.getElementById(id);
  dialog.innerHTML = content;
  dialog.showModal();
  return dialog;
}
export function toast(message) {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove("show"), 2800);
}
