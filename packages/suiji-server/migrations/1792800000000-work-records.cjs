exports.up = (pgm) => pgm.sql(`
CREATE TABLE work_feed_heads (
 owner_id uuid PRIMARY KEY REFERENCES owners(id), revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0)
);
CREATE TABLE work_facts (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES owners(id), event_key text NOT NULL,
 work_date date NOT NULL, title text NOT NULL CHECK(char_length(title) BETWEEN 1 AND 80),
 statement text NOT NULL CHECK(char_length(statement) BETWEEN 1 AND 4000),
 status text NOT NULL CHECK(status IN ('progress','discussed','documented','attempted','agent-reported','verified')),
 project text CHECK(char_length(project) BETWEEN 1 AND 80), version integer NOT NULL DEFAULT 1 CHECK(version>0),
 created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
 created_via text NOT NULL CHECK(created_via IN ('app','agent')), manual_fields jsonb NOT NULL DEFAULT '[]',
 source_namespace text, external_key text, source_snapshot jsonb, source_hash text, source_collected_at timestamptz,
 UNIQUE(owner_id,id), UNIQUE(owner_id,source_namespace,external_key),
 CHECK((source_namespace IS NULL)=(external_key IS NULL))
);
CREATE INDEX work_facts_feed ON work_facts(owner_id,work_date DESC,created_at DESC,id DESC);
CREATE TABLE work_fact_revisions (
 owner_id uuid NOT NULL, fact_id uuid NOT NULL, version integer NOT NULL, snapshot jsonb NOT NULL,
 actor text NOT NULL CHECK(actor IN ('app','agent')), request_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(owner_id,fact_id,version), FOREIGN KEY(owner_id,fact_id) REFERENCES work_facts(owner_id,id)
);
CREATE TABLE work_import_runs (
 owner_id uuid NOT NULL REFERENCES owners(id), id uuid NOT NULL, source_namespace text NOT NULL,
 source_collected_at timestamptz NOT NULL, request_id uuid NOT NULL, receipt jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(owner_id,id)
);
CREATE TABLE work_day_coverage (
 owner_id uuid NOT NULL, work_date date NOT NULL, source_scope text NOT NULL,
 status text NOT NULL CHECK(status IN ('complete','partial','unavailable')), collected_at timestamptz NOT NULL,
 window_from timestamptz NOT NULL, window_to timestamptz NOT NULL, import_id uuid NOT NULL,
 PRIMARY KEY(owner_id,work_date,source_scope), FOREIGN KEY(owner_id,import_id) REFERENCES work_import_runs(owner_id,id)
);
`);
exports.down = false;
