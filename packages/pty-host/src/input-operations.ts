import { createHash } from "node:crypto";
import type { PtyHostInput, PtyHostInputResult } from "@runweave/shared/terminal/pty-host";

interface Operation {
  digest: string;
  acceptedAt: number;
  result: PtyHostInputResult;
  done: Promise<PtyHostInputResult>;
}

/** Lives in the Host, so Backend death cannot interrupt a text/delay/Enter sequence. */
export class InputOperations {
  private readonly operations = new Map<string, Operation>();
  private readonly sequences = new Map<number, string>();
  private retiredThrough = 0;
  private highest = 0;
  private structuredCount = 0;
  private readonly expiredIds = new Set<string>();
  private pending = 0;
  private pendingBytes = 0;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly write: (data: string) => void, private readonly isRunning: () => boolean) {}

  get nextSequence(): number { return this.highest + 1; }

  get(operationId: string): PtyHostInputResult | null {
    this.prune();
    if (this.expiredIds.has(this.key(operationId)) || this.rawSequence(operationId) <= this.retiredThrough) throw new Error("HOST_INPUT_EXPIRED");
    return this.operations.get(operationId)?.result ?? null;
  }

  submit(input: PtyHostInput): Operation {
    if (!input || typeof input.operationId !== "string" || input.operationId.length < 1 || input.operationId.length > 256 ||
      !Number.isSafeInteger(input.sequence) || input.sequence < 1 || !Array.isArray(input.steps) || input.steps.length > 64)
      throw new Error("HOST_INPUT_INVALID");
    let bytes = 0, delay = 0;
    for (const step of input.steps) {
      if (step.type === "text" && typeof step.data === "string") bytes += Buffer.byteLength(step.data);
      else if (step.type === "delay" && Number.isInteger(step.ms) && step.ms >= 0 && step.ms <= 1000) delay += step.ms;
      else throw new Error("HOST_INPUT_INVALID");
    }
    if (bytes > 1024 * 1024 || delay > 5000) throw new Error("HOST_INPUT_INVALID");
    const rawSequence = this.rawSequence(input.operationId);
    if (rawSequence !== Infinity && rawSequence !== input.sequence) throw new Error("HOST_INPUT_INVALID");
    const digest = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    this.prune();
    const previous = this.operations.get(input.operationId);
    if (previous) {
      if (previous.digest !== digest) throw new Error("HOST_INPUT_CONFLICT");
      return previous;
    }
    if (this.expiredIds.has(this.key(input.operationId)) || input.sequence <= this.retiredThrough) throw new Error("HOST_INPUT_EXPIRED");
    if (input.sequence <= this.highest || this.sequences.has(input.sequence)) throw new Error("HOST_INPUT_CONFLICT");
    if (input.sequence !== this.highest + 1) throw new Error("HOST_INPUT_SEQUENCE_GAP");
    if (rawSequence === Infinity && this.structuredCount >= 65536) throw new Error("HOST_INPUT_HISTORY_FULL");
    if (this.pending >= 128 || this.pendingBytes + bytes > 4 * 1024 * 1024) throw new Error("HOST_BUSY");
    if (rawSequence === Infinity) this.structuredCount++;
    this.highest = input.sequence;
    this.pending++;
    this.pendingBytes += bytes;
    const operation: Operation = {
      digest, acceptedAt: Date.now(),
      result: { operationId: input.operationId, sequence: input.sequence, state: "accepted" },
      done: Promise.resolve(null as unknown as PtyHostInputResult),
    };
    this.operations.set(input.operationId, operation);
    this.sequences.set(input.sequence, input.operationId);
    operation.done = this.tail.then(async () => {
      try {
        for (const step of input.steps) {
          if (!this.isRunning()) throw new Error("HOST_SESSION_GONE");
          if (step.type === "text") this.write(step.data);
          else await new Promise(resolve => setTimeout(resolve, step.ms));
        }
        operation.result.state = "written";
      } catch (error) {
        operation.result.state = "failed";
        operation.result.error = (error as Error).message;
      } finally { this.pending--; this.pendingBytes -= bytes; }
      return operation.result;
    });
    this.tail = operation.done;
    return operation;
  }

  private key(id: string): string { return createHash("sha256").update(id).digest("hex").slice(0, 32); }
  private rawSequence(id: string): number {
    const value = /^raw:[a-f0-9-]{36}:(\d+)$/.exec(id)?.[1];
    return value ? Number(value) : Infinity;
  }
  private prune(): void {
    for (const [sequence, id] of this.sequences) {
      const entry = this.operations.get(id)!;
      if (entry.result.state === "accepted") break;
      if (this.operations.size <= 10000 && Date.now() - entry.acceptedAt < 86_400_000) break;
      this.retiredThrough = sequence;
      if (this.rawSequence(id) === Infinity) this.expiredIds.add(this.key(id));
      this.operations.delete(id);
      this.sequences.delete(sequence);
    }
  }
}
