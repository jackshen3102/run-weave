// Applied migrations are immutable. Existing output becomes one byte-exact chunk per run.
export const outputChunksSql = `
CREATE TABLE scheduled_run_output_chunks (
  run_id TEXT NOT NULL REFERENCES scheduled_runs(id) ON DELETE CASCADE,
  end_byte INTEGER NOT NULL,
  content BLOB NOT NULL,
  PRIMARY KEY(run_id, end_byte),
  CHECK(length(content) > 0 AND end_byte >= length(content))
);
INSERT INTO scheduled_run_output_chunks(run_id, end_byte, content)
  SELECT run_id, length(CAST(content AS BLOB)), CAST(content AS BLOB)
  FROM scheduled_run_output WHERE length(CAST(content AS BLOB)) > 0;
DROP TABLE scheduled_run_output;
`;
