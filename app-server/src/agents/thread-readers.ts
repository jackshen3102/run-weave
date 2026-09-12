import type {
  AppServerThreadRef,
  AppServerThreadDetail,
  AppServerThreadDetailResponse,
} from "@runweave/shared/app-server-events";
import type { CodexThreadDetailReader } from "../codex/client.js";
import type { TraeThreadLifecycleReader } from "../trae/lifecycle-reader.js";
import type { PiSessionReader } from "../pi/session-reader.js";

interface ThreadReader {
  supports: (thread: AppServerThreadRef) => boolean;
  summary: (
    thread: AppServerThreadRef,
  ) => Promise<AppServerThreadDetail | null>;
  detail: (
    thread: AppServerThreadRef,
  ) => Promise<AppServerThreadDetailResponse>;
}

/** Static provider composition shared by both HTTP history endpoints. */
export function createThreadReaders(options: {
  piSessionReader: PiSessionReader;
  traeLifecycleReader: TraeThreadLifecycleReader;
  codexThreadDetailReader: CodexThreadDetailReader;
}) {
  const readers: ThreadReader[] = [
    {
      supports: (thread) => thread.agent === "pi",
      summary: async (thread) =>
        (await options.piSessionReader.read(thread))?.summary ?? null,
      detail: async (thread) => {
        const result = await options.piSessionReader.read(thread);
        return {
          thread,
          availability: result ? "available" : "thread_not_found",
          ...(result ? { detail: result.detail } : {}),
        };
      },
    },
    {
      supports: (thread) => options.traeLifecycleReader.supports(thread.agent),
      summary: (thread) =>
        options.traeLifecycleReader.readThread(thread.threadId, thread.agent),
      detail: async (thread) => {
        const detail = await options.traeLifecycleReader.readThread(
          thread.threadId,
          thread.agent,
        );
        return {
          thread,
          availability: detail ? "available" : "thread_not_found",
          ...(detail ? { detail } : {}),
        };
      },
    },
  ];
  const fallback: ThreadReader = {
    supports: () => true,
    summary: async () => null,
    detail: (thread) =>
      options.codexThreadDetailReader.readThreadDetail(thread),
  };
  return (thread: AppServerThreadRef) =>
    readers.find((reader) => reader.supports(thread)) ?? fallback;
}
