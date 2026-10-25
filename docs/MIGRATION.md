# Extraction record

Source: Hik-Vision standalone-baseline-2026-10-25/v3. Backend lib/, db/, native
adapter source and backend tests were copied without private state or browser UI.

Changes: API-only routing, explicit frontend CORS/cookie policy, independent local
setup, port 8101, safe diagnostics and verification tools. SaaS SQL, row policies
and grants were not rewritten. Hashes are in tools/migration-origin.json.
Auth/provider/audit/recording business logic is retained.

Two old tests importing browser recovery-view helpers were excluded from backend
scope. The remaining 75 baseline backend results plus 6 configuration/transport
results form the 81-result Node suite. Native Python tests are separate.

Installed SDK DLLs remain external dependencies. The full baseline retains its
binary bundle; it was not duplicated into this repository. PostgreSQL binaries,
state, keys and downloads stay in ignored .local/. Local data is fresh; no real
production users or provider grants were imported.
