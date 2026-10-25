# RGU Fleet Management Windows Backend

Repository: https://github.com/HexTorq-x-RGU-Fleet-Management/RGU-Fleet-Management-Backend-Windows

## Status

Initial repository scaffold. Hikvision V3 API extraction has not started.
There is no backend entry point, package installation or runnable API here yet.

## Purpose and target

Extract the existing V3 SaaS backend for independent Windows deployment. Planned
runtime remains Node.js, PostgreSQL, Python media packages and the authorized
Windows vendor SDK. Preserve account/session formats, tenant isolation, row-level
security, role permissions, provider recovery, recording storage, audit and health
behavior. Frontend rendering will belong to the separate frontend project.

The backend owns camera authorization and media delivery. The Windows SDK adapter
must stay behind the same API/media contract used by the Linux backend. A separate
frontend deployment requires explicit origin/cookie/CSRF configuration.

## Migration references

- [V3 backend and tests](https://github.com/HexTorq-CCTV-Camera-Web/Hik-Vision/tree/standalone-baseline-2026-10-25/v3)
- [Verified SDK bundle](https://github.com/HexTorq-CCTV-Camera-Web/Hik-Vision/tree/standalone-baseline-2026-10-25/sdk)

Local source on the original workstation: ../../Camera/hikvision/v3/ and
../../Camera/hikvision/sdk/. These are migration references only. The extracted
backend must own its source/runtime dependencies rather than import sibling files.
The SDK binary bundle does not provide application identity, account access or
playback authorization by itself. Existing renewal limitations remain to verify.

## Related projects

- [Frontend](https://github.com/HexTorq-x-RGU-Fleet-Management/RGU-Fleet-Management-Frontend)
- [Linux backend](https://github.com/HexTorq-x-RGU-Fleet-Management/RGU-Fleet-Management-Backend-Linux)

Both backends must retain matching API behavior, tenant policies and media formats.
Database migration history and contract tests must stay aligned between them.

## Checkout and repository policy

```sh
git clone https://github.com/HexTorq-x-RGU-Fleet-Management/RGU-Fleet-Management-Backend-Windows.git backend-windows
cd backend-windows
```

.gitignore excludes dependencies, Python environments, account stores, Windows
DPAPI material, PostgreSQL/runtime directories, recordings, captures and logs.
Never migrate real secrets or user data as source. Windows-protected keys are
not portable Linux configuration. No database or provider configuration was
changed by creating this repository. No application tests or deployment ran here.
