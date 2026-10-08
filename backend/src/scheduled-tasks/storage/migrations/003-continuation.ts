// Applied migrations are immutable.
export const continuationSql = `
CREATE TABLE scheduled_run_attempts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES scheduled_runs(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  owner_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  UNIQUE(run_id, sequence)
);
`;
