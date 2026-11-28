-- Additive dedicated-route foundation. Existing bus route fields remain the
-- compatibility source during the staged frontend/API transition.
CREATE TABLE IF NOT EXISTS cam.routes (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL REFERENCES cam.tenants(id),
 name text NOT NULL,
 description text NOT NULL DEFAULT '',
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','inactive')),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),
 UNIQUE(tenant_id,name),
 CHECK(length(btrim(name)) BETWEEN 1 AND 100),
 CHECK(length(description) <= 500)
);

ALTER TABLE cam.buses ADD COLUMN IF NOT EXISTS route_id uuid;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='buses_route_tenant_fk') THEN
  ALTER TABLE cam.buses ADD CONSTRAINT buses_route_tenant_fk
   FOREIGN KEY(tenant_id,route_id) REFERENCES cam.routes(tenant_id,id) ON DELETE RESTRICT;
 END IF;
END $$;

INSERT INTO cam.routes(id,tenant_id,name)
SELECT gen_random_uuid(),tenant_id,btrim(route_name)
FROM cam.buses
WHERE btrim(route_name) <> ''
ON CONFLICT(tenant_id,name) DO NOTHING;

UPDATE cam.buses b
SET route_id=r.id
FROM cam.routes r
WHERE b.route_id IS NULL
 AND r.tenant_id=b.tenant_id
 AND r.name=btrim(b.route_name);

CREATE INDEX IF NOT EXISTS routes_tenant_name ON cam.routes(tenant_id,lower(name));
CREATE INDEX IF NOT EXISTS buses_route_mapping ON cam.buses(tenant_id,route_id);

ALTER TABLE cam.routes ENABLE ROW LEVEL SECURITY;
ALTER TABLE cam.routes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS route_read ON cam.routes;
CREATE POLICY route_read ON cam.routes FOR SELECT USING(
 tenant_id=cam.workspace() AND (
  cam.actor_role()='admin' OR EXISTS(
   SELECT 1 FROM cam.buses b JOIN cam.grants g ON g.tenant_id=b.tenant_id AND g.device_id=b.recorder_id
   WHERE b.tenant_id=routes.tenant_id AND b.route_id=routes.id
    AND g.user_id=cam.actor() AND g.can_view AND (g.channels IS NULL OR cardinality(g.channels)>0)
  )
 )
);
DROP POLICY IF EXISTS route_write ON cam.routes;
CREATE POLICY route_write ON cam.routes FOR ALL USING(
 tenant_id=cam.workspace() AND cam.actor_role()='admin'
) WITH CHECK(tenant_id=cam.workspace() AND cam.actor_role()='admin');
GRANT SELECT,INSERT,UPDATE,DELETE ON cam.routes TO cam_app;
