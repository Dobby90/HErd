ALTER TABLE users
  ADD COLUMN is_admin boolean NOT NULL DEFAULT false,
  ADD COLUMN disabled_at timestamptz;
