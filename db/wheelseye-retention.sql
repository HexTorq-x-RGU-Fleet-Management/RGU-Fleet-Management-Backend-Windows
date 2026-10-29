-- Raw provider observations are short-lived; normalized movement segments are retained separately.
CREATE INDEX IF NOT EXISTS wheelseye_logs_received_at_idx
  ON cam.wheelseye_location_logs(received_at);
CREATE OR REPLACE FUNCTION cam.wheelseye_cleanup_logs(retention_hours integer DEFAULT 24)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, cam AS $$
DECLARE deleted_count integer;
BEGIN
  IF retention_hours < 1 OR retention_hours > 168 THEN RAISE EXCEPTION 'Retention must be between 1 and 168 hours.' USING ERRCODE = '22023'; END IF;
  PERFORM pg_advisory_xact_lock(187210024);
  DELETE FROM cam.wheelseye_location_logs WHERE received_at < now() - make_interval(hours => retention_hours);
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;
REVOKE ALL ON FUNCTION cam.wheelseye_cleanup_logs(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cam.wheelseye_cleanup_logs(integer) TO cam_app;
