CREATE SCHEMA IF NOT EXISTS cam;
REVOKE ALL ON SCHEMA cam FROM PUBLIC;
CREATE TABLE IF NOT EXISTS cam.tenants (
 id uuid PRIMARY KEY, name text NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
 status text NOT NULL CHECK(status IN ('pending','active','suspended','rejected')),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS cam.users (
 id uuid PRIMARY KEY, tenant_id uuid REFERENCES cam.tenants(id),
 email text NOT NULL CHECK(length(email) BETWEEN 3 AND 320), full_name text NOT NULL CHECK(length(full_name) BETWEEN 1 AND 100),
 role text NOT NULL CHECK(role IN ('superadmin','admin','member')),
 status text NOT NULL CHECK(status IN ('pending','active','suspended','rejected')),
 password_salt text NOT NULL, password_hash text NOT NULL,
 auth_version integer NOT NULL DEFAULT 1, must_change_password boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(id,tenant_id),
 CHECK((role='superadmin' AND tenant_id IS NULL) OR (role<>'superadmin' AND tenant_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON cam.users(lower(email));
CREATE UNIQUE INDEX IF NOT EXISTS one_superadmin ON cam.users(role) WHERE role='superadmin';
CREATE UNIQUE INDEX IF NOT EXISTS one_admin_per_tenant ON cam.users(tenant_id) WHERE role='admin';
CREATE TABLE IF NOT EXISTS cam.sessions (
 token_hash text PRIMARY KEY CHECK(length(token_hash)=64), user_id uuid NOT NULL REFERENCES cam.users(id) ON DELETE CASCADE,
 auth_version integer NOT NULL, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS cam.devices (
 tenant_id uuid NOT NULL REFERENCES cam.tenants(id), device_id text NOT NULL CHECK(length(device_id) BETWEEN 1 AND 256),
 data jsonb NOT NULL, available boolean NOT NULL DEFAULT true, checked_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,device_id)
);
CREATE TABLE IF NOT EXISTS cam.grants (
 tenant_id uuid NOT NULL, user_id uuid NOT NULL, device_id text NOT NULL,
 can_view boolean NOT NULL DEFAULT false, can_download boolean NOT NULL DEFAULT false, can_record boolean NOT NULL DEFAULT false,
 channels integer[], PRIMARY KEY(tenant_id,user_id,device_id),
 FOREIGN KEY(user_id,tenant_id) REFERENCES cam.users(id,tenant_id) ON DELETE CASCADE,
 FOREIGN KEY(tenant_id,device_id) REFERENCES cam.devices(tenant_id,device_id) ON DELETE CASCADE,
 CHECK((can_view OR NOT(can_download OR can_record)) AND (channels IS NULL OR (0 < ALL(channels) AND 1024 >= ALL(channels) AND cardinality(channels)<=1024)))
);
CREATE TABLE IF NOT EXISTS cam.providers (
 tenant_id uuid PRIMARY KEY REFERENCES cam.tenants(id), payload bytea NOT NULL, account_key text NOT NULL DEFAULT '', updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS cam.preferences (
 tenant_id uuid NOT NULL, user_id uuid NOT NULL, account_key text NOT NULL DEFAULT '', data jsonb NOT NULL DEFAULT '{}', PRIMARY KEY(tenant_id,user_id,account_key),
 FOREIGN KEY(user_id,tenant_id) REFERENCES cam.users(id,tenant_id) ON DELETE CASCADE
);
ALTER TABLE cam.providers ADD COLUMN IF NOT EXISTS account_key text NOT NULL DEFAULT '';
ALTER TABLE cam.preferences ADD COLUMN IF NOT EXISTS account_key text NOT NULL DEFAULT '';
ALTER TABLE cam.preferences DROP CONSTRAINT IF EXISTS preferences_pkey;
ALTER TABLE cam.preferences ADD PRIMARY KEY(tenant_id,user_id,account_key);
CREATE TABLE IF NOT EXISTS cam.audit (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, tenant_id uuid REFERENCES cam.tenants(id), actor_id uuid REFERENCES cam.users(id),
 action text NOT NULL, target_id uuid, created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE cam.audit ADD COLUMN IF NOT EXISTS details jsonb NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS audit_workspace_page ON cam.audit(tenant_id,id DESC);
CREATE INDEX IF NOT EXISTS audit_action_page ON cam.audit(action,id DESC);
CREATE INDEX IF NOT EXISTS audit_created_at ON cam.audit(created_at);
CREATE OR REPLACE FUNCTION cam.actor() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('cam.user_id',true),'')::uuid $$;
CREATE OR REPLACE FUNCTION cam.workspace() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('cam.tenant_id',true),'')::uuid $$;
CREATE OR REPLACE FUNCTION cam.actor_role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('cam.role',true),'') $$;

ALTER TABLE cam.tenants ENABLE ROW LEVEL SECURITY; ALTER TABLE cam.tenants FORCE ROW LEVEL SECURITY;
ALTER TABLE cam.users ENABLE ROW LEVEL SECURITY; ALTER TABLE cam.users FORCE ROW LEVEL SECURITY;
ALTER TABLE cam.devices ENABLE ROW LEVEL SECURITY; ALTER TABLE cam.devices FORCE ROW LEVEL SECURITY;
ALTER TABLE cam.grants ENABLE ROW LEVEL SECURITY; ALTER TABLE cam.grants FORCE ROW LEVEL SECURITY;
ALTER TABLE cam.providers ENABLE ROW LEVEL SECURITY; ALTER TABLE cam.providers FORCE ROW LEVEL SECURITY;
ALTER TABLE cam.preferences ENABLE ROW LEVEL SECURITY; ALTER TABLE cam.preferences FORCE ROW LEVEL SECURITY;
ALTER TABLE cam.audit ENABLE ROW LEVEL SECURITY; ALTER TABLE cam.audit FORCE ROW LEVEL SECURITY;
ALTER TABLE cam.sessions ENABLE ROW LEVEL SECURITY; ALTER TABLE cam.sessions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_read ON cam.tenants;
CREATE POLICY tenant_read ON cam.tenants FOR SELECT USING(id=cam.workspace() OR cam.actor_role()='superadmin');
DROP POLICY IF EXISTS tenant_update ON cam.tenants;
CREATE POLICY tenant_update ON cam.tenants FOR UPDATE USING(cam.actor_role()='superadmin') WITH CHECK(cam.actor_role()='superadmin');
DROP POLICY IF EXISTS user_read ON cam.users;
CREATE POLICY user_read ON cam.users FOR SELECT USING(cam.actor_role()='superadmin' OR (tenant_id=cam.workspace() AND (id=cam.actor() OR cam.actor_role()='admin' AND role='member')));
DROP POLICY IF EXISTS user_insert ON cam.users;
CREATE POLICY user_insert ON cam.users FOR INSERT WITH CHECK(cam.actor_role()='admin' AND tenant_id=cam.workspace() AND role='member');
DROP POLICY IF EXISTS user_update ON cam.users;
CREATE POLICY user_update ON cam.users FOR UPDATE USING(cam.actor_role()='superadmin' OR id=cam.actor() OR (tenant_id=cam.workspace() AND cam.actor_role()='admin' AND role='member'))
 WITH CHECK(cam.actor_role()='superadmin' OR (id=cam.actor() AND role=cam.actor_role() AND tenant_id IS NOT DISTINCT FROM cam.workspace()) OR (tenant_id=cam.workspace() AND cam.actor_role()='admin' AND role='member'));
DROP POLICY IF EXISTS device_read ON cam.devices;
CREATE POLICY device_read ON cam.devices FOR SELECT USING(tenant_id=cam.workspace() AND (cam.actor_role()='admin' OR EXISTS(SELECT 1 FROM cam.grants g WHERE g.tenant_id=devices.tenant_id AND g.user_id=cam.actor() AND g.device_id=devices.device_id AND g.can_view)));
DROP POLICY IF EXISTS device_write ON cam.devices;
CREATE POLICY device_write ON cam.devices FOR ALL USING(tenant_id=cam.workspace() AND cam.actor_role()='admin') WITH CHECK(tenant_id=cam.workspace() AND cam.actor_role()='admin');
DROP POLICY IF EXISTS grant_read ON cam.grants;
CREATE POLICY grant_read ON cam.grants FOR SELECT USING(tenant_id=cam.workspace() AND (user_id=cam.actor() OR cam.actor_role()='admin'));
DROP POLICY IF EXISTS grant_write ON cam.grants;
CREATE POLICY grant_write ON cam.grants FOR ALL USING(tenant_id=cam.workspace() AND cam.actor_role()='admin') WITH CHECK(tenant_id=cam.workspace() AND cam.actor_role()='admin');
DROP POLICY IF EXISTS provider_admin ON cam.providers;
CREATE POLICY provider_admin ON cam.providers FOR ALL USING(tenant_id=cam.workspace() AND cam.actor_role()='admin') WITH CHECK(tenant_id=cam.workspace() AND cam.actor_role()='admin');
DROP POLICY IF EXISTS preference_owner ON cam.preferences;
CREATE POLICY preference_owner ON cam.preferences FOR ALL USING(tenant_id=cam.workspace() AND user_id=cam.actor()) WITH CHECK(tenant_id=cam.workspace() AND user_id=cam.actor());
DROP POLICY IF EXISTS audit_read ON cam.audit;
CREATE POLICY audit_read ON cam.audit FOR SELECT USING(tenant_id=cam.workspace() AND cam.actor_role()='admin' OR cam.actor_role()='superadmin');
DROP POLICY IF EXISTS audit_insert ON cam.audit;
CREATE POLICY audit_insert ON cam.audit FOR INSERT WITH CHECK(actor_id=cam.actor() AND (tenant_id=cam.workspace() OR cam.actor_role()='superadmin'));

-- These narrow authentication functions run as the migration owner. The server
-- itself connects with a non-owner, non-superuser, NOBYPASSRLS role.
CREATE OR REPLACE FUNCTION cam.root_exists() RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,cam AS $$ SELECT EXISTS(SELECT 1 FROM cam.users WHERE role='superadmin') $$;
CREATE OR REPLACE FUNCTION cam.bootstrap_root(uid uuid, mail text, fullname text, salt text, hash text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cam AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(730008001);
 IF EXISTS(SELECT 1 FROM cam.users WHERE role='superadmin') THEN RAISE EXCEPTION 'already configured' USING ERRCODE='23505'; END IF;
 INSERT INTO cam.users(id,email,full_name,role,status,password_salt,password_hash) VALUES(uid,mail,fullname,'superadmin','active',salt,hash);
END $$;
CREATE OR REPLACE FUNCTION cam.request_admin(uid uuid, tid uuid, mail text, fullname text, workspace_name text, salt text, hash text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cam AS $$
BEGIN
 INSERT INTO cam.tenants(id,name,status) VALUES(tid,workspace_name,'pending');
 INSERT INTO cam.users(id,tenant_id,email,full_name,role,status,password_salt,password_hash) VALUES(uid,tid,mail,fullname,'admin','pending',salt,hash);
 INSERT INTO cam.audit(tenant_id,action,target_id) VALUES(tid,'admin.requested',uid);
END $$;
CREATE OR REPLACE FUNCTION cam.login_record(mail text) RETURNS SETOF cam.users LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,cam AS $$ SELECT u.* FROM cam.users u WHERE lower(u.email)=lower(mail) $$;
CREATE OR REPLACE FUNCTION cam.issue_session(uid uuid, hash text, expected_version integer) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cam AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM cam.users u LEFT JOIN cam.tenants t ON t.id=u.tenant_id WHERE u.id=uid AND u.auth_version=expected_version AND u.status='active' AND (u.role='superadmin' OR t.status='active')) THEN RAISE EXCEPTION 'inactive user' USING ERRCODE='42501'; END IF;
 DELETE FROM cam.sessions WHERE user_id=uid AND expires_at<=now();
 INSERT INTO cam.sessions(token_hash,user_id,auth_version,expires_at) VALUES(hash,uid,expected_version,now()+interval '7 days');
END $$;
CREATE OR REPLACE FUNCTION cam.end_session(hash text) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,cam AS $$ DELETE FROM cam.sessions WHERE token_hash=hash $$;
CREATE OR REPLACE FUNCTION cam.use_session(hash text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cam AS $$
DECLARE u cam.users; workspace_name text; workspace_status text;
BEGIN
 PERFORM set_config('cam.user_id','',true); PERFORM set_config('cam.tenant_id','',true); PERFORM set_config('cam.role','',true);
 SELECT a.* INTO u FROM cam.users a JOIN cam.sessions s ON s.user_id=a.id WHERE s.token_hash=hash AND s.expires_at>now() AND s.auth_version=a.auth_version AND a.status='active';
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF u.tenant_id IS NOT NULL THEN SELECT name,status INTO workspace_name,workspace_status FROM cam.tenants WHERE id=u.tenant_id; IF workspace_status IS DISTINCT FROM 'active' THEN RETURN NULL; END IF; END IF;
 PERFORM set_config('cam.user_id',u.id::text,true); PERFORM set_config('cam.tenant_id',coalesce(u.tenant_id::text,''),true); PERFORM set_config('cam.role',u.role,true);
 RETURN jsonb_build_object('id',u.id,'tenantId',u.tenant_id,'tenantName',workspace_name,'tenantStatus',workspace_status,'email',u.email,'fullName',u.full_name,'role',u.role,'status',u.status,'mustChangePassword',u.must_change_password,'authVersion',u.auth_version);
END $$;
CREATE OR REPLACE FUNCTION cam.revoke_user(uid uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cam AS $$
BEGIN
 IF (uid=cam.actor() OR cam.actor_role()='superadmin' OR EXISTS(SELECT 1 FROM cam.users WHERE id=uid AND tenant_id=cam.workspace() AND role='member' AND cam.actor_role()='admin')) IS NOT TRUE THEN RAISE EXCEPTION 'access denied' USING ERRCODE='42501'; END IF;
 DELETE FROM cam.sessions WHERE user_id=uid; UPDATE cam.users SET auth_version=auth_version+1 WHERE id=uid;
END $$;
CREATE OR REPLACE FUNCTION cam.revoke_tenant(tid uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cam AS $$
BEGIN
 IF cam.actor_role() IS DISTINCT FROM 'superadmin' THEN RAISE EXCEPTION 'access denied' USING ERRCODE='42501'; END IF;
 DELETE FROM cam.sessions WHERE user_id IN(SELECT id FROM cam.users WHERE tenant_id=tid); UPDATE cam.users SET auth_version=auth_version+1 WHERE tenant_id=tid;
END $$;
CREATE OR REPLACE FUNCTION cam.media_provider(device text, channel integer) RETURNS bytea LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,cam AS $$
 SELECT p.payload FROM cam.providers p JOIN cam.devices d ON d.tenant_id=p.tenant_id AND d.device_id=device AND d.available
 WHERE p.tenant_id=cam.workspace() AND EXISTS(SELECT 1 FROM jsonb_array_elements(d.data->'channels') c WHERE (c->>'number')::integer=channel)
 AND (cam.actor_role()='admin' OR cam.actor_role()='member' AND EXISTS(SELECT 1 FROM cam.grants g WHERE g.tenant_id=p.tenant_id AND g.user_id=cam.actor() AND g.device_id=device AND g.can_view AND (g.channels IS NULL OR channel=ANY(g.channels))))
$$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA cam FROM PUBLIC;

CREATE OR REPLACE FUNCTION cam.provider_account_key() RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,cam AS $$ SELECT coalesce((SELECT account_key FROM cam.providers WHERE tenant_id=cam.workspace() AND cam.actor_role() IN ('admin','member')),'') $$;
CREATE OR REPLACE FUNCTION cam.has_provider() RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,cam AS $$ SELECT EXISTS(SELECT 1 FROM cam.providers) $$;
REVOKE ALL ON FUNCTION cam.provider_account_key(),cam.has_provider() FROM PUBLIC;

-- Server-worker primitives, never HTTP endpoints. Runtime DB credentials and the
-- provider cipher key are trusted infrastructure. Only active workspaces run jobs.
CREATE OR REPLACE FUNCTION cam.recovery_candidates(tid uuid DEFAULT NULL) RETURNS TABLE(tenant_id uuid,payload bytea)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,cam AS $$
 SELECT p.tenant_id,p.payload FROM cam.providers p JOIN cam.tenants t ON t.id=p.tenant_id
 WHERE t.status='active' AND (tid IS NULL OR p.tenant_id=tid)
 AND EXISTS(SELECT 1 FROM cam.users u WHERE u.tenant_id=t.id AND u.role='admin' AND u.status='active')
 ORDER BY p.updated_at,p.tenant_id LIMIT 500
$$;
CREATE OR REPLACE FUNCTION cam.recovery_store(tid uuid,expected bytea,replacement bytea,event text DEFAULT NULL) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cam AS $$
BEGIN
 IF event IS NOT NULL AND event NOT IN ('provider.recovered','provider.recovery_attention') THEN RAISE EXCEPTION 'invalid recovery event' USING ERRCODE='42501'; END IF;
 PERFORM id FROM cam.tenants WHERE id=tid AND status='active' FOR SHARE;
 IF NOT FOUND THEN RETURN false; END IF;
 PERFORM id FROM cam.users WHERE tenant_id=tid AND role='admin' AND status='active' FOR SHARE;
 IF NOT FOUND THEN RETURN false; END IF;
 UPDATE cam.providers SET payload=replacement,updated_at=now() WHERE tenant_id=tid AND payload=expected;
 IF NOT FOUND THEN RETURN false; END IF;
 IF event IS NOT NULL THEN INSERT INTO cam.audit(tenant_id,action) VALUES(tid,event); END IF;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION cam.recovery_candidates(uuid),cam.recovery_store(uuid,bytea,bytea,text) FROM PUBLIC;
CREATE OR REPLACE FUNCTION cam.recovery_devices(tid uuid,expected bytea,records jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cam AS $$
DECLARE item jsonb;
BEGIN
 IF jsonb_typeof(records) IS DISTINCT FROM 'array' OR jsonb_array_length(records)>1000 THEN RAISE EXCEPTION 'invalid recovery devices' USING ERRCODE='22023'; END IF;
 IF NOT EXISTS(SELECT 1 FROM cam.tenants WHERE id=tid AND status='active') THEN RETURN false; END IF;
 PERFORM tenant_id FROM cam.providers WHERE tenant_id=tid AND payload=expected FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 UPDATE cam.devices SET available=false WHERE tenant_id=tid;
 FOR item IN SELECT value FROM jsonb_array_elements(records) LOOP
   INSERT INTO cam.devices(tenant_id,device_id,data) VALUES(tid,item->>'id',item)
   ON CONFLICT(tenant_id,device_id) DO UPDATE SET data=excluded.data,available=true,checked_at=now();
 END LOOP;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION cam.recovery_devices(uuid,bytea,jsonb) FROM PUBLIC;
CREATE OR REPLACE FUNCTION cam.audit_recording_cleanup(tid uuid,clip uuid,event text,info jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cam AS $$
BEGIN
 IF event NOT IN ('recording.cleanup_requested','recording.cleaned','recording.cleanup_failed') THEN RAISE EXCEPTION 'invalid cleanup event' USING ERRCODE='42501'; END IF;
 INSERT INTO cam.audit(tenant_id,action,target_id,details) VALUES(tid,event,clip,info);
END $$;
REVOKE ALL ON FUNCTION cam.audit_recording_cleanup(uuid,uuid,text,jsonb) FROM PUBLIC;

CREATE TABLE IF NOT EXISTS cam.health_alerts (
 id uuid PRIMARY KEY, alert_key text NOT NULL UNIQUE CHECK(alert_key~'^[a-f0-9]{64}$'),
 tenant_id uuid REFERENCES cam.tenants(id), kind text NOT NULL CHECK(kind IN ('stream','storage','server')),
 severity text NOT NULL CHECK(severity IN ('warning','critical')), code text NOT NULL,
 recorder_name text, channel integer, details jsonb NOT NULL DEFAULT '{}',
 occurrences integer NOT NULL DEFAULT 1, first_seen timestamptz NOT NULL DEFAULT now(), last_seen timestamptz NOT NULL DEFAULT now(),
 resolved_at timestamptz, resolution text, acknowledged_at timestamptz, acknowledged_by uuid REFERENCES cam.users(id)
);
ALTER TABLE cam.health_alerts ENABLE ROW LEVEL SECURITY;ALTER TABLE cam.health_alerts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS health_read ON cam.health_alerts;
CREATE POLICY health_read ON cam.health_alerts FOR SELECT USING(cam.actor_role()='superadmin');
DROP POLICY IF EXISTS health_ack ON cam.health_alerts;
CREATE POLICY health_ack ON cam.health_alerts FOR UPDATE USING(cam.actor_role()='superadmin') WITH CHECK(cam.actor_role()='superadmin');
CREATE INDEX IF NOT EXISTS health_latest ON cam.health_alerts(last_seen DESC,id);
CREATE OR REPLACE FUNCTION cam.health_report(uid uuid,key text,tid uuid,category text,level text,error_code text,recorder text,camera_channel integer,info jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cam AS $$
DECLARE result uuid;
BEGIN
 INSERT INTO cam.health_alerts(id,alert_key,tenant_id,kind,severity,code,recorder_name,channel,details)
 VALUES(uid,key,tid,category,level,error_code,left(recorder,200),camera_channel,info)
 ON CONFLICT(alert_key) DO UPDATE SET
  severity=excluded.severity,code=excluded.code,recorder_name=excluded.recorder_name,channel=excluded.channel,details=excluded.details,
  occurrences=CASE WHEN health_alerts.occurrences<2147483647 THEN health_alerts.occurrences+1 ELSE health_alerts.occurrences END,last_seen=now(),resolved_at=NULL,resolution=NULL,
  acknowledged_at=CASE WHEN health_alerts.resolved_at IS NOT NULL OR (health_alerts.severity='warning' AND excluded.severity='critical') THEN NULL ELSE health_alerts.acknowledged_at END,
  acknowledged_by=CASE WHEN health_alerts.resolved_at IS NOT NULL OR (health_alerts.severity='warning' AND excluded.severity='critical') THEN NULL ELSE health_alerts.acknowledged_by END
 RETURNING id INTO result;RETURN result;
END $$;
CREATE OR REPLACE FUNCTION cam.health_resolve(key text,reason text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,cam AS $$
 UPDATE cam.health_alerts SET resolved_at=now(),resolution=left(reason,40) WHERE alert_key=key AND resolved_at IS NULL
$$;
REVOKE ALL ON FUNCTION cam.health_report(uuid,text,uuid,text,text,text,text,integer,jsonb),cam.health_resolve(text,text) FROM PUBLIC;
