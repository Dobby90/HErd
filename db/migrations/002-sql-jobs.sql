CREATE TABLE sql_jobs (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  erd_id uuid NOT NULL REFERENCES erds(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mutation_id uuid NOT NULL,
  request_hash text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  target jsonb NOT NULL,
  adapter_version text NOT NULL,
  options jsonb NOT NULL,
  snapshot jsonb,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  output jsonb,
  started_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz,
  UNIQUE (user_id, mutation_id),
  CHECK ((state IN ('queued', 'running')) = (expires_at IS NULL)),
  CHECK ((state IN ('queued', 'running')) = (snapshot IS NOT NULL))
);
CREATE INDEX sql_jobs_queue ON sql_jobs (created_at, id) WHERE state = 'queued';
CREATE INDEX sql_jobs_active_user ON sql_jobs (user_id) WHERE state IN ('queued', 'running');
CREATE INDEX sql_jobs_expiry ON sql_jobs (expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX sql_jobs_started ON sql_jobs (started_at) WHERE state = 'running';
