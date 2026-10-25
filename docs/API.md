# API-only extraction

This preserves V3 route semantics. The React frontend is not yet wired to all live
endpoints. Server authorization applies regardless of browser preview roles.

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

Authenticated SSE/video and PCM audio remain migration transport. Setting a
frontend environment alone does not implement session/device wiring or verify
live cameras. The Linux backend must implement matching behavior separately.
