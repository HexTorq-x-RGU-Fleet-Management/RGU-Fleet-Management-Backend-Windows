# Fleet API and persistence

Active workspace authentication is required. Writes keep origin/JSON/X-Hik-Local
checks. Only workspace admins configure buses or trigger mock polling. Members
read buses/history only through nonempty viewing grants for the mapped recorder.
Favorites are intersected with member channel grants. Superadmins do not become
tenant admins implicitly. Both new tables use forced PostgreSQL RLS.

| Method | Route                                                 | Result                                                           |
| ------ | ----------------------------------------------------- | ---------------------------------------------------------------- |
| GET    | /api/fleet/buses                                      | Visible buses                                                    |
| POST   | /api/fleet/buses                                      | Create or replace editable fields; omit id to create             |
| POST   | /api/fleet/buses/remove                               | Remove by id; cascades stored bus telemetry                      |
| POST   | /api/fleet/mock/poll                                  | Persist last 2 hours of simulated minute samples                 |
| GET    | /api/fleet/wheelseye/sources                         | List safe WheelsEye source/device metadata                     |
| POST   | /api/fleet/wheelseye/sources                         | Validate, encrypt and add a WheelsEye URL                      |
| DELETE | /api/fleet/wheelseye/sources/:id                     | Remove a workspace WheelsEye source                            |
| GET    | /api/fleet/telemetry                                  | Latest stored mapped-device samples, vendor-shaped envelope      |
| GET    | /api/fleet/history?busId=UUID&from=SECONDS&to=SECONDS | Chronological history; maximum 24-hour window                    |

Bus fields: id, busNumber, registration, driverName, driverPhone, routeName,
recorderId, telemetryDeviceId, favoriteChannels. Mapping fields may be null.
Bus number/registration and recorder/device assignments are unique per workspace.
Recorder must already exist and be available in cam.devices. Favorites validate
inventory membership, not proof of live channel availability. Phone is optional.

History samples contain vehicle, source and receivedAt. Device timestamps use
Unix seconds. Remapping never labels old-device samples as the new device's.
Repeated polls deduplicate by bus/device/time. Simulator rows are explicitly mock;
they do not represent recovered real observations. Mock rows older than 24 hours
are cleaned during an admin poll. Unmapped buses return no telemetry.
Latest reads return at most 1000 visible buses. Vendor pagination remains future
adapter work; there is no arbitrary URL proxy or public telemetry ingestion URL.
WheelsEye URLs are accepted only from workspace admins, validated against the official
`https://api.wheelseye.com/currentLoc` host, and encrypted before storage. The backend
polls every configured source every 60 seconds. Device master records and location logs
are stored separately. The current-location response contains GPS, speed, ignition and
device power status; it does not contain fuel litres or fuel percentage.

Apply additive db/fleet.sql after schema.sql/grants.sql as migration owner.
npm run setup:local applies this only to the private local database. Baseline SQL
is unchanged. Tests use isolated databases; no demo buses/users/providers are
seeded in the application database.

Mock fuel resets and daily odometer cycles are simulator behavior. Do not use
them for consumption/refuelling analytics. The future vendor adapter must handle
poll limits, pagination, validation, stale/out-of-order data and retention policy.
