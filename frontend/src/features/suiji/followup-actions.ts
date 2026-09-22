import type { Dispatch, SetStateAction, MutableRefObject } from "react";
import { useMemoizedFn } from "ahooks";
import {
  latestFollowupSummary,
  type SuijiRecord,
} from "@runweave/shared/suiji";
import type { SuijiClient } from "../../services/suiji";
import { SuijiEditorModel } from "./editor-model";
import type { SuijiDraftStore, SuijiDraft } from "./drafts";
export function useFollowupActions({
  client,
  store,
  writable,
  alive,
  models,
  setEditor,
  setItems,
  setDetail,
  setMessage,
}: {
  client: SuijiClient;
  store: SuijiDraftStore;
  writable: boolean;
  alive: MutableRefObject<boolean>;
  models: MutableRefObject<Map<string, SuijiEditorModel>>;
  setEditor: Dispatch<SetStateAction<SuijiEditorModel | undefined>>;
  setItems: Dispatch<SetStateAction<SuijiRecord[]>>;
  setDetail: Dispatch<
    SetStateAction<{ record: SuijiRecord; citedVersion?: number } | undefined>
  >;
  setMessage: Dispatch<SetStateAction<string>>;
}) {
  const acceptRecord = useMemoizedFn((record: SuijiRecord) => {
    if (!alive.current || !client.active) return;
    const merge = (old: SuijiRecord) => ({
      ...(old.version > record.version ? old : record),
      followupSummary: latestFollowupSummary(
        old.followupSummary,
        record.followupSummary,
      ),
    });
    setItems((old) =>
      old.map((item) => (item.id === record.id ? merge(item) : item)),
    );
    setDetail((old) =>
      old?.record.id === record.id
        ? { ...old, record: merge(old.record) }
        : old,
    );
  });
  const editFollowup = useMemoizedFn(async (record: SuijiRecord) => {
    if (!writable || record.deletedAt) return;
    try {
      const key = "followup:" + record.id;
      let model = models.current.get(key);
      if (!model) {
        const draft = (await store.get<SuijiDraft>(key)) ?? {
          id: record.id,
          kind: "note" as const,
          body: "",
          existing: [],
          files: [],
        };
        if (!alive.current) return;
        model = new SuijiEditorModel(draft, client, store, record.id);
        models.current.set(key, model);
        await model.initialize();
      }
      if (alive.current) setEditor(model);
    } catch (error) {
      if (alive.current)
        setMessage(error instanceof Error ? error.message : "跟进草稿读取失败");
    }
  });
  return { acceptRecord, editFollowup };
}
