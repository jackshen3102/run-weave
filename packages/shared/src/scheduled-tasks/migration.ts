export interface ScheduledTaskMigrationItem {
  id: string;
  revision: number;
  originalPrompt: string;
  prompt: string;
  promptWarning: string | null;
  originalProject: { id: string | null; name: string | null; path: string | null };
  enabled: boolean;
  deletedAt: string | null;
  action: "pause-and-convert" | "preserve-deleted" | "convert-quick-origin";
}
export interface ScheduledTaskMigrationPreview {
  state: "migration_required" | "current";
  schemaVersion: number;
  targetContextVersion: 2;
  databaseDigest: string;
  tasks: ScheduledTaskMigrationItem[];
}
export interface ApplyScheduledTaskMigrationRequest {
  expectedDatabaseDigest: string;
  tasks: Array<{ id: string; expectedRevision: number; prompt: string }>;
}
export interface ScheduledTaskMigrationReceipt {
  migrationId: string;
  sourceVersion: number;
  targetVersion: number;
  changedTaskIds: string[];
  backupPath: string;
  completedAt: string;
  restartRequired: true;
}
