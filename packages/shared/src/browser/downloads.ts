export interface BrowserDownloadSnapshot {
  id: string;
  targetId: string;
  filename: string;
  mimeType: string;
  state: "progressing" | "completed" | "cancelled" | "interrupted";
  receivedBytes: number;
  totalBytes: number;
  createdAt: number;
}

export interface BrowserDownloadChunk {
  id: string;
  offset: number;
  nextOffset: number;
  totalBytes: number;
  dataBase64: string;
  eof: boolean;
}
