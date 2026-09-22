import type { InboxItem, InboxSource } from "@runweave/shared/knowledge-inbox";
import type { EvolutionRepository } from "@runweave/shared/evolution";
export type PublishedItem = Omit<
  InboxItem,
  | "stateVersion"
  | "processedAt"
  | "hasUpdate"
  | "availability"
  | "currentContentVersion"
>;
export interface InboxSourceReader {
  source: InboxSource;
  read(repositories: EvolutionRepository[]): Promise<PublishedItem[]>;
}
export class InboxError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
