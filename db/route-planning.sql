-- Ordered route stops and recurring departures. Coordinates remain optional
-- until a workspace supplies verified route geography.
CREATE TABLE IF NOT EXISTS cam.route_stops (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES cam.tenants(id),
 route_id uuid NOT NULL, position integer NOT NULL,
 name text NOT NULL, address text NOT NULL DEFAULT '', latitude numeric, longitude numeric,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,route_id,position),
 FOREIGN KEY(tenant_id,route_id) REFERENCES cam.routes(tenant_id,id) ON DELETE CASCADE,
 CHECK(position >= 1), CHECK(length(btrim(name)) BETWEEN 1 AND 120), CHECK(length(address)<=300),
 CHECK(latitude IS NULL OR latitude BETWEEN -90 AND 90), CHECK(longitude IS NULL OR longitude BETWEEN -180 AND 180)
);
CREATE TABLE IF NOT EXISTS cam.route_schedules (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES cam.tenants(id),
 route_id uuid NOT NULL, label text NOT NULL, days smallint[] NOT NULL DEFAULT '{1,2,3,4,5}', departure_minutes integer NOT NULL, active boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id), FOREIGN KEY(tenant_id,route_id) REFERENCES cam.routes(tenant_id,id) ON DELETE CASCADE,
 CHECK(length(btrim(label)) BETWEEN 1 AND 100), CHECK(departure_minutes BETWEEN 0 AND 1439),
 CHECK(cardinality(days) BETWEEN 1 AND 7 AND 1<=ALL(days) AND 7>=ALL(days))
);
CREATE INDEX IF NOT EXISTS route_stops_route_position ON cam.route_stops(tenant_id,route_id,position);
CREATE INDEX IF NOT EXISTS route_schedules_route_departure ON cam.route_schedules(tenant_id,route_id,departure_minutes);
ALTER TABLE cam.route_stops ENABLE ROW LEVEL SECURITY; ALTER TABLE cam.route_stops FORCE ROW LEVEL SECURITY;
ALTER TABLE cam.route_schedules ENABLE ROW LEVEL SECURITY; ALTER TABLE cam.route_schedules FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS route_stops_read ON cam.route_stops; DROP POLICY IF EXISTS route_stops_write ON cam.route_stops;
DROP POLICY IF EXISTS route_schedules_read ON cam.route_schedules; DROP POLICY IF EXISTS route_schedules_write ON cam.route_schedules;
CREATE POLICY route_stops_read ON cam.route_stops FOR SELECT USING(tenant_id=cam.workspace());
CREATE POLICY route_stops_write ON cam.route_stops FOR ALL USING(tenant_id=cam.workspace() AND cam.actor_role()='admin') WITH CHECK(tenant_id=cam.workspace() AND cam.actor_role()='admin');
CREATE POLICY route_schedules_read ON cam.route_schedules FOR SELECT USING(tenant_id=cam.workspace());
CREATE POLICY route_schedules_write ON cam.route_schedules FOR ALL USING(tenant_id=cam.workspace() AND cam.actor_role()='admin') WITH CHECK(tenant_id=cam.workspace() AND cam.actor_role()='admin');
GRANT SELECT,INSERT,UPDATE,DELETE ON cam.route_stops,cam.route_schedules TO cam_app;
