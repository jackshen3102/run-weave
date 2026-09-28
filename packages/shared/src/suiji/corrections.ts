export type CorrectionLexiconEntry = { canonical: string; variants: string[] };
export type CorrectionLexicon = { version: number; entries: CorrectionLexiconEntry[] };
export type CorrectionInput = { text: string };
export type CorrectionTerm = { variant: string; canonical: string };
export type SuijiCorrection = {
  id: string;
  status: "running" | "completed" | "failed" | "cancelled";
  createdAt: string;
  correctedText?: string;
  uncertainTerms?: string[];
  suggestedTerms?: CorrectionTerm[];
  lexiconVersion?: number;
  error?: string;
};
