-- Additive fleet migration. Run as the migration owner after schema.sql.
CREATE TABLE IF NOT EXISTS cam.buses (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES cam.tenants(id),
 bus_number text NOT NULL, registration text NOT NULL, driver_name text NOT NULL,
 driver_phone text NOT NULL DEFAULT '', route_name text NOT NULL DEFAULT '',
 recorder_id text, telemetry_device_id text,
 favorite_channels integer[] NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,bus_number), UNIQUE(tenant_id,registration),
 UNIQUE(tenant_id,recorder_id), UNIQUE(tenant_id,telemetry_device_id),
 FOREIGN KEY(tenant_id,recorder_id) REFERENCES cam.devices(tenant_id,device_id),
 CHECK(length(bus_number) BETWEEN 1 AND 40 AND length(registration) BETWEEN 1 AND 40),
 CHECK(cardinality(favorite_channels)<=1024 AND 0<ALL(favorite_channels) AND 1024>=ALL(favorite_channels))
);
CREATE TABLE IF NOT EXISTS cam.telemetry (
 tenant_id uuid NOT NULL, bus_id uuid NOT NULL,
 device_id text NOT NULL, gps_time bigint NOT NULL, received_at timestamptz NOT NULL DEFAULT now(),
 source text NOT NULL CHECK(source IN ('mock','vendor')), payload jsonb NOT NULL,
 PRIMARY KEY(tenant_id,bus_id,device_id,gps_time),
 FOREIGN KEY(tenant_id,bus_id) REFERENCES cam.buses(tenant_id,id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS fleet_history ON cam.telemetry(tenant_id,bus_id,gps_time DESC);
CREATE UNIQUE INDEX IF NOT EXISTS fleet_bus_number ON cam.buses(tenant_id,lower(bus_number));
CREATE UNIQUE INDEX IF NOT EXISTS fleet_registration ON cam.buses(tenant_id,lower(registration));
ALTER TABLE cam.buses ENABLE ROW LEVEL SECURITY; ALTER TABLE cam.buses FORCE ROW LEVEL SECURITY;
ALTER TABLE cam.telemetry ENABLE ROW LEVEL SECURITY; ALTER TABLE cam.telemetry FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bus_read ON cam.buses;
CREATE POLICY bus_read ON cam.buses FOR SELECT USING(tenant_id=cam.workspace() AND
 (cam.actor_role()='admin' OR cam.actor_role()='member' AND EXISTS(
 SELECT 1 FROM cam.grants g WHERE g.tenant_id=buses.tenant_id AND g.device_id=buses.recorder_id
 AND g.user_id=cam.actor() AND g.can_view AND (g.channels IS NULL OR cardinality(g.channels)>0))));
DROP POLICY IF EXISTS bus_write ON cam.buses;
CREATE POLICY bus_write ON cam.buses FOR ALL USING(tenant_id=cam.workspace() AND cam.actor_role()='admin')
 WITH CHECK(tenant_id=cam.workspace() AND cam.actor_role()='admin');
DROP POLICY IF EXISTS telemetry_read ON cam.telemetry;
CREATE POLICY telemetry_read ON cam.telemetry FOR SELECT USING(tenant_id=cam.workspace() AND EXISTS(
 SELECT 1 FROM cam.buses b WHERE b.tenant_id=telemetry.tenant_id AND b.id=telemetry.bus_id));
DROP POLICY IF EXISTS telemetry_write ON cam.telemetry;
CREATE POLICY telemetry_write ON cam.telemetry FOR ALL USING(tenant_id=cam.workspace() AND cam.actor_role()='admin')
 WITH CHECK(tenant_id=cam.workspace() AND cam.actor_role()='admin');
GRANT SELECT,INSERT,UPDATE,DELETE ON cam.buses,cam.telemetry TO cam_app;
