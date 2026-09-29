exports.up = (pgm) => pgm.sql(`
CREATE TABLE correction_preferences (
 owner_id uuid PRIMARY KEY REFERENCES owners(id),
 version integer NOT NULL DEFAULT 0,
 history_enabled boolean NOT NULL DEFAULT false,
 learning_epoch integer NOT NULL DEFAULT 0,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE correction_history (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES owners(id),
 correction_id uuid NOT NULL, input_text text NOT NULL, corrected_text text NOT NULL,
 final_text text, record_id uuid, record_version integer, save_key text,
 learning_epoch integer NOT NULL, status text NOT NULL CHECK(status IN ('pending','finalized','deleted')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 finalized_at timestamptz,
 UNIQUE(owner_id,correction_id),
 FOREIGN KEY(owner_id,record_id) REFERENCES records(owner_id,id)
);
CREATE INDEX correction_history_owner_recent ON correction_history(owner_id,created_at DESC,id DESC);
`);
exports.down = false;
