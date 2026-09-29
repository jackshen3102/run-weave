import {
  SUIJI_LIMITS,
  normalizeSuijiTags,
  type RecordResponse,
  type FollowupResponse,
  type SuijiRecord,
  type UploadedAttachment,
  type CorrectionLexicon,
  type CorrectionLexiconEntry,
  type SuijiCorrection,
  type CorrectionPreferences,
  type CorrectionHistoryPage,
} from "@runweave/shared/suiji";
import { SuijiClient, SuijiHttpError } from "../../services/suiji";
import { SuijiDraftStore, type SuijiDraft, type FeedbackIntent } from "./drafts";

export class SuijiEditorModel {
  private listeners = new Set<() => void>();
  private queue: Promise<unknown> = Promise.resolve();
  private writes = 0;
  private active = true;
  state: {
    draft: SuijiDraft;
    busy: boolean;
    localSaving: boolean;
    message: string;
    localError: boolean;
    conflict: boolean;
    latest?: SuijiRecord;
    saved?: SuijiRecord;
    savedFollowup?: FollowupResponse;
    discarded?: boolean;
    correction?: SuijiCorrection;
    correctionSource?: string;
    correctionBusy?: boolean;
    lexicon?: CorrectionLexicon;
    correctionMessage?: string;
    lexiconPending?: boolean;
    preferences?: CorrectionPreferences;
    history?: CorrectionHistoryPage;
    feedbackPending?: boolean;
  };
  private correctionAbort?: AbortController;
  private correctionKey?: string;
  constructor(
    draft: SuijiDraft,
    private client: SuijiClient,
    private store: SuijiDraftStore,
    readonly followupRecordId?: string,
    readonly historySupported = false,
  ) {
    this.state = {
      draft,
      busy: false,
      localSaving: false,
      message: draft.frozen ? "保存结果待确认，请手动重试；输入暂时锁定" : "",
      localError: false,
      conflict: false,
    };
  }
  private get storeKey() { return this.followupRecordId ? "followup:" + this.followupRecordId : "draft:" + this.state.draft.id; }
  subscribe = (callback: () => void) => {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  };
  snapshot = () => this.state;
  dispose() {
    this.active = false;
    this.correctionAbort?.abort();
    this.listeners.clear();
  }
  settled() {
    return this.queue;
  }
  initialize() {
    void this.loadFeedbackState();
    return this.persist();
  }
  async discard() {
    if (this.state.busy || this.state.draft.frozen) return;
    this.patch({ busy: true });
    try { await this.queue; this.check(); await this.store.remove(this.storeKey); this.patch({ discarded: true }); }
    catch (error) { this.patch({ message: error instanceof Error ? error.message : "放弃草稿失败" }); }
    finally { this.patch({ busy: false }); }
  }
  private check() {
    if (!this.active || !this.client.active)
      throw new DOMException("编辑会话已结束", "AbortError");
  }
  private patch(update: Partial<typeof this.state>) {
    this.state = { ...this.state, ...update };
    this.listeners.forEach((f) => f());
  }
  private persist(draft = this.state.draft) {
    const snapshot = structuredClone(draft);
    ++this.writes;
    this.patch({ localSaving: true });
    const pending = this.queue.then(() =>
      this.store.set(this.storeKey, snapshot),
    );
    this.queue = pending.catch(() => undefined);
    return pending
      .then(() => this.patch({ localError: false }))
      .catch((error: unknown) => {
        this.patch({
          message: error instanceof Error ? error.message : "本机草稿未保存",
          localError: true,
        });
        throw error;
      })
      .finally(() => {
        --this.writes;
        this.patch({ localSaving: this.writes > 0 });
      });
  }
  edit(
    update: Partial<Pick<SuijiDraft, "kind" | "body" | "tags" | "existing" | "files">>,
  ) {
    if (this.state.busy || this.state.draft.frozen) return;
    const draft = { ...this.state.draft, ...update };
    this.patch({ draft, ...(update.body !== undefined && update.body !== this.state.draft.body ? { correction: undefined, correctionSource: undefined } : {}) });
    void this.persist(draft).catch(() => undefined);
  }
  async loadLexicon() {
    try {
      const pending = await this.store.get<{ key: string; data: { expectedVersion: number; entries: CorrectionLexiconEntry[] } }>("lexicon-intent");
      this.check();
      this.patch({ lexiconPending: !!pending });
      const lexicon = await this.client.request<CorrectionLexicon>("/api/suiji/v1/correction-lexicon");
      this.check();
      this.patch({ lexicon });
    } catch (error) {
      if (this.active) this.patch({ correctionMessage: error instanceof Error ? error.message : "词库读取失败" });
    }
  }
  async correct() {
    const text = this.state.draft.body;
    if (this.state.busy || this.state.draft.frozen || !text.trim() || this.state.correctionBusy) return;
    if (this.correctionKey && this.state.correctionSource !== text) {
      this.patch({ correctionMessage: "原请求结果待确认；请先取消，再对新正文发起纠错" });
      return;
    }
    const abort = new AbortController();
    this.correctionAbort = abort;
    const key = this.correctionKey ?? crypto.randomUUID();
    this.correctionKey = key;
    this.patch({ correctionBusy: true, correction: undefined, correctionSource: text, correctionMessage: "正在纠正文字…" });
    try {
      let job = await this.client.request<SuijiCorrection>("/api/suiji/v1/corrections", "POST",
        { text, ...(this.historySupported && !this.followupRecordId ? { feedbackCapable: true,
          ...(this.state.draft.id !== "new" ? { recordId: this.state.draft.id } : {}) } : {}) }, key, abort.signal);
      this.check();
      this.patch({ correction: job });
      while (job.status === "running" && !abort.signal.aborted) {
        await new Promise<void>((resolve) => setTimeout(resolve, 1000));
        this.check();
        job = await this.client.request<SuijiCorrection>("/api/suiji/v1/corrections/" + job.id, "GET", undefined, undefined, abort.signal);
        this.patch({ correction: job });
      }
      this.check();
      if (abort.signal.aborted) return;
      this.correctionKey = undefined;
      this.patch({ correction: job, correctionMessage: job.status === "completed" ? "" : job.error ?? "纠错未完成" });
    } catch (error) {
      if (this.active && !abort.signal.aborted)
        this.patch({ correctionMessage: "纠错结果待确认；再次点击会沿用同一请求。" + (error instanceof Error ? error.message : "") });
    } finally {
      if (this.correctionAbort === abort) { this.correctionAbort = undefined; this.patch({ correctionBusy: false }); }
    }
  }
  async cancelCorrection() {
    const id = this.state.correction?.id;
    this.correctionAbort?.abort();
    if (id) await this.client.request<SuijiCorrection>("/api/suiji/v1/corrections/" + id, "DELETE").catch(() => undefined);
    this.correctionKey = undefined;
    this.patch({ correction: undefined, correctionSource: undefined, correctionBusy: false, correctionMessage: "" });
  }
  applyCorrection() {
    const { correction, correctionSource, draft } = this.state;
    if (!correction || correction.status !== "completed" || !correction.correctedText ||
      correctionSource !== draft.body || draft.frozen || this.state.busy || !this.active || !this.client.active) {
      this.patch({ correctionMessage: "正文或编辑会话已变化，请重新纠错" });
      return;
    }
    const nextDraft = { ...draft, body: correction.correctedText,
      correctionTrace: correction.historyId && this.state.correctionSource ? {
        correctionId: correction.id, inputText: this.state.correctionSource,
        correctedText: correction.correctedText, applied: true,
      } : undefined };
    this.patch({ draft: nextDraft, correction: undefined, correctionSource: undefined });
    void this.persist(nextDraft).catch(() => undefined);
    this.patch({ correctionMessage: "已应用到本机草稿；点击保存才会更新记录" });
  }
  async putLexicon(entries: CorrectionLexiconEntry[]) {
    this.check();
    const lexicon = this.state.lexicon;
    if (!lexicon) throw new Error("请先读取词库");
    const saved = await this.store.get<{ key: string; data: { expectedVersion: number; entries: CorrectionLexiconEntry[] } }>("lexicon-intent");
    const intent = saved ?? { key: crypto.randomUUID(), data: { expectedVersion: lexicon.version, entries } };
    await this.store.set("lexicon-intent", intent);
    this.patch({ lexiconPending: true });
    try {
      const next = await this.client.request<CorrectionLexicon>("/api/suiji/v1/correction-lexicon", "PUT", intent.data, intent.key);
      this.check();
      await this.store.remove("lexicon-intent");
      this.patch({ lexicon: next, lexiconPending: false, correctionMessage: "已记住；可在词库中撤销" });
    } catch (error) {
      if (error instanceof SuijiHttpError && !error.uncertain) {
        await this.store.remove("lexicon-intent");
        this.patch({ lexiconPending: false });
      }
      this.patch({ correctionMessage: error instanceof Error ? error.message : "词库结果待确认，请手动重试" });
      throw error;
    }
  }
  async addFile(file: File) {
    try {
      this.check();
      if (file.size > SUIJI_LIMITS.attachmentBytes)
        throw new Error("每个附件最多 5 MiB");
      const image = ["image/jpeg", "image/png"].includes(file.type);
      if (!image && !/\.md$/i.test(file.name))
        throw new Error("仅支持 JPEG、PNG 和 Markdown");
      if (!image)
        new TextDecoder("utf-8", { fatal: true }).decode(
          await file.arrayBuffer(),
        );
      this.check();
      const draft = this.state.draft,
        kind = image ? "image" : "markdown";
      if (
        draft.existing.some((a) => a.kind === kind) ||
        draft.files.some(
          (a) =>
            (a.file.type.startsWith("image/") ? "image" : "markdown") === kind,
        )
      )
        throw new Error("每条最多一张图片和一个 Markdown，请先移除原附件");
      if (!image) file = new File([file], file.name, { type: "text/markdown", lastModified: file.lastModified });
      this.edit({
        files: [
          ...draft.files,
          { id: crypto.randomUUID(), file, key: crypto.randomUUID() },
        ],
      });
    } catch (error) {
      this.patch({
        message: error instanceof Error ? error.message : "附件读取失败",
      });
    }
  }
  async save() {
    if (this.state.busy || this.state.saved || this.state.savedFollowup) return;
    this.patch({ busy: true, message: "" });
    try {
      this.check();
      let draft = this.state.draft;
      if (!this.followupRecordId && !draft.pending && draft.tags !== undefined) {
        draft = { ...draft, tags: normalizeSuijiTags(draft.tags) };
        this.patch({ draft });
      }
      if ([...draft.body].length > SUIJI_LIMITS.bodyScalars)
        throw new Error("正文最多 20,000 个字符");
      if (!draft.body.trim() && !draft.existing.length && !draft.files.length)
        throw new Error("请输入正文或添加附件");
      await this.persist(draft);
      this.check();
      if (!draft.pending) {
        draft = { ...draft, frozen: true };
        this.patch({ draft });
        await this.persist(draft);
        for (const [index, item] of draft.files.entries()) {
          if (item.uploaded) continue;
          this.check();
          const form = new FormData();
          form.append("file", item.file, item.file.name);
          const result = await this.client.request<{
            attachment: UploadedAttachment;
          }>("/api/suiji/v1/uploads", "POST", form, item.key);
          this.check();
          draft = {
            ...draft,
            files: draft.files.map((file, i) =>
              i === index ? { ...file, uploaded: result.attachment } : file,
            ),
          };
          this.patch({ draft });
          await this.persist(draft);
        }
        draft = {
          ...draft,
          pending: {
            path: this.followupRecordId ? `/api/suiji/v1/records/${this.followupRecordId}/followups` :
              "/api/suiji/v1/records" +
              (draft.id === "new" ? "" : "/" + draft.id),
            method: this.followupRecordId || draft.id === "new" ? "POST" : "PATCH",
            key: crypto.randomUUID(),
            data: {
              ...(this.followupRecordId ? {} : { kind: draft.kind, ...(draft.id === "new" ? {} : { expectedVersion: draft.version }) }),
              body: draft.body,
              ...(this.followupRecordId || draft.tags === undefined ? {} : { tags: draft.tags }),
              attachmentIds: [
                ...draft.existing.map((a) => a.id),
                ...draft.files.map((a) => a.uploaded!.id),
              ],
            },
          },
        };
        this.patch({ draft });
        await this.persist(draft);
      }
      this.check();
      const pending = draft.pending!;
      const result = await this.client.request<RecordResponse | FollowupResponse>(
        pending.path,
        pending.method,
        pending.data,
        pending.key,
      );
      this.check();
      if (this.followupRecordId) {
        if (!("followup" in result) || result.followup.recordId !== this.followupRecordId || result.followup.body !== draft.body ||
          JSON.stringify(result.followup.attachments.map(item => item.id)) !== JSON.stringify(draft.files.map(item => item.uploaded!.id)) ||
          result.followupSummary.latest?.sequence !== result.followup.sequence) throw new Error("跟进响应与保存内容不一致，请手动重试确认");
      }
      if ("record" in result && (result.record.body !== draft.body ||
        (draft.id !== "new" && result.record.id !== draft.id))) {
        throw new Error("记录响应与保存正文不一致，请手动重试确认");
      }
      if ("record" in result && draft.correctionTrace?.applied &&
        (draft.version === undefined || result.record.version > draft.version)) {
        await this.enqueueFeedback({ correctionId: draft.correctionTrace.correctionId,
          key: crypto.randomUUID(), recordId: result.record.id,
          recordVersion: result.record.version, saveKey: pending.key }).catch(() => undefined);
      }
      await this.store.remove(this.storeKey);
      if ("record" in result) void this.retryFeedback();
      if ("followup" in result) this.patch({ savedFollowup: result });
      else this.patch({ saved: result.record });
    } catch (error) {
      if (!this.active) return;
      if (error instanceof SuijiHttpError && !error.uncertain) {
        const conflict = error.detail.error.code === "VERSION_CONFLICT";
        const draft = {
          ...this.state.draft,
          frozen: false,
          pending: undefined,
        };
        this.patch({ draft, conflict, message: error.message });
        await this.persist(draft).catch(() => undefined);
      } else
        this.patch({
          message:
            (this.state.draft.frozen
              ? "保存结果待确认，手动重试会沿用同一次请求。"
              : "") + (error instanceof Error ? error.message : "保存失败"),
        });
    } finally {
      this.patch({ busy: false });
    }
  }
  async loadPreferences() {
    if (!this.historySupported) return;
    try {
      const preferences = await this.client.request<CorrectionPreferences>("/api/suiji/v1/correction-preferences");
      this.check(); this.patch({ preferences });
    } catch (error) { this.patch({ correctionMessage: error instanceof Error ? error.message : "读取历史设置失败" }); }
  }
  async setHistoryEnabled(enabled: boolean) {
    const old = this.state.preferences;
    if (!old) return;
    try {
      const preferences = await this.client.request<CorrectionPreferences>("/api/suiji/v1/correction-preferences",
        "PUT", { expectedVersion: old.version, historyEnabled: enabled }, crypto.randomUUID());
      this.check(); this.patch({ preferences });
    } catch (error) { this.patch({ correctionMessage: error instanceof Error ? error.message : "设置失败" }); }
  }
  async loadHistory(cursor?: string) {
    if (!this.historySupported) return;
    try {
      const history = await this.client.request<CorrectionHistoryPage>("/api/suiji/v1/correction-history" +
        (cursor ? "?cursor=" + encodeURIComponent(cursor) : ""));
      this.check(); this.patch({ history: cursor && this.state.history
        ? { items: [...this.state.history.items, ...history.items], nextCursor: history.nextCursor } : history });
    } catch (error) { this.patch({ correctionMessage: error instanceof Error ? error.message : "历史读取失败" }); }
  }
  async deleteHistory(id?: string) {
    try {
      await this.client.request("/api/suiji/v1/correction-history" + (id ? "/" + id : ""),
        "DELETE", undefined, crypto.randomUUID());
      this.check(); await this.loadHistory(); await this.loadPreferences();
    } catch (error) { this.patch({ correctionMessage: error instanceof Error ? error.message : "删除失败" }); }
  }
  private async loadFeedbackState() {
    const items = await this.store.get<FeedbackIntent[]>("feedback-intents").catch(() => undefined);
    if (this.active) this.patch({ feedbackPending: !!items?.length });
  }
  private async enqueueFeedback(intent: FeedbackIntent) {
    const items = await this.store.get<FeedbackIntent[]>("feedback-intents") ?? [];
    await this.store.set("feedback-intents", [...items, intent]);
    this.patch({ feedbackPending: true });
  }
  async retryFeedback() {
    const items = await this.store.get<FeedbackIntent[]>("feedback-intents").catch(() => undefined);
    if (!items?.length) return;
    const remaining: FeedbackIntent[] = [];
    for (const intent of items) {
      try {
        await this.client.request("/api/suiji/v1/corrections/" + intent.correctionId + "/feedback",
          "POST", { recordId: intent.recordId, recordVersion: intent.recordVersion, saveKey: intent.saveKey }, intent.key);
      } catch (error) {
        if (!(error instanceof SuijiHttpError) || error.uncertain) remaining.push(intent);
      }
    }
    if (remaining.length) await this.store.set("feedback-intents", remaining);
    else await this.store.remove("feedback-intents");
    this.patch({ feedbackPending: !!remaining.length });
  }
  async loadLatest() {
    if (this.state.busy || this.state.draft.id === "new") return;
    try {
      const { record } = await this.client.request<RecordResponse>(
        "/api/suiji/v1/records/" + this.state.draft.id,
      );
      this.check();
      this.patch({ latest: record });
    } catch (error) {
      this.patch({
        message: error instanceof Error ? error.message : "读取最新版本失败",
      });
    }
  }
  acceptLatestVersion() {
    const latest = this.state.latest;
    if (!latest || this.state.busy || this.state.draft.frozen) return;
    // Keep local body and kind: use the current remote attachments so concurrent file edits are not silently undone.
    const draft = {
      ...this.state.draft,
      version: latest.version,
      existing: latest.attachments,
      files: [],
    };
    if (this.state.draft.files.length) {
      this.patch({
        message: "本机还有新增附件，请先保存其文件并移除，再采用最新附件版本",
      });
      return;
    }
    this.patch({
      draft,
      latest: undefined,
      conflict: false,
      message: "已采用最新版本号与附件，本机正文、类型和标签选择保留；请比较后手动保存",
    });
    void this.persist(draft).catch(() => undefined);
  }
}
