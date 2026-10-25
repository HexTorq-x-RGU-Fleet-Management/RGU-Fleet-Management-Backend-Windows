# API-only extraction

This preserves V3 route semantics and supports the separate authenticated React
frontend. Every API derives permissions from the server session.

| Area           | Routes / responsibilities                                        |
| -------------- | ---------------------------------------------------------------- |
| Service        | GET / and /api/health                                            |
| Authentication | /api/auth/status, /setup, /signup, /login, /logout, /password    |
| Platform       | Workspace approval, suspension, restoration and password support |
| Team           | /api/team and member grant/status/password operations            |
| Provider       | Account connection/disconnection and recovery retry/disable      |
| Cameras        | /api/devices, /api/previews/frame                                |
| Media          | Authenticated start/stop/status and separate video/audio events  |
| Preferences    | /api/preferences                                                 |
| Workspace UI   | GET /api/workspace; GET/POST /api/ui/preferences                 |
| Recordings     | Authenticated clip storage/settings/download/deletion            |
| Audit          | /api/audit with role and workspace scope                         |
| Health         | Superadmin monitoring and acknowledge/resolve                    |

Writes require JSON and X-Hik-Local: 1, except authenticated recording upload
which retains video/webm or video/mp4 plus recording metadata headers. The cookie
remains hik_saas. Identity and tenant scope are server-derived. Private source is
not served. Browser microphone forwarding explicitly reports unavailable.

FRONTEND_ORIGINS is an exact origin allowlist. Preflight permits GET/HEAD/POST
and required JSON, CSRF, user-binding, recording and range headers. Wildcard
credentialed CORS is unsupported. SameSite=None requires an HTTPS PUBLIC_ORIGIN
and Secure cookies. Use matching loopback hosts locally.

Authenticated SSE/video and PCM audio remain the current transport. The React
client decodes actual received H264/JPEG frames and selected-camera PCM audio.
The Linux backend must implement matching behavior separately.

`/api/workspace` returns the principal, PostgreSQL UI preferences, permitted cached
real inventory, buses and stored telemetry. UI writes validate known fields and
are scoped to the authenticated user. `db/workspace.sql` enforces row policies.
Channel availability is unknown until observed through the real preview/playback
path; recorder online alone does not prove a channel works. Observations expire
after five minutes, reject older timestamps and reset on provider account changes.
Cached frames retain their original observation time. `playbackReady` reflects
actual SDK authorization rather than the existence of a device list.

Requests may bind the expected user with X-Saas-User, and live sessions with
X-Hik-Connection. EventSource and recording video URLs carry the expected identity
as query parameters because these browser elements cannot set custom headers.
These identifiers are not credentials; the session cookie and server grants remain
required. CORS explicitly allows both identity headers for approved origins.
