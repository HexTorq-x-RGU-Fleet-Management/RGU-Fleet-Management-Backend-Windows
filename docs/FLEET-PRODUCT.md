# RGU Fleet Management product model

HexTorq builds this bus fleet system for Rathinam Global University, Coimbatore.

A bus is the primary entity: bus number, registration, driver/contact and route.
One imported Hik-Connect recorder maps to one bus; its channels are cameras on
that same bus. A separate telemetry device supplies both GPS and fuel. Match
stable device IDs, never list order. Mappings are unique within a workspace.

All business data comes through authenticated backend APIs. Buses, account
permissions, UI preferences, recorder/channel observations and GPS/fuel samples
are persisted on the Windows backend. The frontend has no seeded recorders,
sample members, telemetry generator, demo role switch or browser-local fleet DB.
Only sidebar UI collapse is kept locally; passwords and provider grants are not.

Camera inventory/status come from Hik-Connect. Online recorder status does not
prove its channels work. Channels start unknown; a successful SDK preview/frame
records working availability. Known offline inventory is unavailable; auth/network
failures do not invent a camera-offline fact. Active SDK frames refresh the
observation; idle observations expire after five minutes. Admins star verified
channels for a bus view; stars never bypass server permissions.

React consumes actual SDK JPEG/H264 and PCM event streams. SDK/cloud credentials
remain encrypted on the backend. Real camera testing is pending while the
recorders are offline; automated media tests use an isolated backend fixture,
not a production fallback. No synthetic cameras are seeded into the application.

GPS/fuel vendor integration is phase 2. Optional simulator samples are generated
by an admin backend action and stored as source=mock JSONB before the frontend
reads them. Without stored observations, the UI shows missing data, never zero
fuel or invented motion. The source/time remain visible. One cursor correlates
stored position, speed, ignition and fuel. Camera archive playback stays deferred.

The future provider envelope contains message/success/serverTime/data,
data.pageNo/totalPage/vehicles, and vehicleNumber/deviceId/status/speed/odometer/
gpsTime/location/ignition/fuelData. Confirm actual units, pagination, authentication
and polling limits before enabling a vendor adapter. Keep its secrets server-side.
Do not interpret simulator fuel resets as theft/refuelling.

Road tiles are real OpenStreetMap data rendered with Leaflet in a Tamil Nadu
viewing rectangle; this is not an exact administrative mask or road routing.
See the frontend MAPS.md for attribution and external tile policy.

SaaS roles remain superadmin → approved workspace admin → restricted members.
The backend session and PostgreSQL RLS enforce ownership. UI gates are for
navigation, not authorization. Linux migration and the VPS remain unchanged.

