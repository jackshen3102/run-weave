import {
  SUIJI_LIMITS,
  type RecordResponse,
  type SuijiRecord,
  type UploadedAttachment,
} from "@runweave/shared/suiji";
import { SuijiClient, SuijiHttpError } from "../../services/suiji";
import { SuijiDraftStore, type SuijiDraft } from "./drafts";

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
    discarded?: boolean;
  };
  constructor(
    draft: SuijiDraft,
    private client: SuijiClient,
    private store: SuijiDraftStore,
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
  subscribe = (callback: () => void) => {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  };
  snapshot = () => this.state;
  dispose() {
    this.active = false;
    this.listeners.clear();
  }
  settled() {
    return this.queue;
  }
  initialize() {
    return this.persist();
  }
  async discard() {
    if (this.state.busy || this.state.draft.frozen) return;
    this.patch({ busy: true });
    try { await this.queue; this.check(); await this.store.remove("draft:" + this.state.draft.id); this.patch({ discarded: true }); }
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
      this.store.set("draft:" + snapshot.id, snapshot),
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
    update: Partial<Pick<SuijiDraft, "kind" | "body" | "existing" | "files">>,
  ) {
    if (this.state.busy || this.state.draft.frozen) return;
    const draft = { ...this.state.draft, ...update };
    this.patch({ draft });
    void this.persist(draft).catch(() => undefined);
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
    if (this.state.busy || this.state.saved) return;
    this.patch({ busy: true, message: "" });
    try {
      this.check();
      let draft = this.state.draft;
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
            path:
              "/api/suiji/v1/records" +
              (draft.id === "new" ? "" : "/" + draft.id),
            method: draft.id === "new" ? "POST" : "PATCH",
            key: crypto.randomUUID(),
            data: {
              kind: draft.kind,
              ...(draft.id === "new" ? {} : { expectedVersion: draft.version }),
              body: draft.body,
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
      const result = await this.client.request<RecordResponse>(
        pending.path,
        pending.method,
        pending.data,
        pending.key,
      );
      this.check();
      await this.store.remove("draft:" + draft.id);
      this.patch({ saved: result.record });
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
      message: "已采用最新版本号与附件，本机正文和类型保留；请比较后手动保存",
    });
    void this.persist(draft).catch(() => undefined);
  }
}
