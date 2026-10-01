exports.up = (pgm) => pgm.sql(`
LOCK TABLE records, record_revisions, record_followups IN SHARE ROW EXCLUSIVE MODE;
-- A transactional owner counter, rather than a sequence, orders commits. Its row
-- lock is held until commit, so a reader cannot advance past an uncommitted event.
CREATE TABLE record_change_heads (
 owner_id uuid PRIMARY KEY REFERENCES owners(id),
 sequence bigint NOT NULL DEFAULT 0 CHECK(sequence >= 0)
);
CREATE TABLE record_changes (
 owner_id uuid NOT NULL REFERENCES owners(id), sequence bigint NOT NULL,
 record_id uuid NOT NULL, kind text NOT NULL CHECK(kind IN ('snapshot','record_changed','followup_added')),
 actor text NOT NULL CHECK(actor IN ('app','agent')),
 record_version integer NOT NULL, followup_id uuid, followup_sequence integer,
 deleted boolean NOT NULL,
 PRIMARY KEY(owner_id,sequence),
 FOREIGN KEY(owner_id,record_id) REFERENCES records(owner_id,id)
);
CREATE FUNCTION suiji_capture_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n bigint; v integer; d boolean; fid uuid; fs integer;
BEGIN
 INSERT INTO record_change_heads(owner_id) VALUES(NEW.owner_id) ON CONFLICT DO NOTHING;
 UPDATE record_change_heads SET sequence=sequence+1 WHERE owner_id=NEW.owner_id RETURNING sequence INTO n;
 IF TG_TABLE_NAME = 'record_revisions' THEN
   v := NEW.version; d := (NEW.snapshot->>'deletedAt') IS NOT NULL;
 ELSE
   fid := NEW.id; fs := NEW.sequence;
   SELECT version, deleted_at IS NOT NULL INTO v,d FROM records WHERE owner_id=NEW.owner_id AND id=NEW.record_id;
 END IF;
 INSERT INTO record_changes(owner_id,sequence,record_id,kind,actor,record_version,followup_id,followup_sequence,deleted)
 VALUES(NEW.owner_id,n,NEW.record_id,
   CASE WHEN TG_TABLE_NAME='record_revisions' THEN 'record_changed' ELSE 'followup_added' END,
   NEW.actor,v,
   fid,fs,d);
 RETURN NEW;
END $$;
-- Seed a complete inventory, including trash and records with existing followups.
INSERT INTO record_changes(owner_id,sequence,record_id,kind,actor,record_version,deleted)
 SELECT owner_id,row_number() OVER(PARTITION BY owner_id ORDER BY created_at,id),id,'snapshot',created_via,version,deleted_at IS NOT NULL FROM records;
INSERT INTO record_change_heads(owner_id,sequence)
 SELECT owner_id,max(sequence) FROM record_changes GROUP BY owner_id;
CREATE TRIGGER suiji_revision_change AFTER INSERT ON record_revisions FOR EACH ROW EXECUTE FUNCTION suiji_capture_change();
CREATE TRIGGER suiji_followup_change AFTER INSERT ON record_followups FOR EACH ROW EXECUTE FUNCTION suiji_capture_change();
`);
exports.down = false;
