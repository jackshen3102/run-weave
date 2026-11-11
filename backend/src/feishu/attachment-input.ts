import {
  feishuAttachmentPrompt,
  type FeishuRequest,
} from "@runweave/shared/feishu/bridge";
import { saveTerminalClipboardFile } from "../terminal/attachments/clipboard-file";

/** Materialize only on the executing Backend; never send a Hub filesystem path. */
export async function materializeFeishuInput(
  input: Extract<FeishuRequest, { type: "terminal.input" }>,
): Promise<string> {
  if (!input.attachment) return input.text;
  const saved = await saveTerminalClipboardFile(
    input.terminalSessionId,
    input.attachment.fileName,
    Buffer.from(input.attachment.dataBase64, "base64"),
  );
  return feishuAttachmentPrompt(input.text, saved.filePath);
}
