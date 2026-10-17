import type { Dispatch, SetStateAction, MutableRefObject } from "react";
import { useMemoizedFn } from "ahooks";
import type { RecordResponse, SuijiRecord } from "@runweave/shared/suiji";
import { SuijiHttpError, type SuijiClient } from "../../services/suiji";
import type { PendingRequest, SuijiDraft, SuijiDraftStore } from "./drafts";

export function useRecordActions({
  client, store, writable, statusBusy, alive, setStatusBusy, setMessage,
  setPending, acceptRecord, setDetail, load,
}: {
  client: SuijiClient;
  store: SuijiDraftStore;
  writable: boolean;
  statusBusy: boolean;
  alive: MutableRefObject<boolean>;
  setStatusBusy: Dispatch<SetStateAction<boolean>>;
  setMessage: Dispatch<SetStateAction<string>>;
  setPending: Dispatch<SetStateAction<Set<string>>>;
  acceptRecord: (record: SuijiRecord) => void;
  setDetail: Dispatch<SetStateAction<{ record: SuijiRecord; citedVersion?: number } | undefined>>;
  load: () => Promise<void>;
}) {
  return useMemoizedFn(
    async (
      record: SuijiRecord,
      action:
        | { targetStatus: "open" | "done" | "archived" }
        | { trashed: boolean }
        | { tags: string[] },
    ) => {
      if (!writable || statusBusy) return;
      setStatusBusy(true);
      setMessage("");
      try {
        const previous = await store.get<PendingRequest>("status:" + record.id);
        if (
          !previous &&
          (await store.get<SuijiDraft>("draft:" + record.id))?.frozen
        )
          throw new Error("正文保存结果待确认，请先在编辑器确认");
        const operation = previous ?? {
          path: `/api/suiji/v1/records/${record.id}${"tags" in action ? "" : "trashed" in action ? "/trash" : "/task-status"}`,
          method: "tags" in action ? "PATCH" : "POST",
          key: crypto.randomUUID(),
          data: { expectedVersion: record.version, ...action },
        };
        await store.set("status:" + record.id, operation);
        if (!alive.current) return;
        setPending((old) => new Set([...old, record.id]));
        const result = await client.request<RecordResponse>(
          operation.path,
          operation.method,
          operation.data,
          operation.key,
        );
        if (!alive.current) return;
        await store.remove("status:" + record.id);
        setPending((old) => {
          const next = new Set(old);
          next.delete(record.id);
          return next;
        });
        acceptRecord(result.record);
        setDetail((current) => {
          if (current?.record.id !== record.id) return current;
          return operation.path.endsWith("/trash") ||
            (operation.path.endsWith("/task-status") && result.record.taskStatus === "done")
            ? undefined
            : current;
        });
        await load();
      } catch (error) {
        if (!alive.current) return;
        if (error instanceof SuijiHttpError && !error.uncertain) {
          try {
            await store.remove("status:" + record.id);
            setPending((old) => {
              const next = new Set(old);
              next.delete(record.id);
              return next;
            });
          } catch {
            setMessage("本机状态确认写入失败，请手动重试");
            return;
          }
        }
        if (error instanceof SuijiHttpError && error.detail.error.code === "VERSION_CONFLICT") {
          try {
            const latest = await client.request<RecordResponse>(`/api/suiji/v1/records/${record.id}`);
            acceptRecord(latest.record);
            setMessage("记录已在其他地方更新，已显示最新内容，请重新选择标签或操作");
          } catch {
            setMessage("记录已有新版本，读取失败，请返回列表重新打开后再操作");
          }
          return;
        }
        setMessage(error instanceof Error ? error.message : "操作结果待确认");
      } finally {
        if (alive.current) setStatusBusy(false);
      }
    },
  );
}
