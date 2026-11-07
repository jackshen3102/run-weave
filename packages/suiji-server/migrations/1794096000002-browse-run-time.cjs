exports.up = (pgm) => pgm.sql(`
ALTER TABLE browse_runs ADD COLUMN created_at timestamptz NOT NULL DEFAULT clock_timestamp();
CREATE INDEX browse_runs_recent ON browse_runs(owner_id,connection_id,created_at DESC);
`);
exports.down = false;
