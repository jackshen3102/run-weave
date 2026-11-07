exports.up = (pgm) =>
  pgm.sql(`
ALTER TABLE mcp_credentials ADD COLUMN domain text NOT NULL DEFAULT 'records' CHECK(domain IN ('records','browse'));
CREATE TABLE browse_heads (
 owner_id uuid PRIMARY KEY REFERENCES owners(id), revision bigint NOT NULL DEFAULT 0
);
CREATE TABLE browse_connections (
 owner_id uuid NOT NULL REFERENCES owners(id), id uuid NOT NULL,
 provider text NOT NULL, external_account_id text NOT NULL,
 machine text NOT NULL, profile text NOT NULL, browser_group text NOT NULL,
 state text NOT NULL CHECK(state IN ('active','disabled')), last_success_at timestamptz,
 PRIMARY KEY(owner_id,id)
);
CREATE TABLE browse_entries (
 owner_id uuid NOT NULL REFERENCES owners(id), id uuid NOT NULL,
 capture_id uuid NOT NULL, capture_hash text NOT NULL, version integer NOT NULL DEFAULT 1 CHECK(version>0),
 browse_date date NOT NULL, occurred_at timestamptz(3), captured_at timestamptz(3) NOT NULL,
 title text NOT NULL, body text NOT NULL, user_note text NOT NULL,
 source jsonb NOT NULL, content_type text NOT NULL, capture_method text NOT NULL,
 source_url text, content_state jsonb NOT NULL, content_hash text NOT NULL,
 connection_id uuid, external_content_type text, external_content_id text,
 deleted_at timestamptz(3), PRIMARY KEY(owner_id,id), UNIQUE(owner_id,capture_id),
 FOREIGN KEY(owner_id,connection_id) REFERENCES browse_connections(owner_id,id),
 UNIQUE(owner_id,connection_id,external_content_type,external_content_id,browse_date)
);
CREATE INDEX browse_feed ON browse_entries(owner_id,browse_date DESC,coalesce(occurred_at,captured_at) DESC,id DESC);
ALTER TABLE attachments ADD COLUMN bound_browse_id uuid;
ALTER TABLE attachments ADD CONSTRAINT attachments_browse_fk FOREIGN KEY(owner_id,bound_browse_id) REFERENCES browse_entries(owner_id,id);
ALTER TABLE attachments ADD CONSTRAINT attachments_one_domain CHECK(bound_record_id IS NULL OR bound_browse_id IS NULL);
ALTER TABLE attachments ADD CONSTRAINT attachments_browse_unique UNIQUE(owner_id,id,bound_browse_id);
CREATE TABLE browse_attachments (
 owner_id uuid NOT NULL, entry_id uuid NOT NULL, attachment_id uuid NOT NULL, position integer NOT NULL CHECK(position>=0),
 PRIMARY KEY(owner_id,entry_id,attachment_id), UNIQUE(owner_id,entry_id,position),
 FOREIGN KEY(owner_id,entry_id) REFERENCES browse_entries(owner_id,id),
 FOREIGN KEY(owner_id,attachment_id,entry_id) REFERENCES attachments(owner_id,id,bound_browse_id)
);
CREATE TABLE browse_revisions (
 owner_id uuid NOT NULL, entry_id uuid NOT NULL, version integer NOT NULL, snapshot jsonb NOT NULL,
 PRIMARY KEY(owner_id,entry_id,version), FOREIGN KEY(owner_id,entry_id) REFERENCES browse_entries(owner_id,id)
);
CREATE TABLE browse_changes (
 owner_id uuid NOT NULL, revision bigint NOT NULL, entry_id uuid, digest_id uuid, kind text NOT NULL CHECK(kind IN ('entry','digest')), version integer NOT NULL, deleted boolean NOT NULL,
 CHECK ((entry_id IS NOT NULL AND digest_id IS NULL AND kind='entry') OR (entry_id IS NULL AND digest_id IS NOT NULL AND kind='digest')),
 PRIMARY KEY(owner_id,revision), FOREIGN KEY(owner_id,entry_id) REFERENCES browse_entries(owner_id,id)
);
CREATE TABLE browse_runs (
 owner_id uuid NOT NULL, run_id uuid NOT NULL, connection_id uuid NOT NULL, request_hash text NOT NULL,
 from_date date NOT NULL, to_date date NOT NULL, coverage jsonb NOT NULL, receipt jsonb NOT NULL,
 PRIMARY KEY(owner_id,run_id), FOREIGN KEY(owner_id,connection_id) REFERENCES browse_connections(owner_id,id)
);
CREATE TABLE browse_observations (
 owner_id uuid NOT NULL, run_id uuid NOT NULL, entry_id uuid NOT NULL,
 content_type text NOT NULL, content_id text NOT NULL, read_time timestamptz(3) NOT NULL, observed_at timestamptz(3) NOT NULL,
 PRIMARY KEY(owner_id,run_id,content_type,content_id,read_time),
 FOREIGN KEY(owner_id,run_id) REFERENCES browse_runs(owner_id,run_id),
 FOREIGN KEY(owner_id,entry_id) REFERENCES browse_entries(owner_id,id)
);
CREATE TABLE browse_digests (
 owner_id uuid NOT NULL, id uuid NOT NULL, digest_date date NOT NULL, connection_id uuid NOT NULL,
 title text NOT NULL, body text NOT NULL, version integer NOT NULL DEFAULT 1,
 entry_refs jsonb NOT NULL, input_revision bigint NOT NULL, state text NOT NULL CHECK(state IN ('current','stale')),
 PRIMARY KEY(owner_id,id), UNIQUE(owner_id,digest_date,connection_id),
 FOREIGN KEY(owner_id,connection_id) REFERENCES browse_connections(owner_id,id)
);
ALTER TABLE browse_changes ADD FOREIGN KEY(owner_id,digest_id) REFERENCES browse_digests(owner_id,id);
`);
exports.down = false;
