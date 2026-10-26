ALTER TABLE cam.users ADD COLUMN IF NOT EXISTS google_subject text;
ALTER TABLE cam.users ADD CONSTRAINT users_google_subject_format
  CHECK (google_subject IS NULL OR google_subject ~ '^[0-9A-Za-z._-]{1,255}$');
CREATE UNIQUE INDEX IF NOT EXISTS users_google_subject_unique
  ON cam.users(google_subject) WHERE google_subject IS NOT NULL;

CREATE OR REPLACE FUNCTION cam.google_login_record(subject text)
RETURNS SETOF cam.users
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,cam AS $$
  SELECT u.* FROM cam.users u WHERE u.google_subject = subject
$$;
