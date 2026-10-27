CREATE OR REPLACE FUNCTION cam.wheelseye_source_for_device(tid uuid, device text)
RETURNS TABLE(source_id uuid, payload bytea)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,cam AS $$
  SELECT s.id, s.payload
  FROM cam.wheelseye_sources s
  JOIN cam.wheelseye_devices d ON d.source_id=s.id AND d.tenant_id=s.tenant_id
  WHERE s.tenant_id=tid AND d.device_number=device AND s.enabled
  ORDER BY s.updated_at DESC
  LIMIT 1
$$;
REVOKE ALL ON FUNCTION cam.wheelseye_source_for_device(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cam.wheelseye_source_for_device(uuid,text) TO cam_app;
