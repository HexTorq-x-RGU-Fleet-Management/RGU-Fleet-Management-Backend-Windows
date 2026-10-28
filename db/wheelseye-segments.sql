CREATE TABLE IF NOT EXISTS cam.wheelseye_location_segments (
 tenant_id uuid NOT NULL REFERENCES cam.tenants(id) ON DELETE CASCADE,
 device_number text NOT NULL,
 provider_gps_time bigint NOT NULL,
 segment_start timestamptz NOT NULL DEFAULT now(),
 latitude double precision NOT NULL,
 longitude double precision NOT NULL,
 speed double precision NOT NULL DEFAULT 0,
 ignition boolean NOT NULL DEFAULT false,
 fuel_litres double precision,
 address text,
 source_id uuid REFERENCES cam.wheelseye_sources(id) ON DELETE SET NULL,
 payload_hash text,
 PRIMARY KEY(tenant_id,device_number,provider_gps_time)
);
CREATE INDEX IF NOT EXISTS wheelseye_segments_device_time ON cam.wheelseye_location_segments(tenant_id,device_number,segment_start DESC);
ALTER TABLE cam.wheelseye_location_segments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS wheelseye_segments_read ON cam.wheelseye_location_segments;
DROP POLICY IF EXISTS wheelseye_segments_write ON cam.wheelseye_location_segments;
CREATE POLICY wheelseye_segments_read ON cam.wheelseye_location_segments FOR SELECT USING(tenant_id=cam.workspace() AND cam.actor_role() IN ('admin','member'));
CREATE POLICY wheelseye_segments_write ON cam.wheelseye_location_segments FOR ALL USING(tenant_id=cam.workspace() AND cam.actor_role()='admin') WITH CHECK(tenant_id=cam.workspace() AND cam.actor_role()='admin');
GRANT SELECT,INSERT,UPDATE,DELETE ON cam.wheelseye_location_segments TO cam_app;
