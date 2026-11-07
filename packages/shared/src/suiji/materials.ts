/** User supplied capture identity; business dates use Asia/Shanghai. */
export type MaterialInput = {
  captureId: string;
  capturedAt: string;
  materialDate: string;
  inputType: "image" | "text" | "link";
  sourceUrl?: string;
};
export type MaterialMetadata = MaterialInput & {
  sourceHash: string;
  processedVersion: number | null;
  processedAt: string | null;
};
export type MaterialResult = {
  recordId: string;
  recordVersion: number;
  sourceHash: string;
  outcome: "included" | "merged" | "no-new-fact";
  eventKeys: string[];
};
