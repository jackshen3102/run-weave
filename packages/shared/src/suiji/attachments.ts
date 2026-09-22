export type UploadedAttachment = {
  id: string;
  kind: "image" | "markdown";
  fileName: string;
  mimeType: string;
  byteSize: number;
};
export type SuijiAttachment = UploadedAttachment & { position: number };
