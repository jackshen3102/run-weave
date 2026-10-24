import type {
  WorkFact,
  WorkFactInput,
  WorkFactPage,
  WorkDay,
  WorkReclassification,
  WorkProjectRestore,
} from "@runweave/shared/suiji";
import { SuijiClient, SuijiHttpError } from "../../services/suiji";
import { SuijiDraftStore, type PendingRequest } from "./drafts";
export const workLabels = {
  progress: "有进展",
  discussed: "讨论",
  documented: "已记录",
  attempted: "尝试",
  "agent-reported": "Agent 反馈",
  verified: "已验证",
};
export const workToday = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
export type WorkDraft = {
  id: string;
  fields: WorkFactInput;
  base?: WorkFact;
  pending?: PendingRequest;
};
export type WorkBatch = {
  id: string;
  rows: WorkFact[];
  project: string;
  pending?: PendingRequest;
  undo?: boolean;
};
type State = {
  items: WorkFact[];
  days: WorkDay[];
  cursor: string | null;
  from: string;
  to: string;
  loading: boolean;
  busy: boolean;
  error: string;
  draft?: WorkDraft;
  batch?: WorkBatch;
  undo?: WorkProjectRestore;
  detail?: WorkFact;
};
const root = "/api/suiji/v1/work-facts";
const message = (e: unknown) => (e instanceof Error ? e.message : "操作失败");
export class WorkRecordModel {
  state: State = {
    items: [],
    days: [],
    cursor: null,
    from: "",
    to: "",
    loading: false,
    busy: false,
    error: "",
  };
  private listeners = new Set<() => void>();
  private generation = 0;
  private alive = true;
  writable = false;
  private read?: AbortController;
  private writes: Promise<void> = Promise.resolve();
  constructor(
    readonly client: SuijiClient,
    readonly store: SuijiDraftStore,
  ) {}
  subscribe = (f: () => void) => {
    this.listeners.add(f);
    return () => {
      this.listeners.delete(f);
    };
  };
  snapshot = () => this.state;
  private set(value: Partial<State>) {
    if (this.alive && this.client.active) {
      this.state = { ...this.state, ...value };
      this.listeners.forEach((f) => f());
    }
  }
  private persist(key: string, value: unknown) {
    const snapshot = structuredClone(value);
    const next = this.writes
      .catch(() => undefined)
      .then(() => this.store.set(key, snapshot));
    this.writes = next;
    return next;
  }
  dispose() {
    this.alive = false;
    ++this.generation;
    this.read?.abort();
  }
  async settled() {
    await this.writes.catch(() => undefined);
  }
  async initialize() {
    this.alive = true;
    try {
      const [filters, active, undo] = await Promise.all([
        this.store.get<{ from: string; to: string }>("work:dates"),
        this.store.get<string>("work:reclassify:active"),
        this.store.get<WorkProjectRestore>("work:reclassify:undo"),
      ]);
      const batch = active
        ? await this.store.get<WorkBatch>("work:reclassify:" + active)
        : undefined;
      this.set({ ...(filters ?? {}), batch, undo });
      await this.load();
    } catch (e) {
      this.set({ error: message(e) });
    }
  }
  async load(more = false, restart = true) {
    if (more && (!this.state.cursor || this.state.loading)) return;
    this.read?.abort();
    this.read = new AbortController();
    const sequence = ++this.generation,
      { from, to, cursor } = this.state;
    this.set({
      loading: true,
      error: "",
      ...(!more ? { items: [], days: [], cursor: null } : {}),
    });
    const params = new URLSearchParams({
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      ...(more && cursor ? { cursor } : {}),
    });
    try {
      const page = await this.client.request<WorkFactPage>(
        root + "?" + params,
        "GET",
        undefined,
        undefined,
        this.read.signal,
      );
      if (!this.alive || sequence !== this.generation) return;
      const days = more
        ? Object.values(
            Object.fromEntries(
              [...this.state.days, ...page.days].map((d) => [d.date, d]),
            ),
          )
        : page.days;
      this.set({
        items: more ? [...this.state.items, ...page.items] : page.items,
        days,
        cursor: page.nextCursor,
      });
    } catch (e) {
      if (!this.alive || sequence !== this.generation) return;
      if (
        e instanceof SuijiHttpError &&
        e.detail.error.code === "WORK_FEED_CHANGED" &&
        restart
      ) {
        await this.load(false, false);
        return;
      }
      this.set({ error: message(e) });
    } finally {
      if (sequence === this.generation) this.set({ loading: false });
    }
  }
  async dates(from: string, to: string) {
    if (from && to && from > to) {
      this.set({ error: "开始日期不能晚于结束日期" });
      return;
    }
    await this.persist("work:dates", { from, to });
    this.set({ from, to });
    await this.load();
  }
  async detail(id: string) {
    try {
      const result = await this.client.request<{ fact: WorkFact }>(
        root + "/" + id,
      );
      this.set({ detail: result.fact });
    } catch (e) {
      this.set({ error: message(e) });
    }
  }
  closeDetail() {
    this.set({ detail: undefined });
  }
  async edit(fact?: WorkFact) {
    try {
      await this.writes;
      const id = fact?.id ?? "new",
        key = id === "new" ? "work:new" : "work:edit:" + id;
      const draft = (await this.store.get<WorkDraft>(key)) ?? {
        id,
        fields: fact
          ? {
              workDate: fact.workDate,
              title: fact.title,
              statement: fact.statement,
              status: fact.status,
              project: fact.project,
            }
          : {
              workDate: workToday(),
              title: "",
              statement: "",
              status: "progress",
              project: null,
            },
        ...(fact ? { base: fact } : {}),
      };
      await this.persist(key, draft);
      this.set({ draft, error: "" });
    } catch (e) {
      this.set({ error: message(e) });
    }
  }
  update(fields: Partial<WorkFactInput>) {
    const old = this.state.draft;
    if (!this.writable || !old || old.pending || this.state.busy) return;
    const draft = { ...old, fields: { ...old.fields, ...fields } };
    this.set({ draft });
    void this.persist(
      draft.id === "new" ? "work:new" : "work:edit:" + draft.id,
      draft,
    ).catch((e) => this.set({ error: message(e) }));
  }
  closeEditor() {
    if (!this.state.busy) this.set({ draft: undefined });
  }
  async discardEditor() {
    const draft = this.state.draft;
    if (!draft || draft.pending || this.state.busy) return;
    try {
      await this.writes;
      await this.store.remove(
        draft.id === "new" ? "work:new" : "work:edit:" + draft.id,
      );
      this.set({ draft: undefined });
    } catch (e) {
      this.set({ error: message(e) });
    }
  }
  async refreshVersion() {
    const draft = this.state.draft;
    if (!draft?.base || draft.pending || this.state.busy) return;
    try {
      const { fact } = await this.client.request<{ fact: WorkFact }>(
        root + "/" + draft.id,
      );
      const next = { ...draft, base: fact };
      await this.persist("work:edit:" + draft.id, next);
      this.set({
        draft: next,
        detail: fact,
        error: "已读取当前版本，下方保留你的草稿；请核对最新事实后再保存。",
      });
    } catch (e) {
      this.set({ error: message(e) });
    }
  }
  async save() {
    let draft = this.state.draft;
    if (!this.writable || !draft || this.state.busy) return;
    this.set({ busy: true, error: "" });
    const key = draft.id === "new" ? "work:new" : "work:edit:" + draft.id;
    try {
      await this.writes;
      if (!draft.pending) {
        const f = draft.fields;
        if (
          !f.title.trim() ||
          !f.statement.trim() ||
          [...f.title.trim()].length > 80 ||
          [...f.statement].length > 4000 ||
          [...(f.project?.trim() ?? "")].length > 80 ||
          !/^\d{4}-\d\d-\d\d$/.test(f.workDate)
        )
          throw new Error(
            "请填写有效工作日期、1–80字标题及1–4000字正文；项目最多80字",
          );
        const fields = {
          ...f,
          title: f.title.trim(),
          project: f.project?.trim() || null,
        };
        const data = draft.base
          ? {
              expectedVersion: draft.base.version,
              ...Object.fromEntries(
                Object.entries(fields).filter(
                  ([k, v]) => v !== draft!.base![k as keyof WorkFactInput],
                ),
              ),
            }
          : fields;
        if (draft.base && Object.keys(data).length === 1) {
          this.set({ draft: undefined });
          return;
        }
        draft = {
          ...draft,
          pending: {
            key: crypto.randomUUID(),
            method: draft.base ? "PATCH" : "POST",
            path: root + (draft.base ? "/" + draft.id : ""),
            data,
          },
        };
        await this.persist(key, draft);
        this.set({ draft });
      }
      const p = draft.pending!;
      const { fact } = await this.client.request<{ fact: WorkFact }>(
        p.path,
        p.method,
        p.data,
        p.key,
      );
      if (
        !fact?.id ||
        (draft.base && fact.id !== draft.id) ||
        Object.entries(p.data as Record<string, unknown>).some(
          ([k, v]) =>
            k !== "expectedVersion" && fact[k as keyof WorkFact] !== v,
        )
      )
        throw new Error("保存回执不匹配，请手动确认原请求");
      await this.store.remove(key);
      this.set({ draft: undefined, detail: fact });
      await this.dates(fact.workDate, fact.workDate);
    } catch (e) {
      if (e instanceof SuijiHttpError && !e.uncertain && draft.pending) {
        draft = { ...draft, pending: undefined };
        await this.persist(key, draft);
        this.set({ draft });
      }
      this.set({ error: message(e) });
    } finally {
      this.set({ busy: false });
    }
  }
  async beginBatch(rows: WorkFact[], undo = false) {
    if (this.state.batch || this.state.busy) return;
    try {
      const batch: WorkBatch = {
        id: crypto.randomUUID(),
        rows,
        project: "",
        ...(undo ? { undo } : {}),
      };
      await this.persist("work:reclassify:" + batch.id, batch);
      await this.persist("work:reclassify:active", batch.id);
      this.set({ batch, error: "" });
    } catch (e) {
      this.set({ error: message(e) });
    }
  }
  updateBatch(rows: WorkFact[], project: string) {
    const b = this.state.batch;
    if (!b || b.pending || this.state.busy) return;
    const batch = { ...b, rows, project };
    this.set({ batch });
    void this.persist("work:reclassify:" + b.id, batch).catch((e) =>
      this.set({ error: message(e) }),
    );
  }
  async refreshBatch() {
    const batch = this.state.batch;
    if (
      !this.writable ||
      !batch ||
      batch.undo ||
      batch.pending ||
      this.state.busy
    )
      return;
    try {
      const rows = await Promise.all(
        batch.rows.map(
          async (r) =>
            (await this.client.request<{ fact: WorkFact }>(root + "/" + r.id))
              .fact,
        ),
      );
      const next = { ...batch, rows };
      await this.persist("work:reclassify:" + batch.id, next);
      this.set({
        batch: next,
        error: "已读取所选事实的最新版本，请核对后再确认归类。",
      });
    } catch (e) {
      this.set({ error: message(e) });
    }
  }
  async cancelBatch() {
    const b = this.state.batch;
    if (!b || b.pending || this.state.busy) return;
    try {
      await this.writes;
      await this.store.remove("work:reclassify:" + b.id);
      await this.store.remove("work:reclassify:active");
      this.set({ batch: undefined });
    } catch (e) {
      this.set({ error: message(e) });
    }
  }
  async undo() {
    if (this.state.undo && !this.state.batch) await this.beginBatch([], true);
  }
  async commitBatch() {
    let batch = this.state.batch;
    if (!this.writable || !batch || this.state.busy) return;
    this.set({ busy: true, error: "" });
    const key = "work:reclassify:" + batch.id;
    try {
      await this.writes;
      if (!batch.pending) {
        if (!batch.undo && (batch.rows.length < 1 || batch.rows.length > 100))
          throw new Error("请选择1–100条已加载记录");
        const data: WorkReclassification | WorkProjectRestore = batch.undo
          ? this.state.undo!
          : {
              items: batch.rows.map((r) => ({
                id: r.id,
                expectedVersion: r.version,
              })),
              project: batch.project.trim() || null,
            };
        if (!data) throw new Error("没有可撤销的项目调整");
        batch = {
          ...batch,
          pending: {
            path: root + (batch.undo ? "/reclassify/undo" : "/reclassify"),
            method: "POST",
            data,
            key: crypto.randomUUID(),
          },
        };
        await this.persist(key, batch);
        this.set({ batch });
      }
      const p = batch.pending!;
      const { facts } = await this.client.request<{ facts: WorkFact[] }>(
        p.path,
        p.method,
        p.data,
        p.key,
      );
      const input = p.data as WorkReclassification | WorkProjectRestore;
      if (
        !Array.isArray(facts) ||
        facts.length !== input.items.length ||
        input.items.some(
          (i) =>
            !facts.some(
              (f) =>
                f.id === i.id &&
                f.version === i.expectedVersion + 1 &&
                f.project ===
                  ("project" in i
                    ? i.project
                    : (input as WorkReclassification).project),
            ),
        )
      )
        throw new Error("归类回执不匹配，请手动确认原请求");
      const undo = batch.undo
        ? undefined
        : {
            items: facts.map((f) => ({
              id: f.id,
              expectedVersion: f.version,
              project: batch!.rows.find((r) => r.id === f.id)!.project,
            })),
          };
      if (undo) await this.persist("work:reclassify:undo", undo);
      else await this.store.remove("work:reclassify:undo");
      await this.store.remove(key);
      await this.store.remove("work:reclassify:active");
      const detail =
        facts.find((f) => f.id === this.state.detail?.id) ?? this.state.detail;
      this.set({ batch: undefined, undo, detail });
      await this.load();
    } catch (e) {
      if (e instanceof SuijiHttpError && !e.uncertain && batch.pending) {
        batch = { ...batch, pending: undefined };
        await this.persist(key, batch);
        this.set({ batch });
      }
      this.set({ error: message(e) });
    } finally {
      this.set({ busy: false });
    }
  }
}
