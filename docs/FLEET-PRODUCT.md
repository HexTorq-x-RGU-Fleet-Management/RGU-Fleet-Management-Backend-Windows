# Product direction: RGU Fleet Management

HexTorq is building this for Rathinam Global University, Coimbatore.
This is a bus fleet product, not campus surveillance.

A bus is the main entity: internal bus number, registration, driver name/contact
and route. Map one imported recorder and one GPS/fuel device to each bus.
Each KPM recorder represents one bus; its 8/16 camera channels belong to that
same bus. The telemetry provider supplies fuel and GPS together. Correlate by
device ID, never by list position, vehicle display name or registration guessing.
Prevent duplicate recorder/device mappings within a workspace.

Import recorders separately. Allow buses to remain unmapped during setup.
Deleting a bus never deletes physical hardware or the Hik-Connect account.
Only working channels should enter automatic views; an online recorder does not
prove every channel works. Unknown channel health is distinct from unavailable.
Admins star channels for the bus default grid. Stars never grant permissions.
Members stay limited by server-side recorder/channel grants.

Use one timestamp cursor to inspect historical GPS, fuel, speed and ignition
together. This is telemetry replay, not recorded-camera footage playback.
Camera archive playback remains deferred. Store Unix-second GPS timestamps,
receipt times and source labels; expose stale and missing measurements.
Do not interpret mock fuel resets as refuelling or fuel theft.

The future provider is pull-based, with message/success/serverTime/data and
data.pageNo/totalPage/vehicles. Each vehicle contains vehicleNumber, deviceId,
status, speed, odometer, gpsTime, location.latitude/longitude/address, ignition,
fuelData.currentLiters/fuelPercentage. Match the user's supplied JSON shape.
Vendor auth, pagination, units, limits and history contract must be confirmed
before replacing the mock. Vendor credentials remain on the backend.

Current UI: explicit local mock preview, browser-persisted buses/stars, a
10-second mock refresh with minute-spaced samples, 30-minute/2-hour/6-hour mock
history, synchronized SVG coordinate route plot. This is not a road basemap or
a real location feed. No generated/stock imagery.

Current Windows API: PostgreSQL bus persistence, forced RLS, authenticated CRUD,
mock snapshot polling and stored telemetry/history. The frontend typed adapter
exposes these routes, but the preview screens do not call them yet.
Authenticated React/backend wiring, real camera health/live media integration
and the actual vendor adapter remain pending. Do not claim these are live or
production-verified. Linux and the VPS stay untouched.

