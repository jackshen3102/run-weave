exports.up = (pgm) => pgm.sql(`
CREATE TABLE mcp_credentials (
 id uuid PRIMARY KEY,
 owner_id uuid NOT NULL REFERENCES owners(id),
 name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80 AND name = btrim(name)),
 token_sha256 text NOT NULL UNIQUE CHECK (token_sha256 ~ '^[a-f0-9]{64}$'),
 created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz(3) NOT NULL,
 revoked_at timestamptz(3),
 last_used_at timestamptz(3),
 source text NOT NULL CHECK (source IN ('generated','legacy-import'))
);
`);
exports.down = false;
