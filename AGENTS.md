# Windows backend rules

Production camera inventory, channel health and media must use the actual
Hik-Connect/SDK integration. Mock GPS/fuel observations are stored as JSONB with
source=mock. Synthetic devices/media exist only in the isolated acceptance tool,
never imported into server.mjs or seeded into the application database.

Product model: docs/FLEET-PRODUCT.md. Buses map one recorder and one combined
GPS/fuel device. Keep tenant isolation, stable device mapping, timestamps and
source labels. Never infer channel health from recorder online status alone.

Work in this repository; do not import sibling source. Frontend, Linux backend,
reference archives and VPS changes require their own task scope.
Preserve tenant/RLS isolation, authoritative sessions, grants and encrypted state.
Do not serve a duplicate frontend. Follow the separate frontend API contract.
Use private local fixtures; never use production data as test fixtures.
Keep secrets, .env, .local, recordings, logs and downloads outside Git. Never
print plaintext credentials, provider grants or raw SDK callback diagnostics.
Run appropriate checks and npm run test:all before reporting behavior changes.
SDK diagnostics inspect/load only; synthetic checks are not live camera proof.
The user requires clear commits, push and synchronization verification for each
affected repository before the final report. Report unresolved push blockers.
Git publishing is authorized; deployment is not implied. No image generation or
stock imagery is needed. Native camera media tests are a separate concern.
