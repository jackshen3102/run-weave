exports.up = (pgm) => pgm.sql(`
CREATE TABLE work_reports (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES owners(id),
 period_from date NOT NULL, period_to date NOT NULL CHECK(period_to=period_from+6),
 title text NOT NULL CHECK(char_length(title) BETWEEN 1 AND 80),
 body text NOT NULL CHECK(char_length(body) BETWEEN 1 AND 20000),
 based_on_feed_revision text NOT NULL, source_facts jsonb NOT NULL, days jsonb NOT NULL,
 version integer NOT NULL DEFAULT 1 CHECK(version>0), manually_edited boolean NOT NULL DEFAULT false,
 created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(owner_id,period_from,period_to), UNIQUE(owner_id,id)
);
CREATE INDEX work_reports_feed ON work_reports(owner_id,period_to DESC,created_at DESC,id DESC);
CREATE TABLE work_report_revisions (
 owner_id uuid NOT NULL, report_id uuid NOT NULL, version integer NOT NULL,
 snapshot jsonb NOT NULL, actor text NOT NULL CHECK(actor IN ('app','agent')),
 request_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(owner_id,report_id,version), FOREIGN KEY(owner_id,report_id) REFERENCES work_reports(owner_id,id)
);
`);
exports.down = false;
