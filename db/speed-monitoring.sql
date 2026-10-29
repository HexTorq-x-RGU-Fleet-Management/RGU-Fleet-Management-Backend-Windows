ALTER TABLE cam.buses ADD COLUMN IF NOT EXISTS speed_limit_kph double precision NOT NULL DEFAULT 60;
ALTER TABLE cam.buses DROP CONSTRAINT IF EXISTS buses_speed_limit_kph_check;
ALTER TABLE cam.buses ADD CONSTRAINT buses_speed_limit_kph_check CHECK (speed_limit_kph BETWEEN 1 AND 200);
CREATE TABLE IF NOT EXISTS cam.speed_violations (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL REFERENCES cam.tenants(id) ON DELETE CASCADE,
 bus_id uuid NOT NULL,
 source_id uuid,
 device_number text NOT NULL,
 gps_time bigint NOT NULL,
 observed_at timestamptz NOT NULL DEFAULT now(),
 speed_kph double precision NOT NULL,
 speed_limit_kph double precision NOT NULL,
 latitude double precision NOT NULL,
 longitude double precision NOT NULL,
 address text NOT NULL DEFAULT '',
 UNIQUE(tenant_id,bus_id,source_id,device_number,gps_time),
 FOREIGN KEY(tenant_id,bus_id) REFERENCES cam.buses(tenant_id,id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS speed_violations_bus_time ON cam.speed_violations(tenant_id,bus_id,observed_at DESC);
ALTER TABLE cam.speed_violations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS speed_violations_read ON cam.speed_violations;
DROP POLICY IF EXISTS speed_violations_write ON cam.speed_violations;
CREATE POLICY speed_violations_read ON cam.speed_violations FOR SELECT USING(tenant_id=cam.workspace() AND cam.actor_role() IN ('admin','member'));
CREATE POLICY speed_violations_write ON cam.speed_violations FOR ALL USING(tenant_id=cam.workspace() AND cam.actor_role()='admin') WITH CHECK(tenant_id=cam.workspace() AND cam.actor_role()='admin');
GRANT SELECT,INSERT,UPDATE,DELETE ON cam.speed_violations TO cam_app;
