/** A bounded SAX projection of Codex JSONL. Unselected strings (including base64 images)
 * are consumed without buffering. Offsets are byte positions in the original source. */
import { StringDecoder } from "node:string_decoder";

type Frame = {
  kind: "object" | "array";
  path: string[];
  key: string;
  index: number;
  state: "key" | "colon" | "value" | "comma";
};
const LIMIT = 180_000;
export class SemanticJsonStream {
  private decoder = new StringDecoder("utf8");
  private frames: Frame[] = [];
  private mode: "string" | "primitive" | null = null;
  private escaped = false;
  private unicodeRemaining = 0;
  private keyToken = false;
  private wanted = false;
  private token = "";
  private tokenPath: string[] = [];
  private output: Record<string, unknown> = {};
  private textBytes = 0;
  private malformed = false;
  private complete = false;
  private offset = 0;
  private position = 0;
  private stringBytes = 0;
  constructor(
    private consume: (record: Record<string, unknown>, offset: number) => void,
    offset = 0,
  ) {
    this.offset = this.position = offset;
  }
  setConsumer(
    consume: (record: Record<string, unknown>, offset: number) => void,
  ) {
    this.consume = consume;
  }
  feed(bytes: Buffer) {
    // Newline bytes cannot occur inside a valid JSON string. Splitting here also gives exact offsets.
    let start = 0;
    for (
      let end = bytes.indexOf(10);
      end !== -1;
      end = bytes.indexOf(10, start)
    ) {
      this.characters(this.decoder.write(bytes.subarray(start, end)));
      this.position += end - start + 1;
      if (this.mode === "primitive") this.finishToken();
      if (!this.malformed && this.complete && !this.mode && !this.frames.length)
        this.consume(this.output, this.offset);
      else if (this.textBytes || this.frames.length || this.mode)
        this.consume({ type: "runweave_invalid_record" }, this.offset);
      this.reset();
      start = end + 1;
    }
    this.characters(this.decoder.write(bytes.subarray(start)));
    this.position += bytes.length - start;
  }
  get committedOffset() {
    return this.offset;
  }
  private reset() {
    this.decoder = new StringDecoder("utf8");
    this.frames = [];
    this.mode = null;
    this.escaped = false;
    this.unicodeRemaining = 0;
    this.token = "";
    this.output = {};
    this.textBytes = 0;
    this.malformed = false;
    this.complete = false;
    this.offset = this.position;
  }
  private valuePath() {
    const frame = this.frames.at(-1);
    return frame
      ? [
          ...frame.path,
          frame.kind === "array" ? String(frame.index) : frame.key,
        ]
      : [];
  }
  private selected(parts: string[]) {
    const path = parts.join(".");
    return /^(type|timestamp|payload\.(type|id|role|phase|channel|turn_id|turnId|content)|payload\.content\.\d+\.(type|text)|payload\.error\.(message|codex_error_info))$/.test(
      path,
    );
  }
  private put(parts: string[], value: unknown) {
    if (!this.selected(parts)) return;
    if (
      parts[1] === "content" &&
      parts.at(-1) === "type" &&
      !["text", "input_text", "output_text"].includes(String(value))
    )
      return;
    this.textBytes += Buffer.byteLength(JSON.stringify(value));
    if (this.textBytes > LIMIT) {
      this.output = { type: "runweave_text_too_large" };
      return;
    }
    let target: Record<string, unknown> = this.output;
    for (const part of parts.slice(0, -1))
      target = (target[part] ??= {}) as Record<string, unknown>;
    target[parts.at(-1)!] = value;
  }
  private valueDone() {
    const frame = this.frames.at(-1);
    if (frame) {
      frame.state = "comma";
      frame.index++;
    } else this.complete = true;
  }
  private finishToken() {
    try {
      const value = JSON.parse(this.token) as unknown;
      if (this.keyToken) {
        const frame = this.frames.at(-1)!;
        frame.key = String(value);
        frame.state = "colon";
      } else {
        if (this.wanted) this.put(this.tokenPath, value);
        this.valueDone();
      }
    } catch {
      this.malformed = true;
    }
    this.mode = null;
    this.token = "";
  }
  private characters(text: string) {
    for (const character of text) {
      if (this.malformed) continue;
      if (this.mode === "string") {
        if (this.wanted || this.keyToken) {
          this.stringBytes += Buffer.byteLength(character);
          if (this.stringBytes > (this.keyToken ? 1024 : LIMIT)) {
            if (this.keyToken) {
              this.malformed = true;
              continue;
            }
            this.wanted = false;
            this.token = "";
            this.put(this.tokenPath, "[runweave:source_text_exceeds_budget]");
          } else this.token += character;
        }
        if (this.unicodeRemaining) {
          if (!/[0-9a-f]/i.test(character)) this.malformed = true;
          this.unicodeRemaining--;
          continue;
        }
        if (this.escaped) {
          if (character === "u") this.unicodeRemaining = 4;
          else if (
            !['"', "\\", "/", "b", "f", "n", "r", "t"].includes(character)
          )
            this.malformed = true;
          this.escaped = false;
          continue;
        }
        if (character.charCodeAt(0) < 32) {
          this.malformed = true;
          continue;
        }
        if (character === "\\") {
          this.escaped = true;
          continue;
        }
        if (character === '"') {
          if (this.wanted || this.keyToken) this.finishToken();
          else {
            this.mode = null;
            this.valueDone();
          }
        }
        continue;
      }
      if (this.mode === "primitive") {
        if (!/[\s,}\]]/.test(character)) {
          this.token += character;
          if (this.token.length > 128) this.malformed = true;
          continue;
        }
        this.finishToken();
      }
      if (/\s/.test(character)) continue;
      const frame = this.frames.at(-1);
      if (character === '"') {
        this.keyToken = frame?.kind === "object" && frame.state === "key";
        if (!this.keyToken && frame && frame.state !== "value") {
          this.malformed = true;
          continue;
        }
        this.tokenPath = this.valuePath();
        this.wanted = !this.keyToken && this.selected(this.tokenPath);
        this.mode = "string";
        this.escaped = false;
        this.stringBytes = 1;
        this.token = this.wanted || this.keyToken ? '"' : "";
      } else if (character === "{" || character === "[") {
        if (
          (frame && frame.state !== "value") ||
          this.frames.length > 64 ||
          (!frame && this.complete)
        ) {
          this.malformed = true;
          continue;
        }
        this.frames.push({
          kind: character === "{" ? "object" : "array",
          path: this.valuePath(),
          key: "",
          index: 0,
          state: character === "{" ? "key" : "value",
        });
      } else if (character === "}" || character === "]") {
        if (
          !frame ||
          (character === "}"
            ? frame.kind !== "object"
            : frame.kind !== "array") ||
          !(
            frame.state === "comma" ||
            (frame.index === 0 &&
              (frame.kind === "object"
                ? frame.state === "key"
                : frame.state === "value"))
          )
        ) {
          this.malformed = true;
          continue;
        }
        this.frames.pop();
        this.valueDone();
      } else if (character === ":") {
        if (frame?.state !== "colon") this.malformed = true;
        else frame.state = "value";
      } else if (character === ",") {
        if (frame?.state !== "comma") this.malformed = true;
        else frame.state = frame.kind === "object" ? "key" : "value";
      } else {
        if (!frame || frame.state !== "value") {
          this.malformed = true;
          continue;
        }
        this.mode = "primitive";
        this.keyToken = false;
        this.tokenPath = this.valuePath();
        this.wanted = this.selected(this.tokenPath);
        this.token = character;
      }
    }
  }
}
