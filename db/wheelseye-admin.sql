CREATE OR REPLACE FUNCTION cam.wheelseye_admin(tid uuid)
RETURNS uuid LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,cam AS $$
  SELECT id FROM cam.users
  WHERE tenant_id=tid AND role='admin' AND status='active'
  ORDER BY id LIMIT 1
$$;
REVOKE ALL ON FUNCTION cam.wheelseye_admin(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cam.wheelseye_admin(uuid) TO cam_app;
