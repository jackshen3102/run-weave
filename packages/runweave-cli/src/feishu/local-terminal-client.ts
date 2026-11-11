import {
  feishuAttachmentPrompt,
  type FeishuAttachment,
} from "@runweave/shared/feishu/bridge";
import type { SendTerminalInputRequest } from "@runweave/shared/terminal/input";
import type { TerminalHttpClient } from "../client/terminal-http-client.js";
import type { FeishuTerminalClient } from "./bridge-message-handler.js";

/** Save on the authenticated Backend, which may be on another machine. */
export class LocalFeishuTerminalClient implements FeishuTerminalClient {
  constructor(private readonly client: TerminalHttpClient) {}
  withSignal(signal: AbortSignal): LocalFeishuTerminalClient {
    return new LocalFeishuTerminalClient(this.client.withSignal(signal));
  }
  getSession(id: string) {
    return this.client.getSession(id);
  }
  async sendInput(
    id: string,
    input: SendTerminalInputRequest,
    attachment?: FeishuAttachment,
  ) {
    if (!attachment) return this.client.sendInput(id, input);
    const saved = await this.client.createClipboardFile(id, attachment);
    return this.client.sendInput(id, {
      ...input,
      data: feishuAttachmentPrompt(input.data, saved.filePath),
    });
  }
}
