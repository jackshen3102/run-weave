export function createConnections(ui) {
  const {
    state: s,
    fixture: f,
    esc,
    button: b,
    row,
    card,
    section,
    field,
    select,
    toggle,
  } = ui;
  const hosts = () => s.hosts;
  const host = () => hosts().find((h) => h.id === s.hostId);
  let detected = false;
  const labels = {
    ready: "已建立",
    disconnected: "未连接",
    connecting: "连接中",
    reconnecting: "正在重连",
    failed: "运行失败",
    waiting: "等待主机连接",
    disabled: "已关闭",
  };
  function init() {
    s.hosts = structuredClone(f.sshHosts);
    s.tunnelRevision = 1;
    s.hostId = null;
    if (ui.params.get("ssh") === "failed") s.hosts[0].status = "failed";
    if (ui.params.get("ssh") === "empty") s.hosts = [];
    s.connections = s.connections.map((c) =>
      c.id === "local"
        ? { ...c, isSystem: true, canEdit: false, canDelete: false }
        : c.kind === "SSH"
          ? {
              ...c,
              tunnelEndpointId: "endpoint-dev",
              hostId: "host-dev",
              canEdit: false,
            }
          : { ...c, canEdit: true },
    );
    sync();
  }
  function sync() {
    for (const c of s.connections.filter((c) => c.tunnelEndpointId)) {
      const h = hosts().find((h) =>
        h.endpoints.some((e) => e.id === c.tunnelEndpointId),
      );
      c.online = h?.status === "ready";
      c.hostId = h?.id;
      c.endpoint = c.online ? "http://127.0.0.1:53001" : "";
      c.statusMessage = c.online ? "通过 SSH 通道连接" : "等待 SSH 通道";
    }
  }
  function prepare() {
    detected = false;
    if (s.tab === "hosts" && s.detail) {
      const empty = {
        id: crypto.randomUUID(),
        name: "",
        sshTarget: "",
        autoConnect: false,
        status: "disconnected",
        forwards: [],
        endpoints: [],
        remoteAccess: { enabled: false, listenAddress: "", port: 15443 },
        remoteDesktop: {
          enabled: false,
          listenAddress: "",
          port: 15446,
          localAddress: "",
          localPort: 48571,
          certificateFingerprint: "",
        },
        browser: {
          enabled: false,
          profileId: "profile-1",
          backendPort: 5001,
          approvedBrowserGroupId: null,
        },
      };
      s.draft = structuredClone(s.detail === "new" ? empty : host());
      s.hostRevision = s.tunnelRevision;
    } else if (s.detail) {
      s.draft = structuredClone(
        s.detail === "new"
          ? { name: "", endpoint: "", kind: "直接连接", tunnelEndpointId: "" }
          : s.connections.find((c) => c.id === s.detail),
      );
    } else s.draft = null;
  }
  const control = (label, action, id, disabled = false) =>
    b(
      label,
      action,
      "ghost",
      `data-id="${esc(id)}" ${disabled ? "disabled" : ""}`,
    );
  function render() {
    if (!ui.desktopAvailable())
      return '<div class="empty">连接与 SSH 主机管理需要 Runweave 桌面端。</div>';
    const tabs = ui.tabs([
      ["saved", "已保存的连接"],
      ["hosts", "SSH 主机与通道"],
    ]);
    if (s.tab === "hosts") return tabs + (s.detail ? editor() : hostList());
    if (s.detail) {
      const d = s.draft;
      if (d?.canEdit === false)
        return (
          tabs +
          '<div class="note">此连接由系统或 SSH 通道管理，不能直接编辑。</div>'
        );
      return (
        tabs +
        b("返回连接列表", "connection-list", "ghost") +
        `<div class="card form-grid">${field("name", "连接名称", d.name)}<label class="field">连接方式${select("kind", "连接方式", d.kind, ["直接连接", "SSH 入口"])}</label>${d.kind === "SSH 入口" ? `<label class="field">Backend 访问入口${select("tunnelEndpointId", "Backend 访问入口", d.tunnelEndpointId, [["", "选择入口"], ...hosts().flatMap((h) => h.endpoints.map((e) => [e.id, `${h.name} · ${e.remotePort}`]))])}</label>` : field("endpoint", "Backend 地址", d.endpoint, "url")}</div>${s.detail !== "new" ? b("删除连接", "delete-connection", "danger") : ""}`
      );
    }
    return (
      tabs +
      `<div class="section-heading"><h2>已保存的连接</h2>${b("添加连接", "new-connection", "primary")}</div>` +
      card(
        s.connections
          .map((c) =>
            row(
              c.name,
              `${c.isSystem ? "系统管理" : c.statusMessage || "直接连接"} · ${c.endpoint || "通道尚未建立"}`,
              `<div class="actions"><span class="badge">${c.online ? "可连接" : "离线"}</span>${c.isSystem ? (!c.online ? control("重新连接", "system-reconnect", c.id) : "") : c.canEdit === false ? control("管理 SSH 主机", "show-host", c.hostId || "") + control("移除连接", "remove-saved", c.id) : control("编辑", "edit-connection", c.id)}</div>`,
            ),
          )
          .join(""),
      )
    );
  }
  function hostList() {
    return (
      `<div class="section-heading"><h2>SSH 主机</h2>${b("添加 SSH 主机", "new-host", "primary")}</div><p class="muted small">切换连接或关闭页面不会停止通道。退出桌面端后停止。</p>` +
      (hosts().length
        ? hosts()
            .map((h) =>
              section(
                h.name,
                card(
                  row(
                    h.sshTarget,
                    labels[h.status],
                    `<div class="actions">${control(["ready", "connecting", "reconnecting"].includes(h.status) ? "断开" : "连接", "host-connect", h.id)}${control("编辑主机", "edit-host", h.id)}${control("删除主机", "remove-host", h.id)}</div>`,
                  ) +
                    (h.error
                      ? `<p role="alert" class="inline-error">${esc(h.error)}</p>`
                      : "") +
                    `<details><summary>开发服务端口 · ${h.forwards.length}</summary>${h.forwards.map((p) => row(p.name, `${p.port} → ${p.port} ${p.path} · ${!p.enabled ? "已关闭" : labels[p.status || (h.status === "ready" ? "ready" : "waiting")]}`, p.status === "failed" ? control("重试端口", "retry-forward", h.id, false).replace("data-id=", `data-port="${p.id}" data-id=`) : control("打开网页", "open-forward", h.id, h.status !== "ready" || !p.enabled).replace("data-id=", `data-port="${p.id}" data-id=`))).join("") || '<p class="muted">暂无端口</p>'}</details>` +
                    ["remoteAccess", "remoteDesktop"]
                      .map((key) => {
                        const r = h[key];
                        return row(
                          key === "remoteAccess"
                            ? "远程访问本机"
                            : "RemoteDesk",
                          !r.enabled
                            ? "未启用"
                            : `${r.listenAddress}:${r.port} · ${h.status === "ready" ? "入口已验证" : "等待主机连接"}`,
                          r.enabled
                            ? `<div class="actions">${control("复制地址", "copy-relay", h.id, h.status !== "ready").replace("data-id=", `data-kind="${key}" data-id=`)}${control("重新检测", "retry-host", h.id)}</div>`
                            : "",
                        );
                      })
                      .join("") +
                    `<details><summary>Backend 访问入口</summary>${h.endpoints.map((e) => `<p class="muted small">远端端口 ${e.remotePort}</p>`).join("") || '<p class="muted">暂无入口</p>'}</details>`,
                ),
              ),
            )
            .join("")
        : '<div class="empty">暂无 SSH 主机</div>')
    );
  }
  function editor() {
    const d = s.draft;
    return (
      b("返回 SSH 主机", "host-list", "ghost") +
      `<div class="card form-grid">${field("name", "主机名称", d.name)}${field("sshTarget", "SSH 主机或配置别名", d.sshTarget)}<p class="muted small">沿用本机 SSH 配置与密钥。</p>${row("启动桌面端时自动连接", "", toggle("autoConnect", "启动桌面端时自动连接", d.autoConnect))}</div>` +
      section(
        "开发服务端口",
        card(
          d.forwards
            .map(
              (p, i) =>
                `<fieldset class="nested-form"><legend>端口 ${i + 1}</legend>${field(`forward:${p.id}:name`, "服务名称", p.name)}${field(`forward:${p.id}:port`, "端口（本地与远端相同）", p.port, "number")}${field(`forward:${p.id}:path`, "访问路径", p.path)}${row("启用转发", "", toggle(`forward:${p.id}:enabled`, "启用转发", p.enabled))}${control("移除端口", "remove-forward", p.id)}</fieldset>`,
            )
            .join("") + b("添加端口", "add-forward", "ghost"),
        ),
      ) +
      ["remoteAccess", "remoteDesktop"]
        .map((key) =>
          section(
            key === "remoteAccess" ? "远程访问本机" : "RemoteDesk",
            card(
              row(
                key === "remoteAccess"
                  ? "启用远程访问本机"
                  : "通过此主机远控本机 Mac",
                "",
                toggle(
                  `host:${key}:enabled`,
                  key === "remoteAccess"
                    ? "启用远程访问本机"
                    : "启用 RemoteDesk",
                  d[key].enabled,
                ),
              ) +
                (d[key].enabled
                  ? `<div class="form-grid">${field(`host:${key}:listenAddress`, key === "remoteAccess" ? "中转服务器 IPv4" : "RemoteDesk 中转 IPv4", d[key].listenAddress)}${field(`host:${key}:port`, key === "remoteAccess" ? "手机访问端口" : "手机远控端口", d[key].port, "number")}${key === "remoteDesktop" ? `<p class="muted small">手机配对和控制权限仍由 RemoteDesk 管理。</p><p role="status">${detected ? `已自动获取：${esc(d[key].localAddress)}:${d[key].localPort}` : "尚未读取本机 RemoteDesk 信息"}</p>${d[key].certificateFingerprint ? `<details><summary>查看证书指纹</summary><code class="break-all">${esc(d[key].certificateFingerprint)}</code></details>` : ""}${b("重新获取", "detect-remotedesk")}` : ""}</div>`
                  : ""),
            ),
          ),
        )
        .join("") +
      section(
        "Backend 访问入口",
        card(
          d.endpoints
            .map(
              (e) =>
                `<div class="nested-form">${field(`endpoint:${e.id}`, "远端 Backend 端口", e.remotePort, "number")}${control("移除入口", "remove-endpoint", e.id)}</div>`,
            )
            .join("") + b("添加 Backend 入口", "add-endpoint", "ghost"),
        ),
      )
    );
  }
  function setField(key, value) {
    if (s.page !== "connections") return false;
    const d = s.draft;
    if (!d) return false;
    if (key.startsWith("forward:")) {
      const [, id, k] = key.split(":");
      d.forwards.find((p) => p.id === id)[k] = value;
    } else if (key.startsWith("host:")) {
      const [, part, k] = key.split(":");
      d[part][k] = value;
      if (part === "remoteDesktop" && k === "enabled") detected = false;
    } else if (key.startsWith("endpoint:"))
      d.endpoints.find((e) => e.id === key.slice(9)).remotePort = value;
    else d[key] = value;
    s.dirty = true;
    s.error = "";
    if (key === "kind" || key.endsWith(":enabled")) {
      ui.render();
      if (key === "host:remoteDesktop:enabled" && value) detect();
    } else ui.updateSavebar();
    return true;
  }
  const validPort = (v) =>
    Number.isInteger(Number(v)) && Number(v) > 0 && Number(v) <= 65535;
  const privateIp = (v) =>
    /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(v) &&
    v.split(".").length === 4 &&
    v
      .split(".")
      .every((n) => /^(0|[1-9][0-9]{0,2})$/.test(n) && Number(n) <= 255);
  function validate() {
    const d = s.draft;
    if (!d.name.trim() || d.name.length > 120)
      return "请填写 1–120 个字符的名称。";
    if (s.tab !== "hosts") {
      if (d.kind === "SSH 入口")
        return hosts().some((h) =>
          h.endpoints.some((e) => e.id === d.tunnelEndpointId),
        )
          ? ""
          : "请选择有效的 Backend 入口。";
      try {
        if (!["http:", "https:"].includes(new URL(d.endpoint).protocol))
          throw Error();
      } catch {
        return "请填写有效的 HTTP 或 HTTPS 地址。";
      }
      return "";
    }
    if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.@-]{0,254}$/.test(d.sshTarget))
      return "请输入 user@host 或 SSH 配置别名。";
    if (d.forwards.length > 64) return "每台主机最多配置 64 个转发端口。";
    if (hosts().filter((h) => h.id !== d.id).length >= 64)
      return "最多配置 64 台 SSH 主机。";
    if (
      hosts()
        .filter((h) => h.id !== d.id)
        .reduce((n, h) => n + h.endpoints.length, 0) +
        d.endpoints.length >
      128
    )
      return "最多配置 128 个 Backend 入口。";
    if (
      d.forwards.some(
        (p) =>
          !p.name.trim() ||
          p.name.length > 120 ||
          !validPort(p.port) ||
          !p.path.startsWith("/") ||
          p.path.startsWith("//") ||
          p.path.includes("\\") ||
          p.path.length > 2048,
      )
    )
      return "端口需要名称、1–65535 的整数端口和以 / 开头的访问路径。";
    if (
      new Set(d.forwards.map((p) => Number(p.port))).size !== d.forwards.length
    )
      return "同一主机的开发服务端口不能重复。";
    for (const key of ["remoteAccess", "remoteDesktop"]) {
      const r = d[key];
      if (
        r.enabled &&
        (!privateIp(r.listenAddress) ||
          !validPort(r.port) ||
          Number(r.port) < 1024)
      )
        return "中转需要内网 IPv4 地址和 1024–65535 的端口。";
    }
    if (d.remoteDesktop.enabled && !detected)
      return "请先启动本机 RemoteDesk 并完成自动获取。";
    if (
      d.remoteDesktop.enabled &&
      d.remoteAccess.enabled &&
      d.remoteDesktop.listenAddress === d.remoteAccess.listenAddress &&
      Number(d.remoteDesktop.port) === Number(d.remoteAccess.port)
    )
      return "RemoteDesk 与远程访问不能共用同一中转端口。";
    if (d.endpoints.some((e) => !validPort(e.remotePort)))
      return "Backend 入口需要有效端口。";
    return "";
  }
  function detect() {
    ui.run(async () => {
      await ui.delay();
      if (ui.fault("remotedesk-fingerprint"))
        throw Error(
          "本机 RemoteDesk 身份与原配置不符，请核对 Mac 并重新配对。",
        );
      if (ui.fault("remotedesk-unavailable"))
        throw Error("请启动本机 RemoteDesk 共享服务后重试。");
      if (!s.draft?.remoteDesktop?.enabled) return;
      if (
        s.draft.remoteDesktop.certificateFingerprint &&
        s.draft.remoteDesktop.certificateFingerprint.toLowerCase() !==
          f.remoteDesktopIdentity.certificateFingerprint
      )
        throw Error(
          "本机 RemoteDesk 身份与原配置不符，请核对 Mac 并重新配对。",
        );
      Object.assign(s.draft.remoteDesktop, f.remoteDesktopIdentity);
      detected = true;
    });
  }
  function save() {
    if (s.page !== "connections") return false;
    const error = validate();
    if (error) {
      s.error = error;
      ui.render();
      return true;
    }
    ui.run(async () => {
      await ui.delay();
      if (ui.fault("ssh-save")) throw Error("无法保存配置，当前输入已保留。");
      if (s.tab === "hosts") {
        if (ui.fault("ssh-conflict")) {
          s.tunnelRevision++;
          throw Error(
            "配置已被其他操作修改，当前输入已保留。请重新读取后核对。",
          );
        }
        if (s.hostRevision !== s.tunnelRevision)
          throw Error("保存版本冲突，请重新读取主机配置。");
        if (
          s.draft.remoteDesktop.enabled &&
          ui.fault("remotedesk-changed-before-save")
        )
          throw Error("本机 RemoteDesk 身份已改变，请核对并重新配对。");
        const value = structuredClone(s.draft);
        value.name = value.name.trim();
        for (const key of ["remoteAccess", "remoteDesktop"])
          value[key].port = Number(value[key].port);
        value.forwards.forEach((p) => (p.port = Number(p.port)));
        value.endpoints.forEach((e) => (e.remotePort = Number(e.remotePort)));
        const old = hosts().find((h) => h.id === value.id);
        if (old) Object.assign(old, value);
        else hosts().push(value);
        s.tunnelRevision++;
        sync();
      } else {
        let c = s.connections.find((c) => c.id === s.detail);
        if (!c) {
          c = {
            id: crypto.randomUUID(),
            online: true,
            ...structuredClone(s.draft),
          };
          s.connections.push(c);
          s.computer[c.id] = structuredClone(f.computer.local);
        } else Object.assign(c, s.draft);
        if (c.kind === "SSH 入口") {
          c.canEdit = false;
          sync();
        }
      }
      s.dirty = false;
      s.detail = null;
      history.replaceState({}, "", "#/connections");
      prepare();
      ui.notify("配置已保存");
    });
    return true;
  }
  function action(name, el) {
    const id = el.dataset.id,
      h = hosts().find((h) => h.id === id);
    if (name === "new-connection" || name === "edit-connection") {
      ui.navigate("connections", {
        tab: "saved",
        detail: name === "new-connection" ? "new" : id,
      });
      return true;
    }
    if (name === "connection-list") {
      ui.navigate("connections", { tab: "saved" });
      return true;
    }
    if (name === "new-host" || name === "edit-host") {
      ui.guard(() => {
        s.hostId = id;
        s.tab = "hosts";
        s.detail = name === "new-host" ? "new" : id;
        ui.prepare();
        ui.render();
        if (s.draft.remoteDesktop.enabled) detect();
      });
      return true;
    }
    if (name === "show-host" || name === "host-list") {
      ui.navigate("connections", { tab: "hosts" });
      return true;
    }
    if (name === "system-reconnect") {
      ui.run(async () => {
        await ui.delay();
        if (ui.fault("system-reconnect"))
          throw Error("内置后端启动失败，请重试。");
        s.connections.find((c) => c.id === id).online = true;
      });
      return true;
    }
    if (name === "host-connect" || name === "retry-host") {
      const disconnect =
        name === "host-connect" &&
        ["ready", "connecting", "reconnecting"].includes(h.status);
      h.status = disconnect ? "disconnected" : "connecting";
      h.error = "";
      sync();
      ui.run(async () => {
        await ui.delay();
        if (!disconnect) {
          if (ui.fault("ssh-connect")) {
            h.status = "failed";
            h.error = "SSH 连接失败，请检查配置别名和密钥。";
          } else {
            h.status = "ready";
            h.forwards.forEach(
              (p) => (p.status = p.enabled ? "ready" : "disabled"),
            );
          }
        }
        sync();
      });
      return true;
    }
    if (name === "retry-forward") {
      ui.run(async () => {
        await ui.delay();
        h.forwards.find((p) => p.id === el.dataset.port).status = "ready";
      });
      return true;
    }
    if (name === "open-forward") {
      const p = h.forwards.find((p) => p.id === el.dataset.port);
      ui.openBrowser(
        `http://127.0.0.1:${p.port}${p.path}`,
        h.browser.profileId,
      );
      return true;
    }
    if (name === "copy-relay") {
      const r = h[el.dataset.kind];
      ui.copy(
        `${el.dataset.kind === "remoteAccess" ? "http://" : ""}${r.listenAddress}:${r.port}`,
      );
      return true;
    }
    if (name === "remove-host") {
      ui.confirm(
        "删除这台 SSH 主机？",
        "将停止该主机通道并移除引用的访问入口，不会终止远端任务。",
        () => {
          s.hosts = s.hosts.filter((h) => h.id !== id);
          s.tunnelRevision++;
          sync();
          ui.render();
        },
        "删除主机",
      );
      return true;
    }
    if (name === "remove-saved") {
      ui.confirm(
        "移除连接？",
        "仅移除本台保存的连接定义。",
        () => {
          s.connections = s.connections.filter((c) => c.id !== id);
          if (s.target === id) s.target = "local";
          ui.render();
        },
        "移除连接",
      );
      return true;
    }
    if (name === "add-forward") {
      s.draft.forwards.push({
        id: crypto.randomUUID(),
        name: "开发服务",
        port: 3000,
        path: "/",
        enabled: true,
      });
      s.dirty = true;
      ui.render();
      return true;
    }
    if (name === "remove-forward") {
      s.draft.forwards = s.draft.forwards.filter((p) => p.id !== id);
      s.dirty = true;
      ui.render();
      return true;
    }
    if (name === "add-endpoint") {
      s.draft.endpoints.push({ id: crypto.randomUUID(), remotePort: 5001 });
      s.dirty = true;
      ui.render();
      return true;
    }
    if (name === "remove-endpoint") {
      s.draft.endpoints = s.draft.endpoints.filter((e) => e.id !== id);
      s.dirty = true;
      ui.render();
      return true;
    }
    if (name === "detect-remotedesk") {
      detect();
      return true;
    }
    if (name === "reload-host") {
      ui.guard(() => {
        ui.prepare();
        ui.render();
        if (s.draft.remoteDesktop.enabled) detect();
      });
      return true;
    }
    return false;
  }
  return {
    init,
    render,
    prepare,
    setField,
    save,
    action,
    canSave: () =>
      s.tab !== "hosts" ||
      !s.detail ||
      !s.draft.remoteDesktop.enabled ||
      detected,
    editorActions: () =>
      s.tab === "hosts" && s.detail
        ? b("重新读取主机配置", "reload-host", "ghost")
        : "",
  };
}
