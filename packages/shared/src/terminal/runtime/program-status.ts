export type TerminalProgramStatusState = "starting" | "idle" | "working" | "blocked" | "done" | "error";
export type TerminalProgramStatusKind = "permission" | "question" | "auth";

export interface TerminalProgramStatus {
  state: TerminalProgramStatusState;
  source: "osc" | "hook";
  observedAt?: string;
  kind?: TerminalProgramStatusKind;
}

export interface ProgramStatusReport {
  state: Exclude<TerminalProgramStatusState, "starting"> | "clear";
  id: string;
  app?: string;
  kind?: TerminalProgramStatusKind;
}

const MAX_RECORDS = 256;

export function updateProgramStatusRecords(records: Map<string, ProgramStatusReport>, report: ProgramStatusReport): void {
  if (report.app && report.app !== "codex") return;
  if (report.state === "clear") {
    for (const id of records.keys()) {
      if (!report.id || id === report.id || id.startsWith(`${report.id}/`)) records.delete(id);
    }
    return;
  }
  records.delete(report.id);
  records.set(report.id, report);
  if (records.size > MAX_RECORDS) {
    const oldestChild = Array.from(records.keys()).find(Boolean);
    if (oldestChild) records.delete(oldestChild);
  }
}

export function resolveProgramStatus(records: Map<string, ProgramStatusReport>) {
  const root = records.get("");
  const active = Array.from(records.values());
  const report = active.find(item => item.state === "blocked") ??
    active.find(item => item.state === "working") ?? root;
  if (!report || report.state === "clear") return undefined;
  return { state: report.state, kind: report.kind };
}

const PREFIX = "\x1b]7501;";
const MAX_SEQUENCE_BYTES = 4096;
const STATES = new Set<string>(["idle", "working", "blocked", "done", "error", "clear"]);
const KINDS = new Set<string>(["permission", "question", "auth"]);
const textDecoder = new TextDecoder("utf-8", { fatal: true });

function isStatusText(value: string, encodedLimit: number, decodedLimit: number): boolean {
  if (value.length > encodedLimit) return false;
  try {
    const bytes = atob(value);
    // Status text excludes C0 and C1 terminal control characters.
    return bytes.length <= decodedLimit &&
      // eslint-disable-next-line no-control-regex
      !/[\u0000-\u001f\u007f-\u009f]/u.test(textDecoder.decode(Uint8Array.from(bytes, char => char.charCodeAt(0))));
  } catch {
    return false;
  }
}

function parseReport(body: string): ProgramStatusReport | undefined {
  const fields = new Map<string, string>();
  for (const pair of body.split(":")) {
    const match = /^([a-z]{1,16})\s*=\s*([A-Za-z0-9_.,+/=-]*)$/u.exec(pair.trim());
    if (!match || fields.has(match[1]!)) return undefined;
    fields.set(match[1]!, match[2]!);
  }
  const state = fields.get("state");
  const id = fields.get("id") ?? "";
  if (!state || !STATES.has(state) || (fields.has("id") &&
    (id.length > 128 || !/^[A-Za-z0-9_.+-]{1,32}(?:\/[A-Za-z0-9_.+-]{1,32}){0,7}$/u.test(id)))) return undefined;
  const msg = fields.get("msg");
  const title = fields.get("title");
  if ((msg !== undefined && !isStatusText(msg, 2732, 2048)) ||
    (title !== undefined && !isStatusText(title, 256, 192))) return undefined;
  const app = fields.get("app");
  const kind = fields.get("kind");
  return {
    state: state as ProgramStatusReport["state"], id,
    app: app && /^[A-Za-z0-9_.+-]{1,32}$/u.test(app) ? app : undefined,
    kind: state === "blocked" && kind && KINDS.has(kind) ? kind as TerminalProgramStatusKind : undefined,
  };
}

/** Strips OSC 7501 before output is retained and reports only complete frames. */
export class ProgramStatusStream {
  private pending = "";
  private discardingSequence = false;

  write(chunk: string, report: (value: ProgramStatusReport) => void): string {
    const input = this.pending + chunk;
    this.pending = "";
    let offset = 0;
    let output = "";
    // OSC frames end with BEL or the ESC-prefixed string terminator.
    // eslint-disable-next-line no-control-regex
    const controls = /[\x07\x1b]/gu;
    while (offset < input.length) {
      const start = this.discardingSequence ? offset : input.indexOf(PREFIX, offset);
      if (start < 0) {
        let end = input.length;
        const escape = input.lastIndexOf("\x1b");
        if (escape >= offset && PREFIX.startsWith(input.slice(escape))) {
          end = escape;
          this.pending = input.slice(escape);
        }
        return output + input.slice(offset, end);
      }
      output += input.slice(offset, start);
      const bodyStart = this.discardingSequence ? start : start + PREFIX.length;
      controls.lastIndex = bodyStart;
      const control = controls.exec(input);
      if (!control || (control[0] === "\x1b" && control.index === input.length - 1)) {
        this.discardingSequence ||= input.length - start >= MAX_SEQUENCE_BYTES;
        this.pending = this.discardingSequence ? (control?.[0] ?? "") : input.slice(start);
        break;
      }
      const terminator = control[0] === "\x07" ? 1 : input[control.index + 1] === "\\" ? 2 : 0;
      if (!this.discardingSequence && terminator && control.index + terminator - start <= MAX_SEQUENCE_BYTES) {
        const value = parseReport(input.slice(bodyStart, control.index));
        if (value) report(value);
      }
      this.discardingSequence = false;
      offset = control.index + terminator;
    }
    return output;
  }
}

const PRIORITY: Record<TerminalProgramStatusState, number> = {
  blocked: 4, working: 3, error: 2, done: 2, starting: 1, idle: 0,
};

export function aggregateProgramStatus(panels: readonly {
  panelId: string;
  status: "running" | "exited";
  programStatus?: TerminalProgramStatus;
}[]): TerminalProgramStatus | undefined {
  let selected: (typeof panels)[number] | undefined;
  for (const panel of panels) {
    const candidate = panel.programStatus;
    if (panel.status !== "running" || !candidate) continue;
    const current = selected?.programStatus;
    if (!current || PRIORITY[candidate.state] > PRIORITY[current.state] ||
      (PRIORITY[candidate.state] === PRIORITY[current.state] &&
        ((candidate.observedAt ?? "") > (current.observedAt ?? "") ||
          (candidate.observedAt === current.observedAt && panel.panelId < selected!.panelId)))) selected = panel;
  }
  return selected?.programStatus;
}
