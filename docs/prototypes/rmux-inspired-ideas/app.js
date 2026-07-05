/* global document, fetch, window */

import React, { useMemo, useState } from "https://esm.sh/react@18.3.1";
import { createRoot } from "https://esm.sh/react-dom@18.3.1/client";
import htm from "https://esm.sh/htm@3.1.1";

const html = htm.bind(React.createElement);

// React needs `style` as an object; parse inline CSS strings into style objects
// so the prototype can keep readable CSS strings at call sites.
function css(str) {
  const out = {};
  String(str).split(";").forEach((decl) => {
    const idx = decl.indexOf(":");
    if (idx === -1) return;
    const prop = decl.slice(0, idx).trim();
    const value = decl.slice(idx + 1).trim();
    if (!prop) return;
    out[prop.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
  });
  return out;
}

// 4 borrowable ideas. Each maps a real RMUX capability onto Runweave's
// multi-backend / tmux-native / agent-team model.
const IDEAS = [
  {
    id: "share",
    title: "Web Share 分享",
    sub: "把某个终端 pane 只读/可控地分享到浏览器",
    rmux: "RMUX web-share（Operator/Spectator + E2EE）",
    why: "Runweave 现在的终端只有本人看得到。RMUX 的 web-share 把「一个正在跑 agent 的 pane」开成浏览器链接：Operator 可输入、Spectator 只读，执行始终留在本机 daemon，中转只见密文（ChaCha20-Poly1305 + X25519 + ML-KEM-768）。借鉴它给 Runweave 加一层「把这个 agent 终端甩个只读链接给同事看进度」的能力，而不用截图/录屏。",
  },
  {
    id: "verify",
    title: "行为验收脚本",
    sub: "send_text / expect_visible_text / capture_pane 组成断言链",
    rmux: "RMUX SDK（wait_for_text / assert_visible_text / snapshot）",
    why: "Runweave 的 agent-team behavior_verify 现在靠 markdown 用例 + 人肉核对。RMUX SDK 把「写入 → 等文本出现 → 抓快照 → 断言」做成 typed 原子操作（expect_visible_text().to_contain().timeout()）。借鉴它把 behavior_verify 的终端侧信号变成一条可回放、有 pass/fail 和耗时、失败带证据快照的断言链——这正是 loop-engineer 需要的客观 loop 信号。",
  },
  {
    id: "diagnose",
    title: "Backend 能力协商",
    sub: "capabilities --json / diagnose：多 backend 差异一眼看清",
    rmux: "RMUX capabilities / diagnose --json",
    why: "Runweave 是多后端（本机 Electron + 远程 SSH backend）。RMUX 让 SDK client 先 capabilities 协商再决定用哪些特性，diagnose --json 报告 build/platform/tmux/pty 支持度。借鉴它给 Runweave 加一个 backend 能力矩阵：连上一个 backend 先探能力（tmux 版本、快照、CDP proxy、SDK 协议版本），能力不足就降级并显式告警，而不是运行到一半才炸。",
  },
  {
    id: "commands",
    title: "程序化命令面板",
    sub: "typed tmux 命令 + target 句柄，可搜索、可预览、可路由",
    rmux: "RMUX 90+ typed tmux 命令面（send-keys / capture-pane / web-share …）",
    why: "Runweave 已有 tmux-native split 和 panel target bar，但操作靠记命令。RMUX 把 90+ tmux 命令做成 typed、按 pane 句柄寻址的命令面。借鉴它做一个 Cmd-K 式命令面板：搜命令、看参数签名、选中 target pane、预览将执行的完整命令再回车路由——把 split-window/send-keys/capture-pane/web-share 收进一个可发现的入口。",
  },
];

const AGENT_CLASS = { codex: "agent-codex", claude: "agent-claude", coco: "agent-coco", bash: "agent-bash" };

function useToast() {
  const [toast, setToast] = useState(null);
  const show = (msg) => {
    setToast(msg);
    window.clearTimeout(show._t);
    show._t = window.setTimeout(() => setToast(null), 2200);
  };
  return [toast, show];
}

/* ------------------------------------------------------------------ idea 1 */
function ShareView({ data, toast }) {
  const s = data.share;
  const [selId, setSelId] = useState(s.activeShare.terminalId);
  const [spectatorOnly, setSpectatorOnly] = useState(s.activeShare.spectatorOnly);
  const active = s.terminals.find((t) => t.id === selId) || s.terminals[0];
  const isShared = active.id === s.activeShare.terminalId;

  return html`
    <div class="share-grid">
      <div class="term-list">
        <div class="section-title" style=${css("margin-top:0")}>选择要分享的终端 pane</div>
        ${s.terminals.map((t) => {
          const backend = data.backends.find((b) => b.id === t.backend);
          return html`
            <div key=${t.id} class=${"term" + (t.id === selId ? " active" : "")} onClick=${() => setSelId(t.id)}>
              <div class="row between">
                <span class="mono" style=${css("font-size:11px;color:var(--cyan)")}>${t.session}</span>
                <span class=${"agent-badge " + AGENT_CLASS[t.agent]}>${t.agent}</span>
              </div>
              <div class="t-task">${t.task}</div>
              <div class="t-meta">${backend?.label} · ${t.project} · ${t.cols}×${t.rows}
                ${t.id === s.activeShare.terminalId ? html`<span class="chip green" style=${css("margin-left:6px")}>● 分享中</span>` : ""}
              </div>
            </div>`;
        })}
      </div>

      <div>
        <div class="card">
          <div class="row between wrap">
            <div class="row" style=${css("gap:10px")}>
              <span class="mono" style=${css("color:var(--cyan)")}>${active.session}</span>
              <span class="chip">${data.backends.find((b) => b.id === active.backend)?.label}</span>
            </div>
            ${isShared
              ? html`<button class="btn danger sm" onClick=${() => toast("web-share off · 已停止分享并作废所有链接")}>停止分享</button>`
              : html`<button class="btn primary sm" onClick=${() => toast(`web-share -t ${active.session} · 已生成新链接`)}>开始分享此 pane</button>`}
          </div>

          <div class="row wrap" style=${css("gap:6px;margin-top:12px")}>
            ${s.activeShare.crypto.map((c) => html`<span key=${c} class="chip violet">🔒 ${c}</span>`)}
            <span class="chip">tunnel: ${s.activeShare.tunnel}</span>
            <span class="chip">ttl ${Math.round(s.activeShare.ttlSec / 60)}min</span>
          </div>

          <div class="row" style=${css("gap:10px;margin-top:12px")}>
            <button class=${"toggle-btn btn sm " + (spectatorOnly ? "primary" : "ghost")}
              onClick=${() => { setSpectatorOnly(!spectatorOnly); toast(spectatorOnly ? "已允许 Operator 输入" : "--spectator-only · 已切为纯只读分享"); }}>
              ${spectatorOnly ? "☑ 仅只读 (--spectator-only)" : "☐ 仅只读 (--spectator-only)"}
            </button>
            <span class="dim" style=${css("font-size:11px")}>关闭后 Operator 链接才可输入</span>
          </div>
        </div>

        <div class="section-title">分享链接（按角色）</div>
        ${s.activeShare.links.map((l) => {
          const disabled = spectatorOnly && l.role === "operator";
          return html`
            <div key=${l.role} class="link-row" style=${disabled ? css("opacity:.4") : {}}>
              <span class=${"role-pill role-" + l.role}>${l.role === "operator" ? "OPERATOR 可控" : "SPECTATOR 只读"}</span>
              <span class="mono grow" style=${css("font-size:11px;color:var(--muted)")}>runweave.local/s/${s.activeShare.shareId}#t=${l.token}</span>
              <button class="btn sm ghost" disabled=${disabled} onClick=${() => toast(disabled ? "" : `已复制 ${l.role} 链接（${l.note}）`)}>复制</button>
            </div>`;
        })}

        <div class="section-title">当前观看端（${s.activeShare.viewers.length}）</div>
        <div class="card">
          ${s.activeShare.viewers.map((v) => {
            const rttClass = v.rtt < 100 ? "ok" : v.rtt < 400 ? "warn" : "bad";
            return html`
              <div key=${v.id} class="viewer">
                <span class=${"role-pill role-" + v.role}>${v.role === "operator" ? "OP" : "SP"}</span>
                <span class="grow">${v.name}</span>
                <span class=${"rtt " + rttClass}>${v.rtt}ms</span>
                ${v.state === "backpressure"
                  ? html`<span class="chip" style=${css("color:var(--danger);border-color:var(--danger)")}>4001 backpressure · 即将踢</span>`
                  : html`<span class="dim" style=${css("font-size:11px")}>since ${v.since}</span>`}
              </div>`;
          })}
        </div>

        <div class="section-title">浏览器关闭码（安全语义，避免成为 token/PIN oracle）</div>
        <div class="card">
          ${s.closeCodes.map((c) => html`
            <div key=${c.code} class="row" style=${css("gap:10px;padding:5px 0;font-size:11.5px")}>
              <span class="mono" style=${css("width:44px;color:var(--amber)")}>${c.code}</span>
              <span class="mono" style=${css("width:180px;color:var(--muted)")}>${c.reason}</span>
              <span class="dim grow">${c.desc}</span>
            </div>`)}
        </div>

        <div class="note-box">
          <b>真实映射：</b>Runweave 终端已经跑在 backend 常驻进程里（packages/shared/src/terminal-protocol.ts 的 session/ticket 模型），把 pane 的输出帧再多播一份到浏览器即可复用现有 WS 通道。
          <b>落地缺口：</b>① 分享链接的鉴权与 TTL/PIN；② Operator/Spectator 两级写权限（复用 TerminalInputMode 扩一个只读态）；③ 中转加密（现在本机 loopback 直连，公网分享才需要 E2EE + tunnel）。
        </div>
      </div>
    </div>`;
}

/* ------------------------------------------------------------------ idea 2 */
function VerifyView({ data, toast }) {
  const v = data.verify;
  const [selId, setSelId] = useState(v.steps.find((s) => s.status === "fail")?.id || v.steps[0].id);
  const sel = v.steps.find((s) => s.id === selId) || v.steps[0];
  const passCount = v.steps.filter((s) => s.status === "pass").length;
  const failCount = v.steps.filter((s) => s.status === "fail").length;

  return html`
    <div>
      <div class="row wrap between" style=${css("margin-bottom:14px")}>
        <div class="row wrap" style=${css("gap:8px")}>
          <span class="chip cyan">run ${v.runId}</span>
          <span class="chip">target <span class="mono" style=${css("margin-left:5px")}>${v.target}</span></span>
          <span class="chip green">${passCount} pass</span>
          ${failCount ? html`<span class="chip" style=${css("color:var(--danger);border-color:var(--danger)")}>${failCount} fail</span>` : ""}
        </div>
        <button class="btn primary sm" onClick=${() => toast("已重放断言链 · 结果不变（HMR 仍走整页 reload）")}>▶ 重放断言链</button>
      </div>
      <div class="dim" style=${css("font-size:11.5px;margin-bottom:14px")}>来源用例：<span class="mono">${v.useCase}</span></div>

      <div class="verify-grid">
        <div>
          ${v.steps.map((s, i) => {
            const cls = s.status === "pass" ? "st-pass" : s.status === "fail" ? "st-fail" : "st-idle";
            return html`
              <div key=${s.id} class=${"step" + (s.id === selId ? " sel" : "")} onClick=${() => setSelId(s.id)}>
                <div class=${"st-idx " + cls}>${s.status === "pass" ? "✓" : s.status === "fail" ? "✕" : i + 1}</div>
                <div class="grow">
                  <div class="row wrap" style=${css("gap:8px")}>
                    <span class="op">${s.op}</span>
                    ${s.matcher ? html`<span class="arg">.${s.matcher}(…)</span>` : ""}
                    <span class="dim" style=${css("font-size:11px")}>${s.desc}</span>
                  </div>
                  <div class="arg" style=${css("margin-top:4px")}>${s.arg}${s.timeoutMs ? `   ⟂ timeout ${s.timeoutMs}ms` : ""}</div>
                </div>
                <div class="col" style=${css("align-items:flex-end")}>
                  <span class=${s.status === "fail" ? "cap-no" : "cap-ok"} style=${css("font-size:11px;font-weight:600")}>${s.status}</span>
                  <span class="dim mono" style=${css("font-size:10.5px")}>${s.ms}ms</span>
                </div>
              </div>`;
          })}
        </div>

        <div>
          <div class="section-title" style=${css("margin-top:0")}>步骤详情 / 证据</div>
          <div class="card" style=${css("margin-bottom:12px")}>
            <div class="row between">
              <span class="op mono">${sel.op}</span>
              <span class=${sel.status === "fail" ? "cap-no" : "cap-ok"} style=${css("font-weight:600")}>${sel.status}</span>
            </div>
            <div class="muted" style=${css("font-size:11.5px;margin:8px 0")}>${sel.detail ? "" : sel.desc}</div>
            <div class="snapshot">${sel.detail || sel.desc}</div>
          </div>

          <div class="section-title">可用断言原语（typed）</div>
          ${v.palette.map((p) => html`
            <div key=${p.op} class="palette-op">
              <div class="pop">${p.op}()</div>
              <div class="phint">${p.hint}</div>
            </div>`)}
        </div>
      </div>

      <div class="note-box">
        <b>真实映射：</b>Runweave agent-team 的 behavior_verify（packages/shared/src/agent-team.ts）已产出结构化结论；把「终端侧断言」升级成这条 typed 链后，pass 数/耗时/失败快照就是 loop-engineer 的客观「无进展」信号，不用叠 LLM 判官。
        <b>落地缺口：</b>① backend 需暴露 expect_visible_text 式阻塞等待（现在是裸 PTY 输出流）；② capture_pane 快照落库以便回放；③ assert_dom 需与 $playwright-cli 桥接（browser pane 场景）。
      </div>
    </div>`;
}

/* ------------------------------------------------------------------ idea 3 */
function DiagnoseView({ data, toast }) {
  const d = data.diagnose;
  const [showRaw, setShowRaw] = useState(false);
  return html`
    <div>
      <div class="row between" style=${css("margin-bottom:14px")}>
        <span class="muted" style=${css("font-size:12px")}>连接每个 backend 前先协商能力，缺失特性显式降级 + 告警，而不是运行到一半才炸。</span>
        <button class="btn ghost sm" onClick=${() => setShowRaw(!showRaw)}>${showRaw ? "隐藏" : "查看"} diagnose --json</button>
      </div>

      ${showRaw ? html`<div class="raw-json" style=${css("margin-bottom:14px")}>${d.rawSample}</div>` : ""}

      <div class="card" style=${css("padding:0;overflow:hidden")}>
        <table class="cap-table" style=${css("width:100%;border-collapse:collapse")}>
          <thead><tr>
            <th>backend</th><th>状态</th><th>tmux</th><th>runtime</th><th>SDK 协议</th>
            <th>快照</th><th>CDP proxy</th><th>web-share</th><th>健康度</th>
          </tr></thead>
          <tbody>
            ${d.backends.map((b) => html`
              <tr key=${b.id}>
                <td><span class="mono">${b.id}</span><div class="dim" style=${css("font-size:10.5px")}>${b.label}</div></td>
                <td>${b.online
                  ? html`<span class="row" style=${css("gap:6px")}><span class="dot green"></span>online</span>`
                  : html`<span class="row" style=${css("gap:6px")}><span class="dot dim"></span><span class="dim">offline</span></span>`}</td>
                <td class="mono">${b.caps?.tmux || "—"}</td>
                <td class="mono">${b.caps?.runtime || "—"}</td>
                <td class="mono">${b.caps?.sdkProto || "—"}</td>
                <td>${b.caps ? (b.caps.captureSnapshot ? html`<span class="cap-ok">✓</span>` : html`<span class="cap-no">✕</span>`) : "—"}</td>
                <td>${b.caps ? (b.caps.cdpProxy ? html`<span class="cap-ok">✓</span>` : html`<span class="cap-no">✕</span>`) : "—"}</td>
                <td>${b.caps ? (b.caps.webShare ? html`<span class="cap-ok">✓</span>` : html`<span class="cap-no">✕</span>`) : "—"}</td>
                <td><div class="health-bar"><i style=${css(`width:${b.health}%;background:${b.health > 85 ? "var(--green)" : b.health > 40 ? "var(--amber)" : "var(--danger)"}`)}></i></div></td>
              </tr>`)}
          </tbody>
        </table>
      </div>

      <div class="section-title">协商告警 / 降级建议</div>
      <div class="grid grid-2">
        ${d.backends.filter((b) => b.warnings.length).map((b) => html`
          <div key=${b.id} class="card">
            <div class="row between">
              <span class="mono" style=${css("color:var(--cyan)")}>${b.id}</span>
              <button class="btn sm ghost" onClick=${() => toast(`已按 ${b.id} 能力自动降级本次会话`)}>按此降级</button>
            </div>
            ${b.warnings.map((w, i) => html`<div key=${i} class="warn-line"><span>⚠</span><span>${w}</span></div>`)}
          </div>`)}
      </div>

      <div class="note-box">
        <b>真实映射：</b>Runweave 已是多 backend（packages/shared/src/app-server-node.ts 的连接管理）。给每个 backend 加一次 capabilities 握手，前端就能在建终端前知道该 backend 能不能跑快照断言/CDP 代理/web-share。
        <b>落地缺口：</b>① backend 侧要吐一个 capabilities 描述（tmux 版本、node 版本、协议版本）；② 前端建终端流程按能力矩阵灰掉不支持的入口；③ 协议版本差异时的字段降级策略（如缺 locators 时 assert_dom 退化为纯文本）。
      </div>
    </div>`;
}

/* ------------------------------------------------------------------ idea 4 */
const CATS = ["all", "layout", "io", "session", "share", "sdk"];
function CommandsView({ data, toast }) {
  const c = data.commands;
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("all");
  const [selName, setSelName] = useState(c.list[0].name);
  const filtered = useMemo(() => c.list.filter((cmd) => {
    if (cat !== "all" && cmd.cat !== cat) return false;
    const s = (q || "").toLowerCase();
    return !s || cmd.name.includes(s) || cmd.desc.toLowerCase().includes(s);
  }), [q, cat]);
  const sel = c.list.find((x) => x.name === selName) || filtered[0] || c.list[0];

  return html`
    <div>
      <div class="row between wrap" style=${css("margin-bottom:4px")}>
        <span class="muted" style=${css("font-size:12px")}>Cmd-K 式面板：搜命令 → 看 typed 参数签名 → 选 target pane → 预览完整命令再路由。</span>
        <span class="chip">target <span class="mono" style=${css("margin-left:5px")}>${c.target}</span></span>
      </div>
      <input class="cmd-search" placeholder="搜索命令（split / send / capture / share …）" value=${q}
        onInput=${(e) => setQ(e.target.value)} />
      <div class="seg" style=${css("margin-bottom:14px")}>
        ${CATS.map((cc) => html`<button key=${cc} class=${cat === cc ? "active" : ""} onClick=${() => setCat(cc)}>${cc}</button>`)}
      </div>

      <div class="grid" style=${css("grid-template-columns:1fr 360px;gap:16px;align-items:start")}>
        <div>
          ${filtered.length === 0 ? html`<div class="dim" style=${css("padding:30px;text-align:center")}>无匹配命令</div>` : ""}
          ${filtered.map((cmd) => html`
            <div key=${cmd.name} class="cmd-row" style=${cmd.name === selName ? css("border-color:var(--cyan)") : {}}
              onClick=${() => setSelName(cmd.name)}>
              <span class="cmd-name">${cmd.name}</span>
              <div class="grow">
                <div class="cmd-args">${cmd.args}</div>
                <div class="cmd-desc">${cmd.desc}</div>
              </div>
              <span class="cat-pill">${cmd.cat}</span>
            </div>`)}
        </div>

        <div>
          <div class="section-title" style=${css("margin-top:0")}>将执行</div>
          <div class="card">
            <div class="row between">
              <span class="cmd-name">${sel.name}</span>
              <span class="cat-pill">${sel.cat}</span>
            </div>
            <div class="cmd-args" style=${css("margin:8px 0")}>${sel.args}</div>
            <div class="cmd-desc">${sel.desc}</div>
            <div class="preview-cmd">$ rmux ${sel.example}</div>
            <button class="btn primary sm" style=${css("margin-top:12px;width:100%")}
              onClick=${() => toast(`路由到 ${c.target} · ${sel.name}`)}>↵ 在选中 target 执行</button>
          </div>
          <div class="dim" style=${css("font-size:11px;margin-top:10px;line-height:1.6")}>
            每条命令都是 typed、按 pane 句柄（%1/%2）寻址，可被 SDK / 命令面板 / 快捷键三种入口共用。
          </div>
        </div>
      </div>

      <div class="note-box">
        <b>真实映射：</b>Runweave 已有 tmux-native split 与 terminal-panel-target-bar.tsx 的 target 选择；把命令做成可搜索的 typed 面板，等于给现有 target bar 装了一个 Cmd-K 入口。
        <b>落地缺口：</b>① 把散在各处的终端动作（split/send/capture/share）收敛成一份 typed 命令注册表；② 命令与 target pane 句柄绑定并做执行前预览；③ 复用现有快捷输入 popover（terminal-quick-input-popover.tsx）承载呼出。
      </div>
    </div>`;
}

const VIEWS = { share: ShareView, verify: VerifyView, diagnose: DiagnoseView, commands: CommandsView };

function App({ data }) {
  const [active, setActive] = useState(IDEAS[0].id);
  const [toast, showToast] = useToast();
  const idea = IDEAS.find((i) => i.id === active) || IDEAS[0];
  const View = VIEWS[active];

  return html`
    <div class="app">
      <nav class="nav">
        <div class="nav-brand">
          <h1>Runweave × RMUX</h1>
          <p>把 RMUX 的能力借鉴映射到 Runweave 的<br/>多 backend × tmux-native 终端场景</p>
        </div>
        <div class="nav-section">4 个借鉴点</div>
        ${IDEAS.map((it, i) => html`
          <button key=${it.id} class=${"nav-item" + (it.id === active ? " active" : "")} onClick=${() => setActive(it.id)}>
            <span class="idx">${i + 1}</span>
            <span class="nav-text">
              <span class="nav-title">${it.title}</span>
              <span class="nav-sub">${it.sub}</span>
            </span>
          </button>`)}
        <div class="nav-foot">mock 数据 · 一次性原型<br/>不接真实 backend / WS / daemon</div>
      </nav>

      <main class="main">
        <div class="view-head">
          <h2>${idea.title}</h2>
          <div class="rmux-tag">↙ 借鉴自 ${idea.rmux}</div>
          <p class="why">${idea.why}</p>
        </div>
        <div class="view-body">
          <${View} data=${data} toast=${showToast} />
        </div>
      </main>

      ${toast ? html`<div class="toast">${toast}</div>` : ""}
    </div>`;
}

async function main() {
  const res = await fetch("./mock-state.json?v=" + Date.now());
  const data = await res.json();
  createRoot(document.getElementById("root")).render(html`<${App} data=${data} />`);
}

main();
