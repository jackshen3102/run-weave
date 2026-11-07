exports.up = (pgm) =>
  pgm.sql(`
ALTER TABLE mcp_credentials DROP CONSTRAINT mcp_credentials_domain_check;
ALTER TABLE mcp_credentials ADD CHECK(domain IN ('records','browse','work'));
ALTER TABLE records ADD COLUMN migrated_browse_id uuid;
ALTER TABLE records ADD FOREIGN KEY(owner_id,migrated_browse_id) REFERENCES browse_entries(owner_id,id);
CREATE TABLE browse_cutovers(owner_id uuid PRIMARY KEY REFERENCES owners(id), audit jsonb NOT NULL, completed_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE browse_legacy_archives(
 owner_id uuid NOT NULL, entry_id uuid NOT NULL, record_snapshot jsonb NOT NULL,
 revisions jsonb NOT NULL, followups jsonb NOT NULL, attachment_links jsonb NOT NULL, material_results jsonb NOT NULL,
 PRIMARY KEY(owner_id,entry_id), FOREIGN KEY(owner_id,entry_id) REFERENCES browse_entries(owner_id,id)
);
CREATE TABLE browse_legacy_attachments(
 owner_id uuid NOT NULL,entry_id uuid NOT NULL,attachment_id uuid NOT NULL,
 PRIMARY KEY(owner_id,entry_id,attachment_id),
 FOREIGN KEY(owner_id,entry_id) REFERENCES browse_entries(owner_id,id),
 FOREIGN KEY(owner_id,attachment_id,entry_id) REFERENCES attachments(owner_id,id,bound_browse_id)
);
ALTER TABLE work_facts ADD COLUMN eligibility text NOT NULL DEFAULT 'eligible' CHECK(eligibility IN ('eligible','excluded','needs-review'));
ALTER TABLE work_reports ADD COLUMN needs_review boolean NOT NULL DEFAULT false;
CREATE VIEW eligible_work_facts AS SELECT * FROM work_facts WHERE eligibility='eligible';
CREATE VIEW eligible_work_reports AS SELECT * FROM work_reports WHERE NOT needs_review;
`);
exports.down = false;
