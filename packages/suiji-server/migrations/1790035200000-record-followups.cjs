exports.up = (pgm) => pgm.sql(`
CREATE TABLE record_followups (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL, record_id uuid NOT NULL,
 sequence integer NOT NULL CHECK(sequence > 0),
 body text NOT NULL CHECK(char_length(body) <= 20000),
 actor text NOT NULL CHECK(actor IN ('app','agent')),
 agent_name text, session_id text,
 created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(owner_id,record_id,sequence), UNIQUE(owner_id,record_id,id),
 FOREIGN KEY(owner_id,record_id) REFERENCES records(owner_id,id)
);
CREATE TABLE followup_attachments (
 owner_id uuid NOT NULL, record_id uuid NOT NULL, followup_id uuid NOT NULL,
 attachment_id uuid NOT NULL, position integer NOT NULL CHECK(position >= 0),
 PRIMARY KEY(owner_id,followup_id,attachment_id), UNIQUE(owner_id,followup_id,position),
 FOREIGN KEY(owner_id,record_id,followup_id) REFERENCES record_followups(owner_id,record_id,id),
 FOREIGN KEY(owner_id,attachment_id,record_id) REFERENCES attachments(owner_id,id,bound_record_id)
);
`);
exports.down = false;
