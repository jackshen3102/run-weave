exports.up = (pgm) =>
  pgm.sql(`
ALTER TABLE records ADD COLUMN deleted_at timestamptz(3);
CREATE INDEX records_trash_feed ON records (owner_id,created_at DESC,id DESC) WHERE deleted_at IS NOT NULL;
`);
exports.down = false;
