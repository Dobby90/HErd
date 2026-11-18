CREATE TABLE users (
  id uuid PRIMARY KEY,
  issuer text NOT NULL,
  subject text NOT NULL,
  display_name text NOT NULL,
  UNIQUE (issuer, subject)
);

CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);
CREATE INDEX sessions_expiry ON sessions (expires_at);

CREATE TABLE oidc_logins (
  token_hash text PRIMARY KEY,
  state text NOT NULL,
  nonce text NOT NULL,
  verifier text NOT NULL,
  return_to text NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX oidc_logins_expiry ON oidc_logins (expires_at);

CREATE TABLE projects (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE project_members (
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  PRIMARY KEY (project_id, user_id)
);
CREATE INDEX project_members_user ON project_members (user_id, project_id);

CREATE TABLE erds (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title text NOT NULL,
  payload jsonb NOT NULL CHECK (payload->>'id' IS NOT DISTINCT FROM id::text),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_by uuid NOT NULL REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX erds_project_updated ON erds (project_id, updated_at DESC, id);
CREATE INDEX erds_project_title ON erds (project_id, title, id);

CREATE TABLE erd_revisions (
  id uuid PRIMARY KEY,
  erd_id uuid NOT NULL REFERENCES erds(id) ON DELETE CASCADE,
  source_revision integer NOT NULL CHECK (source_revision > 0),
  payload jsonb NOT NULL,
  kind text NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX erd_revisions_document ON erd_revisions (erd_id, created_at DESC);

CREATE TABLE erd_mutations (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  erd_id uuid NOT NULL REFERENCES erds(id) ON DELETE CASCADE,
  mutation_id uuid NOT NULL,
  request_hash text NOT NULL,
  result jsonb NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  PRIMARY KEY (user_id, erd_id, mutation_id)
);
CREATE INDEX erd_mutations_expiry ON erd_mutations (expires_at);
