CREATE TABLE IF NOT EXISTS cam.ui_preferences (
 user_id uuid PRIMARY KEY REFERENCES cam.users(id) ON DELETE CASCADE,
 data jsonb NOT NULL DEFAULT '{}', updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE cam.ui_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE cam.ui_preferences FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ui_owner ON cam.ui_preferences;
CREATE POLICY ui_owner ON cam.ui_preferences FOR ALL USING(user_id=cam.actor()) WITH CHECK(user_id=cam.actor());
GRANT SELECT,INSERT,UPDATE ON cam.ui_preferences TO cam_app;
CREATE TABLE IF NOT EXISTS cam.channel_health (
 tenant_id uuid NOT NULL, device_id text NOT NULL, channel integer NOT NULL CHECK(channel BETWEEN 1 AND 1024),
 state text NOT NULL CHECK(state IN ('working','unavailable','unknown')), code text,
 checked_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,device_id,channel),
 FOREIGN KEY(tenant_id,device_id) REFERENCES cam.devices(tenant_id,device_id) ON DELETE CASCADE
);
ALTER TABLE cam.channel_health ENABLE ROW LEVEL SECURITY;
ALTER TABLE cam.channel_health FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS channel_health_scope ON cam.channel_health;
CREATE POLICY channel_health_scope ON cam.channel_health FOR ALL
 USING(tenant_id=cam.workspace() AND (cam.actor_role()='admin' OR EXISTS(
 SELECT 1 FROM cam.grants g WHERE g.tenant_id=channel_health.tenant_id AND g.device_id=channel_health.device_id
 AND g.user_id=cam.actor() AND g.can_view AND (g.channels IS NULL OR channel_health.channel=ANY(g.channels)))))
 WITH CHECK(tenant_id=cam.workspace() AND (cam.actor_role()='admin' OR EXISTS(
 SELECT 1 FROM cam.grants g WHERE g.tenant_id=channel_health.tenant_id AND g.device_id=channel_health.device_id
 AND g.user_id=cam.actor() AND g.can_view AND (g.channels IS NULL OR channel_health.channel=ANY(g.channels)))));
GRANT SELECT,INSERT,UPDATE,DELETE ON cam.channel_health TO cam_app;
