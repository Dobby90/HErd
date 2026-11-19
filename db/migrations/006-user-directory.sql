ALTER TABLE users
  ADD COLUMN directory_name text,
  ADD COLUMN directory_alias text,
  ADD CONSTRAINT users_directory_alias_unique UNIQUE (directory_alias),
  ADD CONSTRAINT users_directory_profile CHECK (
    (directory_name IS NULL AND directory_alias IS NULL) OR
    (directory_name IS NOT NULL AND directory_alias IS NOT NULL AND
      char_length(directory_name) BETWEEN 1 AND 100 AND directory_alias ~ '^[a-z0-9][a-z0-9_.-]{2,63}$')
  );
