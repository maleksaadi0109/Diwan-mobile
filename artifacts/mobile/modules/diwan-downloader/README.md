# DiwanDownloader (Android only)

Local Expo module, registered by Expo's `./modules` autolinking. Requires a **rebuilt Android binary**, compileSdk >=35 (Android 15 timeout API), and the existing native-packaging config plugin. Not available in Expo Go, web or iOS. Downloads run locally; there is no Diwan API/server fallback. Users must have permission to save the media and comply with copyright/platform terms.

## Native API

All methods return promises. The module name is `DiwanDownloader`.

- `start(url: string, recordingId: string): Promise<void>`: requires a resumed app activity; validates and canonicalizes a single public HTTPS YouTube watch/shorts/youtu.be URL. Persists a queued record **before** requesting the foreground service. Resolves when that request succeeds, not when audio finishes. The same ID/canonical URL is idempotent, including terminal records; a different URL for an existing ID rejects `E_ID_CONFLICT`. One engine operation process-wide; another ID rejects `E_BUSY`. IDs must match `[A-Za-z0-9_-]{1,100}`. Existing destination audio is never overwritten.
- `list(): Promise<Array<{recordingId: string, url: string, state: 'queued'|'running'|'completed'|'failed'|'cancelled'|'interrupted', progress: number, audioUrl?: string, durationMs?: number, errorCode?: string}>>`: durable journal snapshot, with canonical URLs and progress 0–1. Poll this API; no progress event subscription is required or currently emitted. Completion includes a private `file://` MP3 URL and duration. Progress is persisted at whole-percent boundaries; conversion occupies the last ~1%.
- `cancel(id: string): Promise<void>`: records cancellation and repeatedly requests process termination until the worker exits. Unknown/terminal IDs are no-ops. **Never deletes completed audio**, including the save/acknowledge race. Repeated cancellation is safe.
- `acknowledge(id: string): Promise<void>`: call **only after the library has durably saved the completion**, before allowing subsequent discard. Removes a terminal journal entry and staging/witness files, never the final audio. A durable adoption marker makes interrupted acknowledgement safe. Unknown IDs are no-ops.
- `discard(id: string): Promise<void>`: removes terminal journal/staging state; deletes an unadopted published completion **only** when its retained hard-link witness, journal device/inode and final inode prove ownership. Never deletes a preexisting/replaced file. Unknown IDs are no-ops. After acknowledgement it cannot find or delete the final file. An active/terminating worker rejects removal with `E_BUSY`; retry after resource release.

An unacknowledged completion is *not yet adopted* from the native module's perspective. JS must reconcile it into its library and acknowledge it; this module cannot infer whether JS saved its separate library database. Do not call discard on an adopted-but-not-yet-acknowledged completion.

Errors include `E_INVALID_URL`, `E_FOREGROUND_REQUIRED`, `E_ID_CONFLICT`, `E_BUSY`, `E_STORAGE`, `E_SERVICE_START`, `E_CANCELLED`, `E_LOGIN_REQUIRED`, `E_ENGINE_UPDATE`, `E_DOWNLOAD_FAILED`, `E_TIMEOUT`, `E_SIZE_LIMIT`, `E_FGS_TIMEOUT`, `E_SERVICE_STOPPED`, `E_INTERRUPTED`, `E_PROVENANCE`, and `E_CLEANUP`. Promise failures cover API/storage errors; transfer failures are reported by `list`. A corrupt journal rejects explicitly rather than guessing file ownership. Failed cleanup remains visible in the journal and is retried on recovery/removal.

## Service and lifecycle

`DownloadService` owns work independently of Expo module/activity destruction. Its nonexported `dataSync` foreground service has a low-importance notification channel, progress, app-launch intent and a cancel action containing **both recording ID and unique attempt token**. It survives activity teardown/task removal when Android permits. No boot receiver, sticky restart, battery exemption, external-storage permission or background auto-start exists.

Manifest permissions: `INTERNET`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_DATA_SYNC`, `POST_NOTIFICATIONS`, `WAKE_LOCK`. **JS must request runtime notification permission on Android 13+** before starting if visible notifications/cancellation are desired. Android permits foreground services without that permission but hides their drawer notifications; OS foreground-service startup restrictions still apply. Notification permission is not requested by this native adapter.

A bounded partial wakelock covers at most 8 minutes plus 5 seconds. An independent service deadline begins before engine initialization, and a watchdog monitors cancellation, total stage size and the 8-minute wall budget. Android 15's `onTimeout(startId, fgsType)` records failure and stops foreground execution. The module does not extend Android's cumulative dataSync budget.

**Hard limitation:** upstream metadata fetch/initialization can block inside non-interruptible library code. At deadline/cancel the module marks failure/cancellation, releases its wakelock and stops the foreground service; it does **not** claim to forcibly interrupt that Java call or keep it alive afterward. It retains the process-wide engine gate until the call actually returns (new work reports `E_BUSY`), and checks cancellation before any later execute/publication. Stage cleanup is deferred until the worker exits, or performed during next-process recovery. This prevents concurrent updater/engine corruption but can require process restart after an indefinitely hung updater. OS scheduling, frozen processes and filesystem stalls also preclude a hard real-time deadline guarantee. Upstream child-process cancellation is best-effort and needs device testing.

## Durability and file ownership

`DownloadStore` uses private `noBackupFilesDir/diwan-download-journal` AtomicFile records, synced data/directory writes, UUID-derived cache stage paths and same-filesystem hidden publication witnesses under `filesDir/recording-audio` (Expo Android documentDirectory). There is no glob-based deletion of old audio.

Publication copies and fsyncs the MP3 witness, saves its device/inode and validated duration, then uses **atomic hard-link/no-replace** publication. The witness remains until acknowledgement/discard. If the process dies between linking and journaling completion, recovery recognizes the shared inode and completes the record without rerunning the engine. Preexisting targets and replaced files cannot pass that test. An interrupted unlinked attempt is marked `interrupted`; only its known stage/witness paths are cleaned. No interrupted worker silently restarts. Completed audio is preserved on cancel, failure and normal service destruction. Missing or inconsistent provenance becomes an explicit error, not permission to delete an unrelated file. The filesystem must support hard links and fsync; failures are surfaced.

Recovery occurs on the first native API/service access in a new process, not on boot. Force-stop/process death can prevent completion; callers must reconcile journal records when opening the app. If the app saved the library but died before acknowledgement, JS must detect its existing library entry and acknowledge the matching completion rather than discard it.

## Engine protections and upstream limitations

Pinned Maven Central libraries: `io.github.junkfood02.youtubedl-android:{library,ffmpeg}:0.18.1`; source: https://github.com/yausername/youtubedl-android/tree/0.18.1 . Upstream bundles Python, yt-dlp, FFmpeg and QuickJS and injects its runtime paths. Distribution/license and FFmpeg codec/patent obligations require review.

Before the first transfer per app/native-library version and after 24 hours since the last successful check, the serialized worker invokes **only** `YoutubeDL.updateYoutubeDL(context, UpdateChannel.STABLE)`. The successful timestamp is committed only after the updater returns and the installed zipapp is nonempty, readable, includes `__main__.py`, `yt_dlp/version.py` and the bundled EJS solver, and matches the reported tag. Failed checks reject `E_ENGINE_UPDATE`, not a fallback to the old extractor. Cancellation is checked around initialization/update and before execute/publication.

Upstream STABLE reads `https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest`, selects the asset named `yt-dlp`, and downloads its metadata-provided `browser_download_url`. Asset download uses 5-second connect/10-second read timeouts, but Jackson's metadata `readTree(URL)` has **no explicit finite timeout**. Upstream independently verifies neither asset host/scheme/redirects nor checksum/signature, and has no total asset byte cap. These are upstream trust/availability limitations; zip/version checks are **structural, not cryptographic authentication**. No caller-selected updater channel, executable URL, cookies, login, TLS bypass or remote-components option is exposed.

Only reconstructed canonical video URLs and fixed request options reach yt-dlp: ignore config, no playlist, no simulation/overwrites/continue, 2 retries, 20-second socket timeout, 120 MiB maximum, non-live duration <=1 hour, best audio converted to MP3. Final size and media duration are checked. No server fallback. Current YouTube compatibility is not guaranteed by these checks.

Native binaries require `extractNativeLibs=true` and `expo.useLegacyPackaging=true` from the existing application config plugin.

## Verification status

This implementation has **not been compiled or run on an Android device here**: `java`, `gradle`, `kotlinc` and `/usr/lib/jvm` were not present when checked. Source/static review is not native validation.

Android instrumentation tests under `android/src/androidTest` cover interrupted-record cleanup, the publication/journal crash window, no-replace behavior, acknowledgement preserving final audio, owned discard, and replaced-file provenance refusal. They use synthetic bytes solely to test storage (not media decoding/network). They have **not been executed**.

With an Android SDK/JDK installed, regenerate/rebuild the app with Expo, assemble the Android binary and run this module's `connectedDebugAndroidTest` task on an emulator/device. Also test public/private/login/live/playlist/oversize links, notification permission denial, screen off, activity recreation, task removal, process kill during every publication/adoption step, cancellation before service/execute startup, stale notification actions, duplicate IDs, low storage/journal write failure, hung updater and Android 15 service timeout. Real direct downloads and long screen-off operation must be validated on physical devices before claiming support.