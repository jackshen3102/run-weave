/* global document */

const services = [
  { id: "frontend", label: "Frontend", icon: "FE" },
  { id: "backend", label: "Backend", icon: "BE" },
  { id: "appServer", label: "App Server", icon: "AS" },
  { id: "cdp", label: "CDP", icon: "CDP" },
];

const modes = {
  frontend: {
    title: "Frontend only：最快反馈，不制造一套伪 Beta",
    description:
      "只改页面、组件和交互时，启动独立 Vite，明确固定一个 Backend 或 fixture；通过右侧 Browser 的 group-scoped 页面验证。",
    trigger: "pnpm dev --profile frontend → dev:open --surface web",
    services: {
      frontend: [
        "dedicated",
        "独立 Vite origin/HMR；避免与其他 agent 共用 localStorage 和 service worker。",
      ],
      backend: [
        "shared",
        "Backend 未改且测试不制造状态冲突时，明确复用默认 Backend。",
      ],
      appServer: [
        "shared",
        "随默认 Backend 使用全局 App Server；Frontend 不直接绑定它。",
      ],
      cdp: [
        "shared",
        "复用 Stable 右侧 Browser 的 group-scoped endpoint，只控制本页面。",
      ],
    },
  },
  fullstack: {
    title: "Web full-stack：Frontend 与 Backend 成对独占",
    description:
      "API、状态或终端逻辑变化时，Frontend proxy 必须绑定本次 dedicated Backend，Backend profile 由 devSessionId 隔离。",
    trigger: "pnpm dev --profile fullstack",
    services: {
      frontend: [
        "dedicated",
        "VITE_PROXY_TARGET 指向同 capsule Backend，并校验 expectedBackendId。",
      ],
      backend: [
        "dedicated",
        "独立端口、profile、auth、tmux 和 lock；不能只按 cwd hash。",
      ],
      appServer: [
        "shared",
        "未改事件链、状态和生命周期时可明确使用默认全局 App Server。",
      ],
      cdp: [
        "shared",
        "页面验收可用独立 Playwright session 或 group-scoped Browser target。",
      ],
    },
  },
  appserver: {
    title: "App Server / hooks：事件中心必须独占",
    description:
      "改动 App Server、hook、event schema、cursor 或恢复逻辑时，共享 Stable App Server 会污染事件、版本和生命周期证据。",
    trigger: "pnpm dev --profile app-server",
    services: {
      frontend: [
        "dedicated",
        "页面通过 dedicated Backend 观察本次 App Server 状态。",
      ],
      backend: [
        "dedicated",
        "独立 profile/cursor，显式注入本次 App Server URL/token。",
      ],
      appServer: [
        "dedicated",
        "独立 home、token、event log、thread state、runtime、lock 和端口。",
      ],
      cdp: ["shared", "只承担页面取证；不成为事件系统的一部分。"],
    },
  },
  electron: {
    title: "Electron Dev：验证桌面边界，但跳过安装态成本",
    description:
      "涉及 Electron bridge、Terminal Browser、CDP 或窗口行为时，启动完整 Electron Dev capsule；只有安装/更新差异才进入 Beta。",
    trigger: "pnpm dev --profile electron",
    services: {
      frontend: [
        "dedicated",
        "Electron 加载本次 Dev Session frontend，标记 revision/devSessionId。",
      ],
      backend: [
        "shared",
        "Backend 未改且不验证其状态/生命周期时，可以明确复用默认 Backend。",
      ],
      appServer: [
        "shared",
        "按影响闭包使用默认 App Server；涉及事件或生命周期时升级为 dedicated。",
      ],
      cdp: [
        "dedicated",
        "Desktop 与 Terminal Browser 两个 surface 都归本 Electron Dev Session。",
      ],
    },
  },
  beta: {
    title: "Beta / Multi-Beta：App 隔离，依赖仍按范围选择",
    description:
      "只有 packaging、runtime、updater、安装态、迁移或并行 revision 场景需要 Beta。Beta instance 是 Dev Session 的一种 profile/resource。",
    trigger: "pnpm dev --profile beta --instance <id>",
    services: {
      frontend: [
        "dedicated",
        "打包 revision 与 instance identity 写入页面和状态。",
      ],
      backend: [
        "shared",
        "Backend 未改、契约兼容且状态不冲突时复用默认实例；涉及 runtime/profile 时 dedicated。",
      ],
      appServer: [
        "shared",
        "App Server 未改且不验证其状态/生命周期时复用默认实例；否则 dedicated。",
      ],
      cdp: [
        "dedicated",
        "每实例动态 Desktop CDP + Terminal Browser Proxy；按 instanceId+surface 解析。",
      ],
    },
  },
};

const risks = [
  {
    id: "R1",
    kind: "fact",
    level: "当前代码事实",
    title: "Backend 会自动发现默认全局 App Server",
    detail:
      "没有显式 RUNWEAVE_APP_SERVER_URL/TOKEN 时，discoverAppServer() 回退读取默认 stateDir 的 lock/token。隔离模式需要关闭这一 fallback。",
  },
  {
    id: "R2",
    kind: "fact",
    level: "当前代码事实",
    title: "dev profile 默认只按 cwd hash",
    detail:
      "不同 worktree 通常隔离，但同一 worktree 内两个 agent 会解析到同一 profile，从而共享 lock、terminal store、auth 和 tmux。",
  },
  {
    id: "R3",
    kind: "risk",
    level: "结构性风险",
    title: "Frontend 知道 Backend 地址，但不知道 Backend 身份",
    detail:
      "Vite proxy 已显式绑定端口，这是正确基础；复用默认 Backend 也合理，但若端口被重用或服务重启，仍需用 serviceInstanceId/capability 确认解析结果。",
  },
  {
    id: "R4",
    kind: "fact",
    level: "当前现场事实",
    title: "多个 lock 和 CDP endpoint 同时存在",
    detail:
      "当前观察到 5 份 Backend lock、Stable/Beta 两个 App Server lock、3 个 Runweave CDP Proxy 与 1 个 Beta Desktop CDP。端口不能充当实例主键。",
  },
  {
    id: "R5",
    kind: "risk",
    level: "已验证历史问题",
    title: "全局 Playwright 配置会把 Agent 带到错误 CDP",
    detail:
      "ambient env 和 ~/.playwright/cli.config.json 的优先级与被测目标无关；Runweave 自身验证必须使用 manifest resolver 的显式 endpoint。",
  },
  {
    id: "R6",
    kind: "risk",
    level: "明确共享边界",
    title: "共享 App Server 仍共享日志、版本和生命周期",
    detail:
      "App Server 未改且不验证其状态/生命周期时可以共享。Backend ownership filter 能降低业务事件串线；改 App Server、event schema、重放或进程恢复时必须 dedicated。",
  },
  {
    id: "R7",
    kind: "risk",
    level: "结构性风险",
    title: "各服务独立找空闲端口，无法证明它们属于同一组",
    detail:
      "动态端口解决占用，不解决归属。Dev Session manifest 必须先解析 serviceInstanceId，再记录每项 transport。",
  },
];

const serviceGrid = document.querySelector("#service-grid");
const modeTitle = document.querySelector("#mode-title");
const modeDescription = document.querySelector("#mode-description");
const modeTrigger = document.querySelector("#mode-trigger");

function renderMode(modeId) {
  const mode = modes[modeId];
  modeTitle.textContent = mode.title;
  modeDescription.textContent = mode.description;
  modeTrigger.textContent = mode.trigger;
  serviceGrid.replaceChildren(
    ...services.map((service) => {
      const [ownership, detail] = mode.services[service.id];
      const card = document.createElement("article");
      card.className = "service-card";
      card.dataset.service = service.id;
      card.innerHTML = `
        <span class="service-icon">${service.icon}</span>
        <div class="service-title">
          <h3>${service.label}</h3>
          <span class="ownership ${ownership}">${ownership === "shared" ? "shared-declared" : ownership}</span>
        </div>
        <p>${detail}</p>
      `;
      return card;
    }),
  );
}

document.querySelectorAll(".mode-tab").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".mode-tab").forEach((candidate) => {
      candidate.setAttribute("aria-pressed", String(candidate === button));
    });
    renderMode(button.dataset.mode);
  });
});

const riskList = document.querySelector("#risk-list");
riskList.replaceChildren(
  ...risks.map((risk) => {
    const article = document.createElement("article");
    article.className = "risk-item";
    article.dataset.kind = risk.kind;
    article.innerHTML = `
      <div class="risk-meta"><span class="risk-id">${risk.id}</span><span class="risk-level">${risk.level}</span></div>
      <h3>${risk.title}</h3>
      <p>${risk.detail}</p>
    `;
    return article;
  }),
);

document.querySelectorAll(".risk-filter").forEach((button) => {
  button.addEventListener("click", () => {
    const filter = button.dataset.filter;
    document.querySelectorAll(".risk-filter").forEach((candidate) => {
      candidate.setAttribute("aria-pressed", String(candidate === button));
    });
    document.querySelectorAll(".risk-item").forEach((item) => {
      item.hidden = filter !== "all" && item.dataset.kind !== filter;
    });
  });
});

renderMode("frontend");
