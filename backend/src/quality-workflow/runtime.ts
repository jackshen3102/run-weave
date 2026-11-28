import path from "node:path";
import { settingText } from "@runweave/config-node";
import type { TerminalTextAttachmentDelivery } from "../terminal/attachments/text-attachment-delivery";
import type { TerminalSessionCreationOptions } from "../terminal/application/create-session";
import { QualityIssueHandoffService } from "./handoff";
import { QualityStore } from "./store";
import { QualityService } from "./service";
import { QualityLogReader } from "./log-reader";
import { logger } from "../logging/index";
export class QualityRuntime {
  private timer?: ReturnType<typeof setInterval>; private running?: Promise<void>; private stopped = false;
  private constructor(readonly service: QualityService, private store: QualityStore | null, private readers: QualityLogReader[] = []) {}
  static async create(directory: string, logDirectory: string, backendId: string | null, projectForTerminal: (id: string) => string | null | undefined, handoffService?: QualityIssueHandoffService) {
    let store: QualityStore | null = null;
    if (backendId) {
      try { store = await QualityStore.create(path.join(directory, "evidence.sqlite"), backendId); }
      catch { logger.warn("quality.initialize.failed"); }
    }
    const desktopDirectory = settingText("storage.qualityDesktopLogDirectory");
    const readers = store && backendId ? [new QualityLogReader(store, backendId, logDirectory, projectForTerminal), ...(desktopDirectory ? [new QualityLogReader(store, backendId, desktopDirectory, projectForTerminal, "desktop")] : [])] : [];
    return new QualityRuntime(new QualityService(backendId, store, projectForTerminal, Boolean(desktopDirectory), handoffService), store, readers);
  }
  start() {
    if (this.timer || this.stopped || !this.readers.length) return;
    const poll = () => { if (!this.running) this.running = Promise.allSettled(this.readers.map(reader => reader.poll())).then(results => { if (results.some(result => result.status === "rejected")) logger.warn("quality.log_read.failed"); }).finally(() => { this.running = undefined; }); };
    poll(); this.timer = setInterval(poll, 30_000); this.timer.unref();
  }
  async dispose() { this.stopped = true; if (this.timer) clearInterval(this.timer); await this.running; await this.store?.dispose(); }
}

export async function createQualityRuntime(resources: import("../bootstrap/resource-scope").ResourceScope, paths: import("../utils/path").StoragePaths, identity: import("../auth/connection-identity").ConnectionIdentityService, manager: import("../terminal/manager/manager").TerminalSessionManager, handoffDeps?: { options: TerminalSessionCreationOptions; attachments?: TerminalTextAttachmentDelivery }) {
  const handoff = handoffDeps ? new QualityIssueHandoffService(manager, handoffDeps.options, handoffDeps.attachments) : undefined;
  const runtime = await QualityRuntime.create(paths.qualityWorkflowDir, paths.backendLogDir, identity.identity()?.identityId ?? null,
    id => { const terminal = manager.getSession(id); return terminal ? terminal.projectId ?? null : undefined; }, handoff);
  resources.defer("quality-workflow", () => runtime.dispose());
  return runtime;
}
