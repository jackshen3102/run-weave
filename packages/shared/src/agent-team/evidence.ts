export interface AgentTeamAcceptanceEvidence {
  type:
    | "screenshot"
    | "dom"
    | "text"
    | "command"
    | "event"
    | "json"
    | "log"
    | "code";
  /** Short human-facing title, e.g. "状态推送". */
  label: string;
  /** One-line human-facing explanation. */
  summary: string;
  /** Optional extra detail for expanded evidence views. */
  detail?: string;
  /** Raw evidence pointer or text. */
  ref: string;
}
