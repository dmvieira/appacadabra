# Capability Return Value Map

All Appacadabra capability callbacks follow the convention `callback(success, data)`:
- `success` — boolean
- `data` — **already a native JS value** (object, array, string, or number). Never a JSON string. Never call `JSON.parse()` on it.

When `success` is `false`, `data` is always a plain error string.

Capabilities where `handleMessage()` returns `null` (clipboard, ui) have no native bridge — they are pure WebView JS.

---

## AI

| Action | `data` type | Shape / Notes |
|---|---|---|
| `AI_GENERATE` | `string` | Generated text; JSON string if `withSchema` used — parse it manually |
| `AI_SIMILARITY` | `string` | JSON — `{ matrix: number[][], vectors: number[][], count: number }` — parse manually |
| `AI_GENERATE_IMAGE` | `string` | Base64 PNG |
| `AI_GENERATE_VIDEO` | `string` | File path or base64 MP4 |

> All AI actions also include `creditsUsed: number` and `isFirstAiUse: boolean` in the HandlerResult (not in `data`).

---

## Audio

| Action | `data` type | Shape / Notes |
|---|---|---|
| `TTS_SPEAK` | `string` | `"Speaking"` |
| `TTS_STOP` | `string` | `"Stopped"` |
| `TTS_IS_SPEAKING` | `string` | `"true"` or `"false"` — use `data === "true"` |
| `AUDIO_SPEAK_AI` | `string` | Blob marker path or base64 audio; falls back to device TTS on failure |
| `AUDIO_RECORD_START` | `string` | `"Recording started"` |
| `AUDIO_RECORD_STOP` | `string` | Blob marker or base64 m4a audio |

---

## Calendar

| Action | `data` type | Shape / Notes |
|---|---|---|
| `CALENDAR_CREATE_EVENT` | `string` | `"Calendar opened"` |
| `CALENDAR_CREATE_EVENT_REMINDER` | `string` | `"Calendar opened"` |
| `CALENDAR_GET_EVENTS` | `array` | `[{ id, title, startDate, endDate, allDay, location, notes, calendarId, calendarName, attendees: [{ name, email, status, isCurrentUser }] }]` — empty array if no permission |
| `CALENDAR_DELETE_EVENT` | `string` | `"Event deleted"` |

---

## Camera

| Action | `data` type | Shape / Notes | Deferred |
|---|---|---|---|
| `CAMERA_TAKE_PHOTO` | `string` | Blob marker or base64 JPEG | No |
| `CAMERA_RECORD_VIDEO` | `string` | Blob marker or base64 MP4 | No |
| `VIDEO_PLAY` | `string` | `"Playing"` — callback fires when video finishes | Yes |
| `VIDEO_STOP` | `string` | `"Stopped"` | No |
| `VIDEO_IS_PLAYING` | `string` | `"true"` or `"false"` | No |
| `SCANNER_SCAN` | `string` | `"Scanner opened"` on start; callback fires with scanned value when code detected | Yes |

---

## Clipboard

No native bridge. Pure WebView Web API (`navigator.clipboard`). No callbacks.

---

## Contacts

| Action | `data` type | Shape / Notes |
|---|---|---|
| `CONTACTS_SEARCH` | `array` | `[{ id, name, firstName, lastName, phoneNumbers: [{ number, label }], emails: [{ email, label }], company, jobTitle, ... }]` — max 50 results |
| `CONTACTS_ADD` | `string` | `"Contact form presented"` |
| `CONTACTS_UPDATE` | `string` | Contact ID, or fallback message if update fails |

---

## Device

| Action | `data` type | Shape / Notes |
|---|---|---|
| `DEVICE_GET_BATTERY_LEVEL` | `string` | e.g. `"0.85"` — use `Number(data)` to convert |
| `DEVICE_IS_CHARGING` | `string` | `"true"` or `"false"` — use `data === "true"` |
| `DEVICE_GET_NETWORK_INFO` | `string` | `"Wi-Fi"`, `"Cellular"`, `"None"`, or `"Unknown"` |
| `DEVICE_IS_ONLINE` | `string` | `"true"` or `"false"` — use `data === "true"` |
| `VIBRATE` | `string` | e.g. `"Vibrated 100ms"`, `"Vibrated (Android Pattern)"`, `"Vibration cancelled"` |

---

## Docs

| Action | `data` type | Shape / Notes | Deferred |
|---|---|---|---|
| `DOCS_CREATE` | `object` | `{ docId: string, url: string }` | No |
| `DOCS_GET` | `object` | `{ title: string, content: string }` (content is Markdown); offline cache: `{ ...same, cached: true }` | No |
| `DOCS_APPEND_TEXT` | `object` | `{ docId: string }`; offline queued: `{ queued: true }` | No |
| `DOCS_SET` | `object` | `{ docId: string }`; offline queued: `{ queued: true }` | No |
| `DOCS_WATCH` | `object` | Initial + on-change: `{ title, content, initial: boolean, cached?: boolean }`; offline: `{ offline: true }` | Yes |
| `DOCS_STOP_WATCH` | `object` | `{ stopped: true }` | No |
| `CONVERT` | `string` | HTML, Markdown, or base64 PDF depending on `to` param | No |

---

## Forms

| Action | `data` type | Shape / Notes | Deferred |
|---|---|---|---|
| `FORMS_CREATE` | `object` | `{ formId: string, shareUrl: string }` | No |
| `FORMS_UPDATE` | `object` | `{ formId: string, shareUrl: string }` | No |
| `FORMS_GET_RESPONSES` | `object` | `{ responses: [{ responseId, submitTime, answers: { "Question title": "answer" } }] }`; offline cache: `{ responses: [...], cached: true }` | No |
| `FORMS_WATCH_RESPONSES` | `object` | Initial + on-change: `{ responses, newResponses, initial: boolean, cached?: boolean }`; offline: `{ offline: true }` | Yes |
| `FORMS_STOP_WATCH_RESPONSES` | `object` | `{ stopped: true }` | No |

---

## Health

| Action | `data` type | Shape / Notes |
|---|---|---|
| `HEALTH_INITIALIZE` | `string` | `"Health Connect initialized"` |
| `HEALTH_GET_STEPS` | `object` | `{ totalSteps: number, records: [{ startTime: ISO, endTime: ISO, count: number }] }` |
| `HEALTH_GET_HEART_RATE` | `array` | `[{ startTime: ISO, endTime: ISO, samples: [{ time: ISO, beatsPerMinute: number }] }]` |
| `HEALTH_GET_EXERCISE` | `array` | `[{ startTime: ISO, endTime: ISO, exerciseTypeName: string, exerciseType: number, title: string\|null, notes: string\|null, metadata }]` |
| `HEALTH_GET_SLEEP` | `array` | `[{ startTime: ISO, endTime: ISO, title: string\|null, stages: [{ startTime: ISO, endTime: ISO, stage: "AWAKE"\|"LIGHT"\|"DEEP"\|"REM"\|"UNKNOWN" }] }]` |
| `HEALTH_GET_CALORIES` | `object` | `{ totalCalories: number, records: [{ startTime: ISO, endTime: ISO, energy: { inKilocalories: number } }] }` |

---

## Notify

| Action | `data` type | Shape / Notes |
|---|---|---|
| `NOTIFY_SHOW_NOW` | `string` | Notification ID or `"Notification sent"` |
| `NOTIFY_SCHEDULE` | `string` | Notification/alarm ID; edit mode: `{ skipped: true, reason: "edit_mode" }` |
| `NOTIFY_GET_SCHEDULED` | `array` | `[{ id, title, body, trigger: { type: "timeInterval"\|"date", value: number }, isAlarm: boolean }]` |
| `NOTIFY_CANCEL` | `string` | `"Alarm cancelled"` or `"Notification cancelled"`; edit mode: `{ skipped: true }` |
| `NOTIFY_CANCEL_ALL` | `string` | e.g. `"Cancelled 2 notifications and 1 alarms"`; edit mode: `{ skipped: true }` |

---

## Screen

| Action | `data` type | Shape / Notes |
|---|---|---|
| `SCREEN_CAPTURE` | `string` | Base64 PNG |
| `PRINT` | `string` | `"Print dialog opened"` |

---

## Sensors

All `start` actions have `deferredCallback: true` — the initial result confirms the sensor started; subsequent callback invocations deliver live data.

| Action | Initial `data` | Ongoing callback `data` | Deferred |
|---|---|---|---|
| `SENSORS_START_ACCELEROMETER` | `{ status: "started", sensor: "accelerometer" }` | `{ x: number, y: number, z: number }` (Gs) | Yes |
| `SENSORS_START_GYROSCOPE` | `{ status: "started", sensor: "gyroscope" }` | `{ x: number, y: number, z: number }` (rad/s) | Yes |
| `SENSORS_START_MAGNETOMETER` | `{ status: "started", sensor: "magnetometer" }` | `{ heading: number, x: number, y: number, z: number }` | Yes |
| `SENSORS_START_PEDOMETER` | `{ status: "started", sensor: "pedometer" }` | `{ steps: number }` | Yes |
| `SENSORS_START_SPEEDOMETER` | `{ status: "started", sensor: "speedometer" }` | `{ speed: number }` (km/h) | Yes |
| `SENSORS_START_GPS` | `{ status: "started", sensor: "gps" }` | `{ latitude, longitude, altitude, heading, speed }` | Yes |
| `SENSORS_STOP_ACCELEROMETER` | `{ status: "stopped", sensor: "accelerometer" }` | — | No |
| `SENSORS_STOP_GYROSCOPE` | `{ status: "stopped", sensor: "gyroscope" }` | — | No |
| `SENSORS_STOP_MAGNETOMETER` | `{ status: "stopped", sensor: "magnetometer" }` | — | No |
| `SENSORS_STOP_PEDOMETER` | `{ status: "stopped"\|"not_running", sensor: "pedometer" }` | — | No |
| `SENSORS_STOP_ALL` | `{ status: "stopped_all" }` | — | No |

---

## Share

| Action | `data` type | Shape / Notes |
|---|---|---|
| `SHARE_CONTENT` | `string` | `"Shared"` or `"Dismissed"` |
| `SHARE_FILE` | `string` | `"File shared"` |

---

## Sheets

| Action | `data` type | Shape / Notes | Deferred |
|---|---|---|---|
| `SHEETS_CREATE` | `object` | `{ sheetId: string, url: string }` | No |
| `SHEETS_APPEND_ROWS` | `object` | `{ updatedRows: number }` | No |
| `SHEETS_GET_ROWS` | `object` | `{ headers: string[], rows: [{ "ColName": "value" }] }`; offline cache: `{ ...same, cached: true }` | No |
| `SHEETS_WATCH` | `object` | Initial + on-change: `{ rows, headers, added, changed, deleted, initial: boolean, cached?: boolean }`; offline: `{ offline: true }` | Yes |
| `SHEETS_STOP_WATCH` | `object` | `{ stopped: true }` | No |
| `SHEETS_SET_ROWS` | `object` | `{ rowsWritten: number }`; offline queued: `{ queued: true }` | No |

---

## UI

No native bridge. Pure WebView JS (`showLoader`, `hideLoader`, `toast`). No callbacks.
