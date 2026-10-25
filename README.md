# RGU Fleet Management Windows Backend

Standalone Node/PostgreSQL API extracted from the preserved Hikvision V3 SaaS
baseline. It serves no vanilla browser UI. The frontend and Linux backend remain
separate repositories and were not modified by this extraction.

Repository: https://github.com/HexTorq-x-RGU-Fleet-Management/RGU-Fleet-Management-Backend-Windows

Fleet extension: bus configuration now maps imported recorders and GPS/fuel
devices, with PostgreSQL persistence, tenant/member policies, mock polling and
history APIs. See [fleet API](docs/FLEET-API.md) and [product direction](docs/FLEET-PRODUCT.md).
The separate React frontend uses authenticated APIs for fleet, accounts, cameras,
recordings, team and platform screens. It has no business-data fallback.

## Requirements and local setup

Windows x64, Node 24.x, Python media packages and the authorized installed
iVMS/Windows SDK. The API uses Node HTTP and locked pg 8.23.1. Adapter/native
source is included; actual DLLs remain installed runtime dependencies. The full
Hik-Vision baseline repository retains the verified SDK binary bundle.

```powershell
npm ci
npm run prepare:db
npm run setup:local
Copy-Item .env.example .env
npm start
```

API: http://127.0.0.1:8101. Private PostgreSQL: 127.0.0.1:55432.
prepare:db downloads pinned PostgreSQL 17.11 to ignored .local/ with resume
support. It installs no service. setup:local creates the private instance,
restricted cam_app role and preserved schema; generated connection settings are
protected by Windows DPAPI. No viewer users or default operator password are seeded.

Python packages: `python -m pip install -r vendor/windows-sdk/native/requirements.txt`.
`npm run db:status` and `npm run db:stop` manage the private database instance.
Stopping the API does not stop PostgreSQL. SDK identity and valid playback
authorization are separate from successfully loading the DLLs.

## Verification

Run `npm run test:all`: source/dependency checks, real PostgreSQL/API tests, native
audio/video tests and installed SDK loading diagnostics. Individual commands:
npm test, npm run test:unit, npm run test:audio, npm run test:video,
npm run check:sdk and npm run check. See docs/TEST-REPORT.md.

Fixtures create uniquely named cam_test_* databases only on 127.0.0.1:55432 and
remove them afterward. They do not use production DATABASE_URL or reset/seed
cam_saas. Camera/provider/media responses are synthetic. Browser-only legacy
recovery-view tests were not copied into backend scope or hidden as skips.

## Frontend and API

GET / returns API metadata; /api/health returns the health marker. Former frontend
and private source paths return 404. V3 authentication, approvals, team/grants,
provider recovery, devices/media, preferences, recordings, audit and superadmin
health endpoints remain. See docs/API.md and docs/MIGRATION.md.

The fresh application DB reports setupRequired=true. Initial superadmin setup
uses local /api/auth/setup before remote PUBLIC_ORIGIN hosting is enabled.

```dotenv
PORT=8101
FRONTEND_ORIGINS=http://127.0.0.1:3107,http://localhost:3107
COOKIE_SAME_SITE=Strict
```

Use matching frontend/backend hostnames for cookies. Configure the frontend with
NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:8101. CORS permits exact origins
only; writes retain X-Hik-Local/JSON checks. Vercel cross-site use needs HTTPS
PUBLIC_ORIGIN and Secure cookies for COOKIE_SAME_SITE=None. The API remains
loopback-bound; public reverse-proxy deployment is separate work.

## Data and future migration

PostgreSQL stores tenants, users, sessions, grants, encrypted provider state,
audit events and alerts. Recordings remain in private data/. Passwords use scrypt,
sessions are HttpOnly, provider state uses tenant-bound AES-GCM, and the runtime
role cannot be superuser or bypass RLS. Existing account/grant changes continue
to revoke affected sessions and close scoped streams. Local setup also applies
db/workspace.sql for per-user UI preferences and tenant-scoped channel observations.

DATABASE_URL can configure a future VPS database. Use a separate migration owner
and restricted runtime role; the preserved SQL assumes cam_app. Remote startup
does not apply schema automatically. Migrate keys/data deliberately. Tests remain
local by default. A database URL change does not convert Windows media to Linux.

Source: server.mjs (API), lib/ (services), db/ (schema), vendor/windows-sdk/
(adapter/native source), test/, tools/ and docs/. Keep .env, .local, data,
recordings, credentials, captures, logs and downloads out of Git.

No real provider login, DVR stream, VPS action or Linux migration was performed.
Browser microphone forwarding and historical DVR playback remain deferred.
Real renewal and sustained camera load require separate live acceptance.

## Isolated React acceptance testing

Run `npm run test:acceptance:serve`, then `npm run test:e2e` in the frontend repo.
This loopback-only API uses port 8109 and a disposable PostgreSQL database. All
synthetic recorders, telemetry, map tiles and encoded media originate on this test
backend. The ordinary server never imports it. Stop it with a POST to
http://127.0.0.1:8109/__acceptance/stop to remove its database and temporary files.
Do not expose this fixture or use its accounts in the application database.
