import type { SessionSearchQuery } from "@runweave/shared/session-search";
import type { NativeSearchRoot } from "./scanner";
export interface SearchWorkerOptions { file: string; roots: NativeSearchRoot[] }
export type SearchWorkerCommand =
  | { op: "ready" | "status" | "refresh" | "close" }
  | { op: "search"; query: SessionSearchQuery & { repositoryId?: string } }
  | { op: "context"; id: string; noUpdate?: boolean };
export interface SearchWorkerRequest { id: number; command: SearchWorkerCommand }
export interface SearchWorkerResponse { id: number; value?: unknown; error?: string }
