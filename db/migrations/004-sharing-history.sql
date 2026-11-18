ALTER TABLE users ADD COLUMN share_code uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE;

ALTER TABLE erd_revisions ADD COLUMN description text NOT NULL DEFAULT '';
ALTER TABLE erd_revisions ADD CONSTRAINT erd_revisions_kind
  CHECK (kind IN ('manual', 'checkpoint', 'before-import', 'before-restore'));
CREATE INDEX erd_revisions_checkpoint ON erd_revisions (erd_id, source_revision DESC, id)
  WHERE kind = 'checkpoint';
