export type CorrectionLexiconEntry = { canonical: string; variants: string[] };
export type CorrectionLexicon = { version: number; entries: CorrectionLexiconEntry[] };
export type CorrectionInput = { text: string; recordId?: string; feedbackCapable?: boolean };
export type CorrectionPreferences = { version: number; historyEnabled: boolean; learningEpoch: number };
export type CorrectionHistoryItem = {
  id: string; createdAt: string; finalizedAt: string;
  inputText: string; correctedText: string; finalText: string;
  recordId: string; recordVersion: number;
};
export type CorrectionHistoryPage = { items: CorrectionHistoryItem[]; nextCursor?: string };
export type CorrectionFeedback = { recordId: string; recordVersion: number; saveKey: string };

export type CorrectionTerm = { variant: string; canonical: string };
export type SuijiCorrection = {
  id: string;
  status: "running" | "completed" | "failed" | "cancelled";
  createdAt: string;
  historyId?: string;
  correctedText?: string;
  uncertainTerms?: string[];
  suggestedTerms?: CorrectionTerm[];
  lexiconVersion?: number;
  error?: string;
};
