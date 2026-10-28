ALTER TABLE cam.wheelseye_sources DROP CONSTRAINT IF EXISTS wheelseye_sources_poll_interval_seconds_check;
ALTER TABLE cam.wheelseye_sources ADD CONSTRAINT wheelseye_sources_poll_interval_seconds_check CHECK(poll_interval_seconds BETWEEN 10 AND 3600);
ALTER TABLE cam.wheelseye_sources ALTER COLUMN poll_interval_seconds SET DEFAULT 10;
UPDATE cam.wheelseye_sources SET poll_interval_seconds=10 WHERE poll_interval_seconds=60;
