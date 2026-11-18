ALTER TABLE sql_jobs
  ADD COLUMN kind text NOT NULL DEFAULT 'generate',
  ALTER COLUMN erd_id DROP NOT NULL,
  ALTER COLUMN revision DROP NOT NULL,
  ADD CONSTRAINT sql_jobs_kind_scope CHECK (
    (kind = 'generate' AND erd_id IS NOT NULL AND revision IS NOT NULL) OR
    (kind = 'parse' AND erd_id IS NULL AND revision IS NULL)
  );

CREATE TABLE sql_import_mutations (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mutation_id uuid NOT NULL,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  erd_id uuid NOT NULL REFERENCES erds(id) ON DELETE CASCADE,
  request_hash text NOT NULL,
  result jsonb NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  PRIMARY KEY (user_id, mutation_id)
);
CREATE INDEX sql_import_mutations_expiry ON sql_import_mutations (expires_at);
