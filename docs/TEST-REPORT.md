# Windows backend verification - 25 October 2026

## Results

| Check                                           | Result                                                  |
| ----------------------------------------------- | ------------------------------------------------------- |
| JavaScript syntax and local source dependencies | 48 modules pass                                         |
| Node/PostgreSQL/API suite                       | 81 results pass, including nested subtests              |
| Native audio                                    | 6 tests pass                                            |
| Native video                                    | 4 tests pass                                            |
| Installed Windows SDK                           | x64 DLL loading and expected entry points pass          |
| Actual CLI startup                              | Health, metadata, frontend origin and setup status pass |
| Test cleanup                                    | No cam_test_* databases remain                          |
| Application data                                | Users, sessions and providers remain empty              |

The configured suite has zero failures or skips. Reproduce with
`npm run test:all` after private local setup. Node 24.21.0, PostgreSQL 17.11,
Python 3.13.15, PyAV 19.0.1 and Pillow 12.3.0 were available on this machine.

## Coverage

- Superadmin-only approval and password support; pending/suspended access denial.
- Authentication setup races, password policy, forced changes, expiration/logout
  and session invalidation after permission or account changes.
- Real PostgreSQL row policies, restricted runtime role and cross-workspace isolation.
- Admin/member camera and recording permissions, channel restrictions and account
  switching without inheriting another provider's access or preferences.
- Provider recovery leases, backoff, rejected credentials, verification challenges,
  token candidate validation, interrupted workers and revoked-camera removal.
- Recording upload, ownership, persistence, byte ranges, download/delete controls
  and storage-policy access.
- Audit scope, event redaction, retention/deletion records and immutable history.
- Superadmin health alerts, failure/recovery, deduplication and storage probes.
- API-only/private-path handling, allowed/hostile origins, preflight, required write
  headers, credentialed cookies and secure cross-site-cookie configuration.
- Python PCM/audio and H.264 video-encoder behavior using synthetic media.

## Verification boundary

The database is real and local. Test accounts, provider replies and media receivers
are synthetic and live in disposable test databases. The main application database
was not populated with the synthetic owner, members or provider credentials.
No real Hik-Connect sign-in, camera stream, live audio, SDK authorization renewal,
extended viewing, high-concurrency load or network-drop soak was performed.

SDK diagnostics loaded OpenNetStream.dll, HCNetSDK.dll and PlayCtrl.dll and resolved
OpenSDK_InitLib, OpenSDK_SetAccessToken and OpenSDK_AllocSessionEx. They did not call
initialization/login/playback functions or cloud APIs. DLL availability alone does
not prove a camera will play or that the installed account is currently authorized.

The original V3 browser-only recovery-view tests were not copied into backend
scope. No legacy frontend was included just to satisfy those two tests. The backend
retains 75 baseline results plus 6 new configuration/transport results.

No Linux runtime tests, VPS changes or production database access occurred.
The React frontend repository was not modified or claimed connected to live data.
The private PostgreSQL instance remains available for local development; the
temporary API used by the CLI smoke check was stopped.
