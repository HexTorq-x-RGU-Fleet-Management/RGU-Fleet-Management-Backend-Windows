-- Additive dedicated-driver foundation. Existing bus driver fields remain the
-- compatibility source during the staged frontend/API transition.
CREATE TABLE IF NOT EXISTS cam.drivers (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL REFERENCES cam.tenants(id),
 full_name text NOT NULL,
 phone text NOT NULL DEFAULT '',
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','inactive')),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),
 UNIQUE(tenant_id,full_name,phone),
 CHECK(length(btrim(full_name)) BETWEEN 1 AND 160),
 CHECK(length(phone) <= 40)
);

ALTER TABLE cam.buses ADD COLUMN IF NOT EXISTS driver_id uuid;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='buses_driver_tenant_fk') THEN
  ALTER TABLE cam.buses ADD CONSTRAINT buses_driver_tenant_fk
   FOREIGN KEY(tenant_id,driver_id) REFERENCES cam.drivers(tenant_id,id) ON DELETE RESTRICT;
 END IF;
END $$;

INSERT INTO cam.drivers(id,tenant_id,full_name,phone)
SELECT gen_random_uuid(),tenant_id,btrim(driver_name),btrim(driver_phone)
FROM cam.buses
WHERE btrim(driver_name) <> ''
ON CONFLICT(tenant_id,full_name,phone) DO NOTHING;

UPDATE cam.buses b
SET driver_id=d.id
FROM cam.drivers d
WHERE b.driver_id IS NULL
 AND d.tenant_id=b.tenant_id
 AND d.full_name=btrim(b.driver_name)
 AND d.phone=btrim(b.driver_phone);

CREATE INDEX IF NOT EXISTS drivers_tenant_name ON cam.drivers(tenant_id,lower(full_name));
CREATE INDEX IF NOT EXISTS buses_driver_mapping ON cam.buses(tenant_id,driver_id);

ALTER TABLE cam.drivers ENABLE ROW LEVEL SECURITY;
ALTER TABLE cam.drivers FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS driver_read ON cam.drivers;
CREATE POLICY driver_read ON cam.drivers FOR SELECT USING(
 tenant_id=cam.workspace() AND (
  cam.actor_role()='admin' OR EXISTS(
   SELECT 1 FROM cam.buses b JOIN cam.grants g ON g.tenant_id=b.tenant_id AND g.device_id=b.recorder_id
   WHERE b.tenant_id=drivers.tenant_id AND b.driver_id=drivers.id
    AND g.user_id=cam.actor() AND g.can_view AND (g.channels IS NULL OR cardinality(g.channels)>0)
  )
 )
);
DROP POLICY IF EXISTS driver_write ON cam.drivers;
CREATE POLICY driver_write ON cam.drivers FOR ALL USING(
 tenant_id=cam.workspace() AND cam.actor_role()='admin'
) WITH CHECK(tenant_id=cam.workspace() AND cam.actor_role()='admin');
GRANT SELECT,INSERT,UPDATE,DELETE ON cam.drivers TO cam_app;
