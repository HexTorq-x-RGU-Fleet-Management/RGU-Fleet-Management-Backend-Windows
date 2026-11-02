# Historical DVR playback

Windows V2 now exposes a separate recorded-footage path alongside live viewing:

- `POST /api/playback/search` searches the selected recorder/channel for a date-time range through `OpenSDK_StartSearchEx`.
- `POST /api/playback/start` opens the selected range through `OpenSDK_StartPlayBackEx` and uses the same decoded browser stream as live video.
- `POST /api/playback/control` accepts `pause`, `resume`, `seek`, `scale` (0.25–16x), and `stop`.

The camera workspace includes a date/from/to search panel and transport controls. Playback remains workspace-authorized and requires the saved Hik-Connect playback grant. The Linux backend intentionally does not claim this capability until an equivalent native Linux SDK is available.

The OpenSDK search callback is bounded and whitelisted; opaque callback text is never returned to the browser or logs.
