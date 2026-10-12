export function createSettingsBehavior(ui) {
  const {
    state: s,
    fixture: f,
    esc,
    button: b,
    field,
    row,
    section,
    card,
    select,
    toggle,
  } = ui;
  const preferencesKey = "runweave-prototype-settings-v4";
  function persist() {
    localStorage.setItem(
      preferencesKey,
      JSON.stringify({
        theme: s.theme,
        tools: s.tools,
        visibleTools: s.visibleTools,
        notifications: s.notifications,
      }),
    );
  }
  function init() {
    s.modelCatalog = structuredClone(f.modelCatalog);
    s.modelSearch = "";
    s.catalogError = ui.params.get("models") === "error";
    s.configDiskError = ui.params.get("config") === "disk-error";
    s.configInstanceChanged = false;
    s.configConflict = false;
    s.loginDraft = { username: "", password: "" };
    s.accountStatus = {};
    s.accountErrors = {};
    if (ui.params.get("reset") === "1") localStorage.removeItem(preferencesKey);
    try {
      const saved = JSON.parse(localStorage.getItem(preferencesKey) || "null");
      if (saved) {
        for (const key of ["theme", "tools", "visibleTools", "notifications"])
          if (saved[key] !== undefined) s[key] = saved[key];
      }
    } catch {}
    if (ui.params.get("models") === "unavailable")
      s.modelCatalog.Traex.available = false;
    if (ui.params.get("models") === "missing")
      s.computer.local.roles["实现"].model = "removed-model";
    if (ui.params.get("auth") === "expired") s.reauth.local = true;
    if (ui.params.get("account") === "restoring") {
      s.accountStatus.production = "restoring";
      setTimeout(() => {
        s.accountStatus.production = "";
        if (ui.fault("account-restore"))
          s.accountErrors.production = "暂时无法连接，账户和草稿已保留。";
        ui.render();
      }, 900);
    }
    addEventListener("storage", (e) => {
      if (e.key !== preferencesKey) return;
      try {
        const saved = JSON.parse(e.newValue);
        if (!saved) return;
        Object.assign(s, saved);
        ui.applyTheme();
        if (!s.dirty && s.page === "notifications") ui.prepare();
        ui.render();
      } catch {}
    });
  }
  function notificationView() {
    const unavailable = !ui.desktopAvailable(),
      denied = ui.params.get("notification") === "denied";
    return section(
      "系统通知",
      card(
        row(
          "Mac 系统通知",
          "后台资源监控与资源提醒由所选电脑管理。",
          toggle("enabled", "Mac 系统通知", s.draft.enabled, unavailable),
        ) +
          row(
            "系统权限",
            unavailable
              ? "普通 Web 使用应用内提醒。"
              : denied
                ? "请在 macOS 中允许 Runweave 发送通知。"
                : "已允许 Runweave 发送通知。",
            `<span class="badge">${unavailable ? "当前环境不支持" : denied ? "未允许" : "已允许"}</span>`,
          ),
      ),
    );
  }
  function loginView() {
    return `<div class="note">登录已过期，请重新登录 ${esc(ui.target().name)}。</div><div class="card form-grid">${field("auth-username", "登录用户名", s.loginDraft.username)}${field("auth-password", "登录密码", s.loginDraft.password, "password")}${b("登录", "auth-login", "primary", ui.offline() ? "disabled" : "")}</div>`;
  }
  function accountBanner() {
    const status = s.accountStatus[s.environment],
      error = s.accountErrors[s.environment];
    return status
      ? '<p role="status" class="note">正在恢复已保存的账户…</p>'
      : error
        ? `<div class="note" role="alert">${esc(error)}${b("重试连接", "retry-account")}${b("修改账户配置", "edit-account", "ghost")}</div>`
        : "";
  }
  function modelView() {
    const roles = s.draft.roles,
      r = roles[s.role],
      catalog = s.modelCatalog[r.provider],
      model = catalog.models.find((m) => m.id === r.model);
    return (
      `<div class="section-heading"><h2>新运行的默认角色配置</h2>${b("重新读取模型目录", "reload-models", "ghost")}</div>` +
      (s.catalogError
        ? '<p role="alert" class="inline-error">模型目录读取失败，已有角色配置仍保留。</p>'
        : "") +
      `<div class="tabs">${Object.keys(roles)
        .map(
          (role) =>
            `<button data-role="${role}" class="${role === s.role ? "active" : ""}">${esc(role)}</button>`,
        )
        .join("")}</div>` +
      card(
        row(
          "CLI",
          `${catalog.command} · ${catalog.available ? "可用" : "当前不可用"}`,
          select(
            "role.provider",
            "CLI",
            r.provider,
            Object.keys(s.modelCatalog),
          ).replace(
            /<option value="Traex"/,
            `<option ${s.modelCatalog.Traex.available ? "" : "disabled"} value="Traex"`,
          ),
        ) +
          `<div class="model-list padded"><label class="field">搜索模型<input data-field="model-search" aria-label="搜索模型" value="${esc(s.modelSearch)}" placeholder="搜索并显式选择模型"></label><div class="model-options">${
            !s.catalogError && catalog.available
              ? catalog.models
                  .filter((m) =>
                    m.id.toLowerCase().includes(s.modelSearch.toLowerCase()),
                  )
                  .map((m) =>
                    b(
                      m.id,
                      "pick-model",
                      r.model === m.id ? "primary" : "ghost",
                      `data-id="${esc(m.id)}"`,
                    ),
                  )
                  .join("") || '<p class="empty">没有匹配的模型</p>'
              : '<p class="empty">模型目录暂不可用</p>'
          }</div>${!model ? `<p role="alert">当前配置：${esc(r.model || "尚未选择")}，请选择可用模型。</p>` : ""}</div>` +
          row(
            "推理强度",
            "仅展示当前模型支持的档位",
            model?.efforts.length
              ? select("role.effort", "推理强度", r.effort, [
                  ["", "不显式指定"],
                  ...model.efforts,
                ])
              : '<span class="muted">此模型不提供可配置档位</span>',
          ) +
          `<details class="diagnostic-detail"><summary>高级参数</summary>${row(r.provider === "Codex" ? "Fast" : "Max", "显式覆盖当前角色的配置", toggle(r.provider === "Codex" ? "role.fast" : "role.max", r.provider === "Codex" ? "Fast" : "Max", r.provider === "Codex" ? r.fast : r.max, !model || (r.provider === "Codex" ? !model.supportsFast : !model.supportsMax)))}</details>`,
      ) +
      `<p class="muted small">保存全部角色默认值。已创建的运行继续使用原有快照。</p>`
    );
  }
  function modelError() {
    if (s.catalogError) return "模型目录尚未加载，请重试。";
    for (const [role, r] of Object.entries(s.draft.roles)) {
      const catalog = s.modelCatalog[r.provider],
        m = catalog.models.find((m) => m.id === r.model);
      if (!catalog.available || !m) return role + "需要显式选择可用模型。";
      if (r.effort && !m.efforts.includes(r.effort))
        return role + "的推理强度不受当前模型支持。";
      if (
        (r.provider === "Codex" && r.fast && !m.supportsFast) ||
        (r.provider === "Traex" && r.max && !m.supportsMax)
      )
        return role + "的高级参数不受当前模型支持。";
    }
    return "";
  }
  function fieldStatus(f) {
    const value = ui.config().fields[f.path],
      mode =
        ui.params.get("config") ||
        (s.pending[s.target] ? "pending" : "applied");
    let saved = f.sensitive
      ? ui.config().secrets[f.path]
        ? "已配置（内容隐藏）"
        : "未配置"
      : value === null
        ? "rule" in f.default
          ? "由功能模块决定"
          : "默认值：" + JSON.stringify(f.default.value)
        : JSON.stringify(value);
    const label =
      {
        pending:
          f.apply === "restart"
            ? "已保存，等待所属服务重启"
            : "已保存，等待所属功能重新加载",
        invalid: "配置或应用失败",
        unknown: "尚未确认所属服务是否采用",
        applied: "当前进程已采用",
      }[mode] || "尚未确认所属服务是否采用";
    return `<details class="field-details"><summary>配置来源与应用状态</summary><p>${label}</p><p>已保存配置的取值：${esc(saved)}</p><p>当前进程采用值：${mode === "applied" ? esc(saved) + " · 生效版本 " + (s.revisions[s.target] || 1) : "尚未确认"}</p>${f.default.rule ? `<p>${esc(f.default.rule)}</p>` : f.sensitive ? "" : `<p>默认值：${esc(JSON.stringify(f.default.value))}</p>`}${s.dirty ? "<p>有未保存的修改；以上为上次读取的结果。</p>" : ""}${!f.sensitive ? `<p>${f.type === "boolean" ? "填写 true 或 false" : f.type.startsWith("array") ? "填写 JSON 字符串数组" : ""} · 留空恢复默认值</p>` : ""}</details>`;
  }
  function configBanner() {
    return `${s.configDiskError ? '<p role="alert" class="note">磁盘配置无法读取，请在当前电脑运行 rw config doctor。</p>' : ""}${s.configInstanceChanged ? '<p role="alert" class="note">连接实例已变化，请重新读取配置并核对目标电脑。</p>' : ""}${s.configConflict ? '<p role="alert" class="note">版本或文件摘要已变化，未覆盖配置；当前输入已保留。请重新读取后核对。</p>' : ""}`;
  }
  function beforeSave() {
    if (s.commitReady) {
      s.commitReady = false;
      return false;
    }
    ui.run(async () => {
      await ui.delay();
      if (s.page === "access") {
        if (ui.fault("password-401")) {
          s.reauth[s.target] = true;
          s.dirty = false;
          s.loginDraft = { username: "", password: "" };
          throw Error("登录已过期，请重新登录。");
        }
        if (ui.fault("password-403")) throw Error("当前密码不正确。");
      }
      if (s.page === "monitoring" && ui.fault("monitor-partial")) {
        Object.assign(ui.config(), {
          monitor: s.draft.monitor,
          alerts: s.draft.alerts,
        });
        throw Error(
          "监控设置已保存，但远程权限保存失败。当前授权保持原值，请重试。",
        );
      }
      if (s.page === "notifications" && ui.fault("notification-denied"))
        throw Error("系统通知授权失败，请在 macOS 设置中检查权限。");
      if (s.page === "advanced" && s.tab !== "models") {
        if (s.configDiskError) throw Error("磁盘配置不可读取，未保存。");
        if (ui.fault("config-conflict")) s.configConflict = true;
        if (s.configConflict)
          throw Error("保存版本或摘要冲突，当前输入已保留。");
        if (ui.fault("config-instance")) s.configInstanceChanged = true;
        if (s.configInstanceChanged)
          throw Error("连接实例已变化，未保存到新实例。");
      }
      if (ui.fault("save")) throw Error("保存失败，当前输入已保留，请重试。");
      s.commitReady = true;
      ui.commit();
      persist();
    });
    return true;
  }
  function action(name, el) {
    if (name === "auth-login") {
      ui.run(async () => {
        if (!s.loginDraft.username.trim() || !s.loginDraft.password)
          throw Error("请输入用户名和密码。");
        await ui.delay();
        if (ui.fault("login")) throw Error("用户名或密码不正确。");
        s.reauth[s.target] = false;
        s.loginDraft = { username: "", password: "" };
        ui.prepare();
      });
      return true;
    }
    if (name === "login-account" || name === "retry-account") {
      ui.run(async () => {
        if (name === "login-account") {
          const error = ui.validate();
          if (error) throw Error(error);
          if (!s.draft.username?.trim() || !s.draft.password)
            throw Error("请输入账号和密码。");
        }
        const env = s.environment;
        await ui.delay();
        if (ui.fault("account-401")) {
          s.draft.password = "";
          s.draft.loggedIn = false;
          s.accounts[env].loggedIn = false;
          throw Error("随记登录已过期，请重新登录。");
        }
        if (ui.fault("account-network")) {
          s.accountErrors[env] = "暂时无法连接，账户和草稿已保留。";
          throw Error("连接失败，请重试。");
        }
        s.accountErrors[env] = "";
        s.accounts[env] = {
          endpoint: s.draft.endpoint,
          username: s.draft.username.trim(),
          loggedIn: true,
        };
        ui.prepare();
      });
      return true;
    }
    if (name === "pick-model") {
      const r = s.draft.roles[s.role],
        m = s.modelCatalog[r.provider].models.find(
          (m) => m.id === el.dataset.id,
        );
      r.model = m.id;
      r.effort = m.efforts[0] || "";
      r.fast = false;
      r.max = false;
      s.dirty = true;
      ui.render();
      return true;
    }
    if (name === "reload-models") {
      ui.guard(() =>
        ui.run(async () => {
          await ui.delay();
          if (ui.fault("models-load")) throw Error("模型目录读取失败。");
          s.catalogError = false;
          ui.prepare();
        }),
      );
      return true;
    }
    if (name === "reload-config") {
      ui.guard(() =>
        ui.run(async () => {
          await ui.delay();
          if (ui.fault("config-load")) throw Error("无法读取配置。");
          s.configDiskError = false;
          s.configConflict = false;
          s.configInstanceChanged = false;
          ui.prepare();
        }),
      );
      return true;
    }
    return false;
  }
  function setField(key, value) {
    if (key === "model-search") {
      s.modelSearch = value;
      ui.render();
      return true;
    }
    if (key.startsWith("auth-")) {
      s.loginDraft[key.slice(5)] = value;
      return true;
    }
    if (key === "role.provider") {
      const r = s.draft.roles[s.role];
      r.provider = value;
      r.model = "";
      r.effort = "";
      r.fast = false;
      r.max = false;
      s.dirty = true;
      s.modelSearch = "";
      ui.render();
      return true;
    }
    return false;
  }
  return {
    init,
    persist,
    notificationView,
    loginView,
    accountBanner,
    modelView,
    modelError,
    fieldStatus,
    configBanner,
    beforeSave,
    action,
    setField,
  };
}
