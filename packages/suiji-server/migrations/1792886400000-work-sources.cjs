exports.up = pgm => pgm.sql(`
CREATE TABLE work_sources (
 owner_id uuid NOT NULL REFERENCES owners(id), source_scope text NOT NULL,
 producer_id text NOT NULL, source_namespace text NOT NULL, name text NOT NULL,
 effective_from date NOT NULL, effective_to date,
 PRIMARY KEY(owner_id,source_scope,effective_from),
 CHECK(effective_to IS NULL OR effective_to > effective_from)
);
`);
exports.down = false;
