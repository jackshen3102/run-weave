export function createDiagnostics(ui) {
  const {
    state: s,
    fixture: f,
    esc,
    button: b,
    row,
    section,
    card,
    select,
  } = ui;
  const data = () =>
    (s.diagnostics[s.target] ||= structuredClone(f.diagnostics));
  const disabled = () => ui.offline() || s.busy;
  const attr = (id, off = false) =>
    `data-id="${esc(id)}" ${off ? "disabled" : ""}`;
  const stateLabels = {
    free: "空闲",
    busy: "使用中",
    blocked: "待检查",
    unknown: "未知",
  };
  const stamp = () => new Date().toLocaleTimeString();
  function init() {
    s.diagnostics = {};
    s.resourceSort = "energy";
    s.resourceFilter = "all";
    s.processResults = {};
    s.desktopStatus = {
      loaded: true,
      revision: 4,
      error: "",
      consumers: structuredClone(f.desktopConsumers),
    };
  }
  function toolbar(title, action) {
    return `<div class="section-heading"><h2>${esc(title)}</h2>${b("刷新", action, "ghost", disabled() ? "disabled" : "")}</div>`;
  }
  function render() {
    const tabs = ui.tabs([
      ["runtime", "运行状态"],
      ["resources", "系统资源"],
      ["dev", "开发资源"],
      ["quota", "Codex 额度"],
      ["logs", "日志记录"],
    ]);
    return (
      tabs + ({ runtime, resources, dev, quota, logs }[s.tab] || runtime)()
    );
  }
  function runtime() {
    const d = data();
    const nodeIds = s.target === "local" ? ["local"] : ["local", s.target];
    return (
      toolbar("节点与能力", "refresh-runtime") +
      nodeIds
        .map((id) => {
          const c = s.connections.find((c) => c.id === id),
            bad = !c.online;
          return section(
            id === "local" ? "本机节点" : "连接节点",
            card(
              row(
                c.name,
                `${c.endpoint || "暂无可用地址"} · ${bad ? "连接中断，上次快照" : "更新于 " + (d.observedAt || "14:35:20")}`,
                b(
                  "复制节点地址",
                  "copy-diagnostic",
                  "ghost",
                  `data-value="${esc(c.endpoint)}"`,
                ),
              ) +
                (bad
                  ? '<p role="alert" class="inline-error">网络不可达 · 最近成功 14:33:18 · 恢复重试 2 / 5</p>'
                  : "") +
                f.capabilities
                  .filter((c) => id === "local" || c.id !== "desktop")
                  .map(
                    (cap) =>
                      `<details class="diagnostic-detail"><summary>${esc(cap.label)} <span class="badge">${bad ? "无法判断" : cap.state}</span></summary><p>${esc(cap.summary)}</p><p class="muted small">更新于 ${d.observedAt || "14:35:20"}${bad ? " · 最近上报，当前状态无法确认" : ""}</p>${row("监听地址", `${c.endpoint || "未上报"}`, b("复制地址", "copy-diagnostic", "ghost", `data-value="${esc(c.endpoint)}"`))}${cap.id === "desktop" ? b("本台桌面诊断", "diagnostic-desktop") : cap.id === "app-server" ? b("查看额度", "diagnostic-quota") : cap.id === "background-tasks" ? b("查看实例配置", "open-advanced") : ""}</details>`,
                  )
                  .join("") +
                versions(id),
            ),
          );
        })
        .join("") +
      section(
        "本台页面",
        card(
          row(
            "Web（当前页面）",
            "2026.10.11 · 构建来源：local-build",
            b(
              "复制 Web 版本",
              "copy-diagnostic",
              "ghost",
              'data-value="Web 2026.10.11 / local-build"',
            ),
          ),
        ),
      ) +
      b("查看系统资源", "diagnostic-resources")
    );
  }
  function versions(id) {
    return `<details class="diagnostic-detail"><summary>组件版本</summary>${f.versions
      .filter((v) => id === "local" || v.name !== "Desktop")
      .map((v) =>
        row(
          v.name,
          v.version,
          `<details><summary>构建详情</summary><p>构建：${esc(v.build)}</p><p>来源：${esc(v.source)}</p>${b("复制 " + v.name + " 版本", "copy-diagnostic", "ghost", `data-value="${esc(v.name + " " + v.version + " " + v.build)}"`)}</details>`,
        ),
      )
      .join("")}</details>`;
  }
  function resources() {
    const d = data();
    const apps = [...d.apps].sort(
      (a, b) => b[s.resourceSort] - a[s.resourceSort],
    );
    return (
      toolbar("系统资源", "refresh-resources") +
      `<div class="actions">${b(s.displayPaused ? "继续显示" : "暂停显示", "pause-resources", "ghost")}${b("提醒设置", "open-monitoring", "ghost")}${b("运行状态", "diagnostic-runtime", "ghost")}</div>${s.displayPaused ? '<p role="status" class="note">显示已暂停，后台采样继续。</p>' : ""}` +
      `<div class="stat-grid">${[
        ["CPU", "18.6% · 10 核心"],
        ["内存", "78% · 12.4 / 16 GB · 正常"],
        ["电池", "86% · 电池供电"],
        ["Swap", "1.2 GB · 每分钟采样"],
      ]
        .map(
          ([k, v]) =>
            `<div class="stat"><small>${k}</small><strong>${v}</strong></div>`,
        )
        .join(
          "",
        )}</div>${d.notice ? `<aside class="note"><div><strong>Code 内存占用较大</strong><p>近 5 分钟多次检测到高占用；内存占用不代表耗电量。</p><div class="actions">${b("查看进程", "notice-process")}${b("关闭提醒", "dismiss-notice", "ghost")}${b("忽略 1 小时", "snooze-notice", "ghost")}</div></div></aside>` : ""}<div class="section-heading"><h2>应用与进程</h2>${select(
        "resource-sort",
        "进程排序",
        s.resourceSort,
        [
          ["energy", "能耗"],
          ["cpu", "CPU"],
          ["memory", "内存"],
        ],
      )}</div>` +
      card(
        apps
          .map(
            (app) =>
              `<details class="diagnostic-detail" ${s.expandedApp === app.id ? "open" : ""}><summary>${esc(app.name)} · 能耗 ${app.energy} · CPU ${app.cpu}% · RSS ${app.memory} MB · ${app.processes.length} 个进程</summary><div class="table-scroll"><table><thead><tr><th>PID</th><th>Process</th><th>CPU Core</th><th>RSS</th><th>操作</th></tr></thead><tbody>${app.processes
                .map((p) => {
                  const result = d.results?.[p.instanceId];
                  return `<tr data-process="${p.instanceId}"><td>${p.pid}</td><td>${esc(p.name)}</td><td>${p.cpu}%</td><td>${p.memory} MB</td><td>${result ? `<span role="status">${esc(result.message)}</span>` : ""}${result?.done ? "" : b(p.kind === "readonly" ? "受保护" : result?.forceAllowed ? "强制结束…" : p.kind === "stop_service" ? "停止服务" : "结束进程", "terminate-process", "ghost", `${attr(p.instanceId, disabled() || p.kind === "readonly" || (s.target !== "local" && !ui.config().remoteControl))} data-force="${Boolean(result?.forceAllowed)}"`)}${p.reason ? `<p class="muted small">${esc(p.reason)}</p>` : ""}</td></tr>`;
                })
                .join("")}</tbody></table></div></details>`,
          )
          .join(""),
      ) +
      `<p class="muted small">更新于 ${d.observedAt || "14:35:20"} · 部分进程未提供能耗数据。</p>`
    );
  }
  function dev() {
    const d = data();
    return (
      toolbar("开发资源", "refresh-dev") +
      `<div class="stat-grid">${["桌面测试", "模拟器测试"]
        .map((kind) => {
          const list = d.dev.filter((r) => r.group === kind);
          return `<div class="stat"><small>${kind}</small><strong>${list.filter((r) => r.state === "free").length} / ${list.length}</strong><p>空闲 / 总计</p></div>`;
        })
        .join(
          "",
        )}<div class="stat"><small>待检查</small><strong>${d.dev.filter((r) => ["blocked", "unknown"].includes(r.state)).length}</strong>${b("查看待检查资源", "filter-attention", "ghost")}</div></div><div class="section-heading"><h2>资源清单</h2>${select(
        "resource-filter",
        "资源状态",
        s.resourceFilter,
        [
          ["all", "全部状态"],
          ["busy", "使用中"],
          ["free", "空闲"],
          ["blocked", "待检查"],
          ["unknown", "未知"],
          ["attention", "全部待检查"],
        ],
      )}</div>` +
      ["桌面测试", "模拟器测试"]
        .map((group) =>
          section(
            group,
            card(
              d.dev
                .filter(
                  (r) =>
                    r.group === group &&
                    (s.resourceFilter === "all" ||
                      s.resourceFilter === r.state ||
                      (s.resourceFilter === "attention" &&
                        ["blocked", "unknown"].includes(r.state))),
                )
                .map(
                  (r) =>
                    `<details class="diagnostic-detail"><summary>${esc(r.name)} · ${stateLabels[r.state]} · ${esc(r.owner?.task || "没有占用任务")}</summary>${r.operation ? `<p role="status">${esc(r.operation)}</p>` : ""}<dl class="facts">${[
                      ["工作树", r.owner?.worktree],
                      ["占用者", r.owner?.id],
                      ["占用开始", r.owner?.startedAt],
                      ["最后活动", r.owner?.lastActivity],
                      ["工作目录", r.path],
                      ["端口", r.ports.join(" · ")],
                      ["设备 UDID", r.udid || "—"],
                      ["当前进程", r.processes.join(" · ")],
                      ["归属版本", r.ownershipVersion],
                    ]
                      .map(([k, v]) => `<dt>${k}</dt><dd>${esc(v || "—")}</dd>`)
                      .join(
                        "",
                      )}</dl>${r.action ? b(r.action === "stop-and-release" ? "停止并释放" : "释放占用", "release-dev", "danger", attr(r.id, disabled() || Boolean(r.pending))) : `<p class="muted">${esc(r.reason || "无需释放")}</p>`}</details>`,
                )
                .join("") || '<div class="empty">没有匹配的资源</div>',
            ),
          ),
        )
        .join("") +
      `<p class="muted small">当前快照 · 更新于 ${d.observedAt || "14:35:20"}</p>`
    );
  }
  function quota() {
    const d = data();
    const q = d.quota;
    return (
      toolbar("Codex 额度", "refresh-quota") +
      (q.error
        ? `<p role="alert" class="inline-error">${esc(q.error)}；额度为上次记录</p>`
        : "") +
      section(
        "App Server 的 ChatGPT 订阅",
        card(
          [
            ["每周剩余", q.weekly],
            ["短周期剩余", q.shortWindow],
          ]
            .map(([label, v]) =>
              row(
                label,
                v === null
                  ? "上游未提供此窗口"
                  : `下次重置：${q.resetsAt}${q.stale ? "（已到期，请刷新确认）" : ""}`,
                v === null
                  ? "<span>未知</span>"
                  : `<div class="quota-control"><strong>${v}%</strong><progress aria-label="${label}" value="${v}" max="100"></progress></div>`,
              ),
            )
            .join(""),
        ),
      ) +
      `<p class="muted small">更新于 ${q.observedAt}${q.stale ? "（旧记录）" : ""}。仅打开或手动刷新时查询。</p>`
    );
  }
  function logs() {
    const l = data().logs;
    return (
      section(
        "日志上报",
        card(
          row(
            "记录状态",
            l.startedAt
              ? "记录开始时间：" + l.startedAt
              : "所选 Backend 与本台 Web 诊断日志",
            `<span class="badge">${l.recording ? "正在记录" : l.result ? "已结束" : "未开始"}</span>`,
          ) +
            row(
              l.recording ? "结束本轮记录" : "开始一次日志记录",
              "结束时将 Web 与服务端诊断日志保存到服务端目录。",
              b(
                l.recording ? "结束并上报" : "开始记录",
                "toggle-log",
                "primary",
                disabled() ? "disabled" : "",
              ),
            ),
        ),
      ) +
      (l.result
        ? section(
            `本轮日志 ${l.result.events.length} 条`,
            card(
              `<div class="actions padded">${b("下载日志", "export-log")}${b("复制日志正文", "copy-log")}${b("复制日志路径", "copy-log-path", "", l.result.path ? "" : "disabled")}</div><p class="padded break-all">${esc(l.result.path || "已结束记录，但未返回服务端日志路径。")}</p><textarea class="log-text" readonly aria-label="日志正文">${esc(l.result.events.join("\n"))}</textarea>`,
            ),
          )
        : "")
    );
  }
  function desktop() {
    if (!ui.desktopAvailable())
      return '<div class="empty">当前环境未提供本台桌面诊断能力。</div>';
    const d = s.desktopStatus;
    return (
      `<div class="section-heading"><h2>本台桌面的配置状态</h2>${b("刷新桌面状态", "refresh-desktop", "ghost")}</div>` +
      (d.error
        ? `<p role="alert" class="inline-error">${esc(d.error)}</p>`
        : "") +
      card(
        row("运行环境", "Stable · local-desktop · 保存版本 " + d.revision, "") +
          (ui.params.get("config") === "disk-error"
            ? '<p role="alert" class="inline-error">磁盘配置无法读取，当前进程仍保留已采用的配置。</p>'
            : "") +
          d.consumers
            .map((c) =>
              row(
                c.domain,
                c.state +
                  (c.revision === null ? "" : " · 生效版本 " + c.revision),
                "",
              ),
            )
            .join("") +
          versions("local"),
      ) +
      section(
        "诊断与维护",
        card(
          row(
            "诊断文件",
            "导出本台桌面的版本与诊断信息。",
            b("导出诊断", "download-desktop", "ghost"),
          ) +
            row(
              "重新加载本机运行时",
              "本台连接将暂时中断，远端电脑不会重新加载。",
              b("重新加载", "reload-runtime", "danger"),
            ),
        ),
      )
    );
  }
  function findProcess(id) {
    return data()
      .apps.flatMap((a) => a.processes)
      .find((p) => p.instanceId === id);
  }
  function refresh(kind) {
    ui.run(async () => {
      await ui.delay();
      const d = data();
      if (kind === "quota" && ui.fault("quota-401")) {
        s.reauth[s.target] = true;
        d.quota.weekly = null;
        d.quota.shortWindow = null;
        return;
      }
      if (ui.fault(kind + "-refresh")) {
        if (kind === "quota") {
          d.quota.error = "额度更新失败";
          d.quota.stale = true;
          return;
        }
        throw Error("无法读取最新状态，保留上次快照。");
      }
      d.observedAt = stamp();
      if (kind === "quota") {
        d.quota.error = "";
        d.quota.stale = false;
        d.quota.observedAt = stamp();
      }
      if (kind === "dev")
        d.dev.forEach((r) => {
          if (r.pending) {
            r.state = "free";
            r.owner = null;
            r.action = null;
            r.pending = false;
            r.operation = "已释放";
          }
        });
    });
  }
  function action(name, el) {
    const id = el.dataset.id;
    if (["resource-sort", "resource-filter"].includes(name)) return false;
    if (name === "pause-resources") {
      s.displayPaused = !s.displayPaused;
      ui.render();
      return true;
    }
    if (name === "open-monitoring") {
      ui.navigate("monitoring");
      return true;
    }
    if (name === "diagnostic-runtime") {
      ui.navigate("status", { tab: "runtime" });
      return true;
    }
    if (name === "copy-diagnostic") {
      ui.copy(el.dataset.value);
      return true;
    }
    if (name === "diagnostic-desktop") {
      ui.navigate("desktop");
      return true;
    }
    if (name === "diagnostic-quota" || name === "diagnostic-resources") {
      ui.navigate("status", {
        tab: name === "diagnostic-quota" ? "quota" : "resources",
      });
      return true;
    }
    if (
      name.startsWith("refresh-") &&
      ["runtime", "resources", "dev", "quota"].includes(name.slice(8))
    ) {
      refresh(name.slice(8));
      return true;
    }
    if (name === "refresh-desktop") {
      ui.run(async () => {
        await ui.delay();
        s.desktopStatus.error = ui.fault("desktop-refresh")
          ? "无法读取本台桌面的配置状态。"
          : "";
      });
      return true;
    }
    if (name === "filter-attention") {
      s.resourceFilter = "attention";
      ui.render();
      return true;
    }
    if (name === "notice-process") {
      s.expandedApp = "code";
      data().notice = false;
      ui.render();
      return true;
    }
    if (name === "dismiss-notice") {
      data().notice = false;
      ui.render();
      return true;
    }
    if (name === "snooze-notice") {
      ui.run(async () => {
        await ui.delay();
        if (ui.fault("snooze")) throw Error("忽略失败，请重试。");
        data().notice = false;
        data().snoozedUntil = Date.now() + 3600000;
      });
      return true;
    }
    if (name === "terminate-process") {
      const p = findProcess(id),
        force = el.dataset.force === "true",
        computer = s.target;
      if (
        disabled() ||
        p.kind === "readonly" ||
        (computer !== "local" && !ui.config().remoteControl)
      )
        return true;
      ui.confirm(
        force
          ? "强制结束进程？"
          : p.kind === "stop_service"
            ? "停止服务？"
            : "结束进程？",
        `${ui.target().name} · ${p.name} · PID ${p.pid}${force ? "。强制结束可能丢失未保存的数据。" : ""}`,
        () =>
          ui.run(async () => {
            await ui.delay();
            const d = s.diagnostics[computer];
            s.operations.push({
              operation: "terminate",
              computer,
              processInstanceId: id,
              force,
            });
            d.results ||= {};
            if (ui.fault("process-denied")) {
              d.results[id] = {
                message: "权限已撤销，请重新读取授权",
                done: false,
              };
              return;
            }
            if (ui.fault("process-exited")) {
              d.results[id] = { message: "进程已退出", done: true };
              return;
            }
            d.results[id] =
              !force && p.normalResult === "still_running"
                ? { message: "仍在运行", forceAllowed: true, done: false }
                : { message: "已结束", done: true };
          }),
        force ? "强制结束" : "确认结束",
      );
      return true;
    }
    if (name === "release-dev") {
      const d = data(),
        r = d.dev.find((r) => r.id === id),
        version = r.ownershipVersion,
        computer = s.target;
      ui.confirm(
        r.action === "stop-and-release" ? "停止并释放资源？" : "释放资源占用？",
        `${r.name} · 占用任务：${r.owner?.task || "未知"} · 工作树：${r.owner?.worktree || "未知"}。${r.action === "stop-and-release" ? "将中断当前测试。" : ""}只清理该任务自有的服务和占用，保留共享服务。`,
        () =>
          ui.run(async () => {
            await ui.delay();
            s.operations.push({
              operation: "release",
              computer,
              id,
              expectedOwnershipVersion: version,
              idempotencyKey: crypto.randomUUID(),
            });
            if (ui.fault("ownership-conflict")) {
              r.ownershipVersion++;
              r.operation = "资源归属已变化，未释放。请刷新核对。";
              return;
            }
            if (ui.fault("release-unknown")) {
              r.operation = "释放结果尚未确认，请手动刷新核查";
              return;
            }
            if (ui.fault("release-running")) {
              r.pending = true;
              r.operation = "释放仍在进行，请稍后手动刷新查看结果";
              return;
            }
            r.state = "free";
            r.owner = null;
            r.action = null;
            r.operation = "已释放";
          }),
        r.action === "stop-and-release" ? "确认停止并释放" : "确认释放占用",
      );
      return true;
    }
    if (name === "toggle-log") {
      ui.run(async () => {
        const l = data().logs;
        await ui.delay();
        if (ui.fault("logs-report"))
          throw Error("日志上报失败，本轮记录仍保留，请重试。");
        if (l.recording) {
          l.recording = false;
          l.result = {
            path:
              ui.params.get("logs") === "no-path"
                ? ""
                : "/tmp/runweave/diagnostics/session-001.json",
            events: [
              `[Web] ${l.startedAt} 开始记录`,
              "[Backend] 请求诊断快照",
              "[Web] 结束并上报",
            ],
          };
        } else {
          l.recording = true;
          l.startedAt = stamp();
          l.result = null;
        }
      });
      return true;
    }
    if (name === "export-log") {
      ui.download("runweave-prototype-logs.json", {
        prototype: true,
        computer: ui.target().name,
        ...data().logs.result,
      });
      return true;
    }
    if (name === "copy-log") {
      ui.copy(data().logs.result.events.join("\n"));
      return true;
    }
    if (name === "copy-log-path") {
      ui.copy(data().logs.result.path);
      return true;
    }
    return false;
  }
  function setField(key, value) {
    if (key === "resource-sort") {
      s.resourceSort = value;
      ui.render();
      return true;
    }
    if (key === "resource-filter") {
      s.resourceFilter = value;
      ui.render();
      return true;
    }
    return false;
  }
  function scenario() {
    if (ui.params.get("quota") === "unknown") data().quota.weekly = null;
    if (ui.params.get("quota") === "stale") data().quota.stale = true;
    if (ui.params.get("resources") === "empty") {
      data().apps = [];
      data().dev = [];
      data().notice = false;
    }
  }
  return { init, render, desktop, action, setField, scenario };
}
