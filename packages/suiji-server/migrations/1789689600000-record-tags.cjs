exports.up = (pgm) =>
  pgm.sql(`
ALTER TABLE records ADD COLUMN tags text[] NOT NULL DEFAULT '{}';
ALTER TABLE records ADD CONSTRAINT records_tags_limit CHECK (cardinality(tags) <= 2);
`);
exports.down = false;
