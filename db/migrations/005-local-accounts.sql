CREATE TABLE password_credentials (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  username text NOT NULL UNIQUE CHECK (username ~ '^[a-z0-9][a-z0-9_.-]{2,63}$'),
  password_salt bytea NOT NULL CHECK (octet_length(password_salt) = 16),
  password_hash bytea NOT NULL CHECK (octet_length(password_hash) = 64)
);

CREATE TABLE password_attempts (
  key text PRIMARY KEY,
  attempts integer NOT NULL CHECK (attempts > 0),
  expires_at timestamptz NOT NULL
);
CREATE INDEX password_attempts_expiry ON password_attempts (expires_at);
