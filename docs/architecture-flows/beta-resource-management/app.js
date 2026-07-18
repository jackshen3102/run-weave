/* global document, window */

const slots = [
  {
    id: "pool-01",
    state: "idle",
    stateLabel: "IDLE",
    session: "—",
    manifest: "前一 Session 已 stopped",
    runtime: "相关 lease 已释放",
    summary: "当前唯一未分配的物理槽位。",
    signals: [
      ["Lease", "不存在"],
      ["Manifest", "无 active owner"],
      ["Runtime", "未归属当前 Session"],
      ["Recovery", "无需恢复"],
    ],
    conclusion:
      "正常空闲。它说明 allocator 退出不等于异常；真正的释放结果是 lease 文件消失。",
  },
  {
    id: "pool-02",
    state: "partial",
    stateLabel: "PARTIAL",
    session: "dvs-dcaf25",
    manifest: "ready",
    runtime: "Electron / Backend 已退出；App Server 存活",
    summary: "控制面仍认为 ready，但运行组已经分裂。",
    signals: [
      ["Lease", "仍由 dvs-dcaf25 持有"],
      ["Manifest", "ready / health=live"],
      ["Runtime", "仅 App Server PID 71587 存活"],
      ["Recovery", "需先 reconcile 为 stale"],
    ],
    conclusion:
      "已确认的 ready-vs-runtime 漂移。capacity 只看 lease，因此它继续消耗一个槽位；manifest 没有在组件退出时自动收敛。",
  },
  {
    id: "pool-03",
    state: "stale",
    stateLabel: "STALE",
    session: "dvs-1f5c30",
    manifest: "stale / identity drift",
    runtime: "记录 PID 均不存活；残留 Backend lock",
    summary: "旧身份无法通过，安全清理没有释放 lease。",
    signals: [
      ["Lease", "nonce 与 manifest 一致"],
      ["Manifest", "stale"],
      ["Runtime", "lock 指向不存在 PID 71189"],
      ["Recovery", "cleanup-stale / janitor"],
    ],
    conclusion:
      "资源事实看起来接近可回收，但当前 lease 仍存在。需要看到 janitor 的逐步判断，才能知道卡在 process absence、reset 还是 release 阶段。",
  },
  {
    id: "pool-04",
    state: "stale",
    stateLabel: "STALE LEASE",
    session: "dvs-74e006",
    manifest: "stale / skipped-stale-identity",
    runtime: "desktop status、Backend lock、App Server lock 均缺失",
    summary: "物理运行证据已经消失，但容量 lease 仍保留。",
    signals: [
      ["Lease", "仍由 dvs-74e006 持有"],
      ["Manifest", "stale"],
      ["Runtime", "三个关键 identity 文件缺失"],
      ["Recovery", "上次 cleanup 拒绝 release"],
    ],
    conclusion:
      "这是最清晰的容量泄漏样本：fail-safe 没有误删，但后续恢复为什么没有完成对操作者不可见。",
  },
  {
    id: "pool-05",
    state: "ready",
    stateLabel: "READY",
    session: "dvs-3d9fe4",
    manifest: "ready",
    runtime: "Electron / Backend / App Server / CDP 全部一致",
    summary: "当前用户自测 Beta，保持运行。",
    signals: [
      ["Lease", "nonce ba472e…"],
      ["Manifest", "ready"],
      ["Runtime", "3 个组件 + 2 个 CDP live"],
      ["Recovery", "不应触发"],
    ],
    conclusion:
      "健康占用。它的 allocatorPid 已退出是正常现象，因为资源 owner 由 Session、nonce 和长期组件 identity 共同证明。",
  },
];

const problems = [
  {
    id: "P1",
    title: "allocatorPid 是短命申请者，不是长期 owner",
    level: "代码事实 + 现场",
    trigger: "看到 capacity snapshot 中 allocatorLive=false。",
    mechanism:
      "lease 在 dev:session CLI 内创建；CLI 启动成功后退出，但 lease 继续由 ownerSessionId + leaseNonce 约束。",
    result:
      "如果把 allocatorLive 当健康状态，会把正常 ready 的 pool-05 误判为异常。",
  },
  {
    id: "P2",
    title: "ready manifest 不会持续代表 runtime 完整",
    level: "已确认现场",
    trigger: "Electron 或 Backend 在 Session ready 后独立退出。",
    mechanism:
      "manifest 是落盘控制状态；没有长期 watcher 在组件退出时立即更新它。",
    result:
      "pool-02 manifest 仍 ready，但只剩 App Server 存活，槽位仍按 occupied 计算。",
  },
  {
    id: "P3",
    title: "fail-safe 把身份不确定转化为容量占用",
    level: "代码事实 + 现场",
    trigger:
      "PID、process signature、lock、health 或 manifest owner 任一不一致。",
    mechanism:
      "stop / cleanup-stale 会拒绝 reset 和 release，防止杀掉 PID 复用或其他 Session 的资源。",
    result: "pool-03/04 保留 lease；安全性正确，但容量需要后续恢复闭环。",
  },
  {
    id: "P4",
    title: "janitor 结果不可见，无法解释“为什么没回收”",
    level: "代码事实",
    trigger: "每次 beta start 前运行 runBetaPoolJanitor()。",
    mechanism:
      "runStart() await 返回值但不保存、不打印；recovered / active / broken 摘要被丢弃。",
    result:
      "pool-03/04 在新 Session 启动后仍占用，操作者看不到具体卡在哪个安全检查。",
  },
  {
    id: "P5",
    title: "capacity snapshot 只回答 lease 数量，不回答可用性",
    level: "代码事实",
    trigger: "dry-run 或 acquire 前调用 inspectBetaSlotCapacity()。",
    mechanism:
      "snapshot 只读取五个 lease 文件，并显式返回 authoritative:false；不 join manifest 与 runtime。",
    result:
      "occupied 同时包含 healthy、partial、stale-manual 等不同语义，无法直接指导操作。",
  },
];

const navButtons = [...document.querySelectorAll(".nav button")];
const views = [...document.querySelectorAll(".view")];

function selectView(viewId) {
  navButtons.forEach((button) => {
    button.setAttribute(
      "aria-selected",
      String(button.dataset.view === viewId),
    );
  });
  views.forEach((view) => view.classList.toggle("active", view.id === viewId));
  window.history.replaceState(null, "", `#${viewId}`);
}

navButtons.forEach((button) => {
  button.addEventListener("click", () => selectView(button.dataset.view));
});

const poolGrid = document.querySelector("#pool-grid");
const slotDetail = document.querySelector("#slot-detail");

function renderSlotDetail(slot) {
  document.querySelectorAll(".slot").forEach((button) => {
    button.classList.toggle("selected", button.dataset.slot === slot.id);
  });
  slotDetail.innerHTML = `
    <div>
      <span class="badge ${slot.state}">${slot.stateLabel}</span>
      <h3>${slot.id} · ${slot.session}</h3>
      <p>${slot.conclusion}</p>
    </div>
    <div class="signal-grid">
      ${slot.signals.map(([name, value]) => `<div class="signal"><b>${name}</b><span>${value}</span></div>`).join("")}
    </div>`;
}

slots.forEach((slot) => {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "slot";
  button.dataset.slot = slot.id;
  button.innerHTML = `
    <div class="slot-top"><h3>${slot.id}</h3><span class="badge ${slot.state}">${slot.stateLabel}</span></div>
    <p>${slot.summary}</p>
    <dl><dt>Session</dt><dd>${slot.session}</dd><dt>Manifest</dt><dd>${slot.manifest}</dd><dt>Runtime</dt><dd>${slot.runtime}</dd></dl>`;
  button.addEventListener("click", () => renderSlotDetail(slot));
  poolGrid.appendChild(button);
});
renderSlotDetail(slots[1]);

const problemList = document.querySelector("#problem-list");
problems.forEach((problem, index) => {
  const article = document.createElement("article");
  article.className = `problem${index === 0 ? " open" : ""}`;
  article.innerHTML = `
    <button type="button" aria-expanded="${index === 0}">
      <span class="problem-id">${problem.id}</span>
      <span class="problem-title"><b>${problem.title}</b><span>${problem.result}</span></span>
      <span class="evidence">${problem.level}</span>
    </button>
    <div class="problem-body">
      <div><h4>触发条件</h4><p>${problem.trigger}</p></div>
      <div><h4>代码机制</h4><p>${problem.mechanism}</p></div>
      <div><h4>直接结果</h4><p>${problem.result}</p></div>
    </div>`;
  const toggle = article.querySelector("button");
  toggle.addEventListener("click", () => {
    const open = article.classList.toggle("open");
    toggle.setAttribute("aria-expanded", String(open));
  });
  problemList.appendChild(article);
});

const initialView = window.location.hash.slice(1);
if (views.some((view) => view.id === initialView)) {
  selectView(initialView);
}
