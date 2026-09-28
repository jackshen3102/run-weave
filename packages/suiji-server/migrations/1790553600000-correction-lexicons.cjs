exports.up = (pgm) => pgm.sql(`
CREATE TABLE correction_lexicons (
 owner_id uuid PRIMARY KEY REFERENCES owners(id),
 version integer NOT NULL CHECK(version > 0),
 entries jsonb NOT NULL CHECK(jsonb_typeof(entries) = 'array'),
 updated_at timestamptz(3) NOT NULL DEFAULT clock_timestamp()
);
`);
exports.down = false;
