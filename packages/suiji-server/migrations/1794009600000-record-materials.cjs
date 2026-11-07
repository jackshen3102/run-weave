exports.up = (pgm) => pgm.sql(`
-- Capture identities survive removing the material category and trashing records.
CREATE TABLE material_captures (
 owner_id uuid NOT NULL, capture_id uuid NOT NULL, record_id uuid NOT NULL,
 PRIMARY KEY(owner_id,capture_id),
 FOREIGN KEY(owner_id,record_id) REFERENCES records(owner_id,id)
);
CREATE TABLE record_materials (
 owner_id uuid NOT NULL, record_id uuid NOT NULL, capture_id uuid NOT NULL,
 captured_at timestamptz(3) NOT NULL, material_date date NOT NULL,
 input_type text NOT NULL CHECK(input_type IN ('image','text','link')), source_url text,
 processed_version integer, processed_at timestamptz(3),
 PRIMARY KEY(owner_id,record_id),
 FOREIGN KEY(owner_id,record_id) REFERENCES records(owner_id,id),
 FOREIGN KEY(owner_id,capture_id) REFERENCES material_captures(owner_id,capture_id)
);
CREATE INDEX record_materials_feed ON record_materials(owner_id,material_date DESC,captured_at DESC,record_id DESC);
CREATE TABLE material_results (
 owner_id uuid NOT NULL, record_id uuid NOT NULL, record_version integer NOT NULL,
 source_hash text NOT NULL, outcome text NOT NULL CHECK(outcome IN ('included','merged','no-new-fact')),
 event_keys jsonb NOT NULL, import_id uuid NOT NULL, processed_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(owner_id,record_id,record_version),
 FOREIGN KEY(owner_id,record_id) REFERENCES records(owner_id,id)
);
`);
exports.down = false;
