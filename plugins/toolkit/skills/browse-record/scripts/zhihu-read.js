/* global fetch, AbortSignal, URL, DOMParser, crypto */
// Playwright run-code consumes this file as one function expression; evaluate callbacks run in the browser.
// eslint-disable-next-line @typescript-eslint/no-unused-expressions
async page => {
  // prepare substitutes only non-secret identity/range options into this expression.
  const options = /*BROWSE_OPTIONS*/ {};
  const tabs = new Map();
  const errors = [];
  const capturedAt = new Date().toISOString();
  const deadline = Date.now() + 20 * 60 * 1000;
  const apiOrigin = "https://api.zhihu.com";
  const allowed = url => /^https:\/\/(?:api\.zhihu\.com\/unify-consumption\/read_history(?:\?[^#]*)?|www\.zhihu\.com\/api\/v4\/(?:me|answers\/\d+)(?:\?[^#]*)?|zhuanlan\.zhihu\.com\/api\/articles\/\d+)$/.test(url);
  const request = async url => {
    if (Date.now() > deadline && url !== "https://www.zhihu.com/api/v4/me") throw new Error("RUN_BUDGET_EXCEEDED");
    if (!allowed(url)) throw new Error("UNTRUSTED_API_URL");
    const origin = url.match(/^https:\/\/[^/]+/)[0];
    let tab = tabs.get(origin);
    if (!tab) { tab = await page.context().newPage(); tabs.set(origin, tab); await tab.goto(url, { timeout: 15000, waitUntil: "domcontentloaded" }); }
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await tab.evaluate(async target => {
        try {
          const response = await fetch(target, { credentials: "include", signal: AbortSignal.timeout(15000) });
          const text = await response.text();
          let data; try { data = JSON.parse(text); } catch { return { status: response.status, error: "NON_JSON_OR_VERIFICATION" }; }
          return { status: response.status, data };
        } catch { return { status: 0, error: "TIMEOUT_OR_NETWORK" }; }
      }, url);
      if ((result.status === 0 || result.status === 429 || result.status >= 500) && attempt < 2) { await tab.waitForTimeout(500 * (attempt + 1)); continue; }
      return result;
    }
  };
  const identity = async () => {
    const r = await request("https://www.zhihu.com/api/v4/me");
    if (r.status !== 200 || typeof r.data?.id !== "string" || !r.data.id) throw new Error(r.status === 401 || r.status === 403 ? "NEEDS_LOGIN" : "IDENTITY_UNAVAILABLE");
    return r.data.id;
  };
  const historyUrl = `${apiOrigin}/unify-consumption/read_history?offset=0&limit=20`;
  const parseHistory = response => {
    if (response.status !== 200 || !Array.isArray(response.data?.data) || typeof response.data?.paging?.is_end !== "boolean") throw new Error(response.status === 401 || response.status === 403 ? "NEEDS_LOGIN" : "HISTORY_UNAVAILABLE_OR_PARSE_FAILED");
    return response.data;
  };
  const parse = card => {
    const value = card.card_type === "single_card" ? card.data : null, extra = value?.extra;
    if (!extra || typeof extra.content_token !== "string" || typeof extra.content_type !== "string" || !Number.isFinite(extra.read_time)) throw new Error("UNKNOWN_HISTORY_STRUCTURE");
    const occurredAt = new Date(extra.read_time * (extra.read_time > 1e12 ? 1 : 1000)).toISOString();
    const day = new Date(Date.parse(occurredAt) + 8 * 3600000).toISOString().slice(0, 10);
    return { type: extra.content_type, id: extra.content_token, occurredAt, day, questionId: extra.question_token,
      title: typeof value.header?.title === "string" ? value.header.title : "知乎浏览内容" };
  };
  const signature = value => JSON.stringify(value.data.map(card => { const x = parse(card); return [x.type,x.id,x.occurredAt]; }));
  try {
    const identityBefore = await identity();
    if (options.externalAccountId && identityBefore !== options.externalAccountId) throw new Error("ACCOUNT_CHANGED");
    if (options.probe) return { identityBefore };
    const observed = new Map(); let pages = 0, stable = false;
    let baseline; let baselinePages = new Map();
    for (let round = 0; round < 3; round++) {
      baselinePages = new Map();
      let next = historyUrl, first, complete = false; const seenPages = new Set();
      for (let index = 0; index < 100; index++) {
        if (seenPages.has(next)) { errors.push("PAGINATION_LOOP"); break; }
        seenPages.add(next);
        let value;
        try { value = parseHistory(await request(next)); } catch (e) { errors.push(e.message); break; }
        baselinePages.set(next, signature(value));
        pages++; if (index === 0) { first = signature(value); baseline = baseline ?? first; }
        if (value.data.length > 20) { errors.push("PAGE_LIMIT_EXCEEDED"); break; }
        for (const card of value.data) {
          try { const item = parse(card); if (item.day >= options.from && item.day <= options.to) observed.set(`${item.type}:${item.id}:${item.occurredAt}`, item); }
          catch { errors.push("UNKNOWN_HISTORY_STRUCTURE"); }
        }
        if (value.paging.is_end) { complete = true; break; }
        try { const url = await tabs.get(apiOrigin).evaluate(value => { const u = new URL(value); return { href: u.href, origin: u.origin, limit: u.searchParams.get("limit") }; }, value.paging.next); if (!allowed(url.href) || url.origin !== apiOrigin || url.limit !== "20") throw new Error(); next = url.href; }
        catch { errors.push("UNTRUSTED_PAGINATION"); break; }
        if (index === 99) errors.push("PAGE_CAP_REACHED");
      }
      try { const check = parseHistory(await request(historyUrl)); if (signature(check) === first) { stable = complete; break; } }
      catch { errors.push("HOMEPAGE_RECHECK_FAILED"); break; }
      if (round === 2) errors.push("HISTORY_UNSTABLE");
    }
    const plain = async html => {
      const tab = tabs.get("https://www.zhihu.com");
      return tab.evaluate(value => {
        const safe = value.replace(/<(script|style|iframe|object|embed|video|audio)[\s\S]*?<\/\1\s*>/gi, "").replace(/<(img|source|link|meta)\b[^>]*>/gi, "");
        const doc = new DOMParser().parseFromString(safe, "text/html");
        for (const node of doc.querySelectorAll("p,div,br,li,h1,h2,h3,blockquote")) node.append("\n");
        return (doc.body.textContent ?? "").replace(/\n{3,}/g, "\n\n").trim();
      }, html);
    };
    const bodies = new Map(); const items = [];
    for (const observation of observed.values()) {
      const key = observation.type + ":" + observation.id;
      let content = bodies.get(key);
      if (!content) {
        const supported = ["answer", "article"].includes(observation.type) && /^\d+$/.test(observation.id);
        let body = "", state = "metadata-only", reason = supported ? null : "unsupported-content-type";
        if (supported) {
          const url = observation.type === "answer" ? `https://www.zhihu.com/api/v4/answers/${observation.id}?include=content,paid_info` : `https://zhuanlan.zhihu.com/api/articles/${observation.id}`;
          try {
            const r = await request(url);
            if (r.status === 200 && String(r.data?.id) === observation.id && typeof r.data.content === "string") {
              body = await plain(r.data.content); state = body ? "available" : "metadata-only";
              if (r.data.is_paid === true && r.data.paid_info?.has_purchased !== true) { state = "metadata-only"; reason = "paid-content-limited"; }
              if (!body) reason = "empty-content";
            } else reason = r.status === 403 ? "forbidden" : r.status === 404 ? "not-found" : "content-unavailable-or-id-mismatch";
          } catch { reason = "content-timeout-or-parse-failed"; }
        }
        content = { body, state, reason }; bodies.set(key, content);
      }
      const sourceUrl = observation.type === "answer" && /^\d+$/.test(observation.questionId ?? "") ? `https://www.zhihu.com/question/${observation.questionId}/answer/${observation.id}` : observation.type === "article" ? `https://zhuanlan.zhihu.com/p/${observation.id}` : null;
      items.push({ observation: { contentType: observation.type, contentId: observation.id, readTime: observation.occurredAt, observedAt: capturedAt },
        entry: { captureId: await tabs.get("https://www.zhihu.com").evaluate(() => crypto.randomUUID()), browseDate: observation.day, occurredAt: observation.occurredAt, capturedAt, title: observation.title, body: content.body, userNote: "", source: { provider: "zhihu", displayName: "知乎", connectionId: options.connectionId }, contentType: observation.type, captureMethod: "connector", sourceUrl, contentState: { state: content.state, reason: content.reason }, attachmentIds: [] } });
    }
    const identityAfter = await identity();
    if (identityAfter !== identityBefore) throw new Error("ACCOUNT_CHANGED_DURING_RUN");
    let historyUnchanged = false;
    try { historyUnchanged = baseline === signature(parseHistory(await request(historyUrl))); }
    catch { errors.push("HISTORY_RECHECK_FAILED"); }
    for (const [url, before] of baselinePages) {
      try { if (signature(parseHistory(await request(url))) !== before) historyUnchanged = false; }
      catch { historyUnchanged = false; errors.push("HISTORY_RECHECK_FAILED"); }
    }
    if (!historyUnchanged) errors.push("HISTORY_CHANGED_DURING_CONTENT_READ");
    return { identityBefore, identityAfter, items, historyUnchanged, coverage: { state: stable && errors.length === 0 ? "complete" : "partial", pages, metadata: items.length, content: items.filter(i => i.entry.contentState.state === "available").length, errors: [...new Set(errors)].slice(0,200) } };
  } finally { for (const tab of tabs.values()) await tab.close(); }
}
