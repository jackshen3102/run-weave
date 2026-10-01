export interface AppServerThreadPreview {
  threadId: string;
  provider: string;
  available: boolean;
  turnId: string | null;
  userText: string | null;
  agentText: string | null;
}

export interface AppServerThreadPreviewsResponse {
  previews: AppServerThreadPreview[];
}

/** A plain, bounded excerpt of actual message text, never a generated summary. */
export function formatThreadPreviewText(value: string | null | undefined): string | null {
  if (!value) return null;
  const text = value
    .replace(/<oai-mem-citation>[\s\S]*?<\/oai-mem-citation>/g, "")
    .replace(/```[^\n]*\n?/g, "")
    .replace(/!?\[([^\]]*)\]\([^\n]*?\)/g, "$1")
    .replace(/<[^>\n]+>/g, "")
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/gm, "")
    .replace(/(`+)([\s\S]*?)\1/g, "$2")
    .replace(/(\*\*|__|~~)([^\n]+?)\1/g, "$2")
    .replace(/\*([^*\n]+)\*/g, "$1")
    .replace(/(^|\s)_([^_\n]+)_(?=\s|[.,!?，。！？]|$)/g, "$1$2")
    .replace(/\s+/g, " ").trim();
  if (!text) return null;
  const characters: string[] = [];
  for (const part of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)) {
    if (characters.length === 120) return `${characters.join("")}…`;
    characters.push(part.segment);
  }
  return text;
}
