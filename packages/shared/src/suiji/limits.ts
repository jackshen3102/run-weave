export const SUIJI_LIMITS = {
  bodyScalars: 20_000,
  attachmentBytes: 5 * 1024 * 1024,
  imagesPerRecord: 1,
  markdownPerRecord: 1,
  defaultPageSize: 20,
  maxPageSize: 100,
} as const;
export const SUIJI_PROTOCOL_VERSION = 1;
