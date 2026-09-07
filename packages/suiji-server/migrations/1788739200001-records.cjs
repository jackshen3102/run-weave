exports.up = (pgm) => pgm.sql(`
CREATE TABLE records (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES owners(id),
 kind text NOT NULL CHECK (kind IN ('note','task')), body text NOT NULL CHECK (char_length(body) <= 20000),
 task_status text, version integer NOT NULL DEFAULT 1 CHECK (version > 0),
 created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
 created_via text NOT NULL CHECK (created_via IN ('app','agent')),
 UNIQUE (owner_id,id),
 CHECK ((kind='note' AND task_status IS NULL) OR (kind='task' AND task_status IS NOT NULL AND task_status IN ('open','done','archived')))
);
CREATE INDEX records_feed ON records (owner_id,created_at DESC,id DESC);
CREATE TABLE attachments (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES owners(id),
 bound_record_id uuid, object_key uuid NOT NULL UNIQUE,
 kind text NOT NULL CHECK (kind IN ('image','markdown')),
 file_name text NOT NULL, mime_type text NOT NULL, byte_size integer NOT NULL CHECK (byte_size > 0 AND byte_size <= 5242880),
 sha256 text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (owner_id,id), UNIQUE (owner_id,id,bound_record_id),
 FOREIGN KEY (owner_id,bound_record_id) REFERENCES records(owner_id,id)
);
CREATE TABLE record_attachments (
 owner_id uuid NOT NULL, record_id uuid NOT NULL, attachment_id uuid NOT NULL,
 position integer NOT NULL CHECK(position >= 0), PRIMARY KEY(owner_id,record_id,attachment_id),
 UNIQUE(owner_id,record_id,position),
 FOREIGN KEY(owner_id,record_id) REFERENCES records(owner_id,id),
 FOREIGN KEY(owner_id,attachment_id,record_id) REFERENCES attachments(owner_id,id,bound_record_id)
);
CREATE TABLE record_revisions (
 owner_id uuid NOT NULL, record_id uuid NOT NULL, version integer NOT NULL,
 snapshot jsonb NOT NULL, request_id uuid NOT NULL, actor text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(owner_id,record_id,version),
 FOREIGN KEY(owner_id,record_id) REFERENCES records(owner_id,id)
);
CREATE TABLE mutation_requests (
 owner_id uuid NOT NULL REFERENCES owners(id), idempotency_key text NOT NULL,
 request_hash text NOT NULL, operation text NOT NULL, request_id uuid NOT NULL,
 response jsonb, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(owner_id,idempotency_key)
);
`);
exports.down = false;
