exports.up = (pgm) => pgm.sql(`
ALTER TABLE mcp_credentials ADD COLUMN scope text NOT NULL DEFAULT 'read-write'
 CHECK(scope IN ('read-only','read-write'));
`);
exports.down = false;
