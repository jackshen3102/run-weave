export function createMobile(ui) {
  const { state: s, fixture: f, esc, button: b, card, field, select } = ui;
  let generation = 0,
    tick,
    timers = [];
  const labels = {
    waiting_scan: "请在 iOS App 的连接管理中点击「扫码连接电脑」",
    pending_approval: "等待你确认这台手机",
    approved: "正在完成手机登录",
    issuing: "正在签发登录凭据",
    issued: "等待手机完成确认",
    completed: "手机已登录",
    cancelled: "已取消",
    rejected: "已拒绝手机登录",
    expired: "二维码已过期，请重新生成",
    unconfirmed: "未收到手机完成确认；已保存的手机登录仍可使用",
    failed: "登录凭据签发失败，请重新扫码",
  };
  const locked = (m) =>
    m && ["approved", "issuing", "issued"].includes(m.status);
  const current = () => s.mobile[s.target];
  function init() {
    s.mobile = {};
  }
  function stop() {
    generation++;
    clearInterval(tick);
    timers.forEach(clearTimeout);
    timers = [];
  }
  function cancel() {
    const m = current();
    if (
      m &&
      !["completed", "rejected", "expired", "failed", "unconfirmed"].includes(
        m.status,
      )
    )
      m.status = "cancelled";
    stop();
  }
  function later(callback, delay, epoch = generation) {
    timers.push(
      setTimeout(() => {
        if (epoch === generation) callback();
      }, delay),
    );
  }
  function addresses() {
    return s.target === "local"
      ? f.mobileAddresses
      : [ui.target().endpoint].filter(
          (v) => v && !/^https?:\/\/(127\.|localhost)/.test(v),
        );
  }
  function generate(address) {
    stop();
    const epoch = generation,
      target = s.target;
    const m = {
      id: crypto.randomUUID(),
      status: "",
      address: address || addresses()[0] || "",
      expiresAt: Date.now() + 120000,
      error: "",
      busy: true,
      deviceName: "iPhone",
      target,
    };
    s.mobile[target] = m;
    ui.render();
    later(
      () => {
        m.busy = false;
        if (ui.fault("mobile-address") || !m.address) {
          m.error = "未找到手机可访问的地址，请检查网络或使用手动登录。";
          ui.render();
          return;
        }
        if (ui.fault("mobile-create")) {
          m.error = "连接暂时失败，请重试。";
          ui.render();
          return;
        }
        m.status = "waiting_scan";
        if (ui.fault("mobile-qr"))
          m.error =
            "地址过长，无法显示二维码。请使用较短的连接地址或手动登录。";
        ui.render();
        tick = setInterval(() => {
          if (epoch !== generation) return;
          const remaining = Math.max(
            0,
            Math.ceil((m.expiresAt - Date.now()) / 1000),
          );
          const span = document.querySelector("[data-mobile-seconds]");
          if (span) span.textContent = remaining;
          if (!remaining && m.status === "waiting_scan") {
            m.status = "expired";
            clearInterval(tick);
            ui.render();
          }
        }, 1000);
        if (ui.params.get("mobile") !== "waiting_scan" && !m.error)
          later(() => {
            if (m.status === "waiting_scan") {
              m.status = "pending_approval";
              ui.render();
            }
          }, f.mobileScanDelayMs);
      },
      400,
      epoch,
    );
  }
  function enter() {
    if (current()) return;
    const preset = ui.params.get("mobile");
    if (preset && labels[preset]) {
      s.mobile[s.target] = {
        id: crypto.randomUUID(),
        status: preset,
        address: addresses()[0] || "",
        expiresAt: Date.now() + 120000,
        error: "",
        busy: false,
        deviceName: "iPhone",
        target: s.target,
      };
      if (preset === "waiting_scan") generate();
    }
  }
  function render() {
    enter();
    const m = current();
    const offline = ui.offline();
    const isLocked = locked(m);
    return card(
      `<div class="mobile-form"><h2>连接手机 · ${esc(ui.target().name)}</h2><p class="muted">手机需能访问此电脑。扫码后，由你在这里确认登录。</p>${addresses().length ? `<label class="field">连接地址${select("mobile-address", "手机连接地址", m?.address || addresses()[0], addresses()).replace("<select ", `<select ${m?.busy || isLocked || offline ? "disabled" : ""} `)}</label>` : ""}<div class="mobile-status" aria-live="polite" data-mobile-state="${m?.status || "idle"}">${m?.busy ? '<p role="status">正在准备连接…</p>' : ""}${m?.status === "waiting_scan" && !m.error ? `<img class="qr-image" src="./mobile-login-qr.svg" width="280" height="280" alt="用 Runweave iOS 扫描登录二维码"><p class="muted">剩余 <span data-mobile-seconds>${Math.max(0, Math.ceil((m.expiresAt - Date.now()) / 1000))}</span> 秒</p>` : ""}${m?.status ? `<p>${esc(labels[m.status])}</p>` : "<p>生成此电脑的手机登录二维码。</p>"}${m?.status === "pending_approval" ? `<strong>${esc(m.deviceName)} 请求登录</strong><div class="actions">${b("允许登录", "mobile-approve", "primary", m.busy || m.error || offline ? "disabled" : "")}${b("拒绝", "mobile-reject", "", m.busy || m.error || offline ? "disabled" : "")}</div>` : ""}${m?.error ? `<p role="alert" class="inline-error">${esc(m.error)}</p>` : ""}</div><div class="actions">${!isLocked && m?.status !== "completed" ? b(m ? "重新生成二维码" : "生成二维码", "mobile-generate", "primary", m?.busy || offline ? "disabled" : "") : ""}${m ? b(m.status === "completed" ? "完成" : "取消接入", "mobile-cancel", "ghost") : ""}</div><p class="muted small">也可以在手机连接管理中手动填写地址，使用原有账号密码登录。</p></div>`,
    );
  }
  function decide(approve) {
    const m = current();
    if (
      !m ||
      m.status !== "pending_approval" ||
      m.busy ||
      m.error ||
      ui.offline()
    )
      return;
    m.busy = true;
    ui.render();
    const epoch = generation;
    later(
      () => {
        m.busy = false;
        if (!approve) {
          m.status = "rejected";
          ui.render();
          return;
        }
        if (ui.fault("mobile-decision")) {
          m.error = "连接暂时失败，正在核对电脑端状态。";
          ui.render();
          later(() => {
            m.error = "";
            m.status = "issued";
            ui.render();
            finish(m);
          }, 800);
          return;
        }
        m.status = "approved";
        ui.render();
        later(() => {
          m.status = "issuing";
          ui.render();
          later(() => {
            m.status = ui.fault("mobile-issue") ? "failed" : "issued";
            ui.render();
            if (m.status === "issued") finish(m);
          }, 650);
        }, 650);
      },
      500,
      epoch,
    );
  }
  function finish(m) {
    later(() => {
      m.status = ui.fault("mobile-unconfirmed") ? "unconfirmed" : "completed";
      ui.render();
    }, 1100);
  }
  function setField(key, value) {
    if (key !== "mobile-address") return false;
    if (!locked(current()) && !current()?.busy && !ui.offline())
      generate(value);
    return true;
  }
  function action(name) {
    if (name === "mobile-generate") {
      if (!ui.offline()) generate(current()?.address);
      return true;
    }
    if (name === "mobile-cancel") {
      cancel();
      ui.render();
      return true;
    }
    if (name === "mobile-approve" || name === "mobile-reject") {
      decide(name === "mobile-approve");
      return true;
    }
    return false;
  }
  return {
    init,
    render,
    action,
    setField,
    cancel,
    locked: () => locked(current()),
  };
}
