# Installable Android build

The Replit web/mobile preview is **not** an APK. Android now downloads YouTube
audio **on the device** using a local native module, including the three sample
voices and catalog/Mizan YouTube imports. The MP3 is saved privately for offline
playback. No Diwan API is contacted by this download path. Internet access to
YouTube is still required for the first download; permission to save/distribute
the recording is required. YouTube may restrict individual videos.

This native component cannot run in Expo Go or the web preview. Build a new APK
from the updated source; publishing the API alone does not update an installed APK.
The native library includes Python, FFmpeg and QuickJS and increases APK size.
The APK includes the verified official stable yt-dlp engine `2026.08.19` (the latest
stable release checked on 2026-10-01). It validates the package's pinned SHA-256,
version and required components and installs it locally before downloading.
Engine preparation no longer requires a GitHub connection or the upstream updater.
If installation/validation fails, the app reports it instead of using the obsolete
library-bundled extractor or falling back to the server. Updating the pinned engine
requires building and installing a new APK. See the module README for details.
See `modules/diwan-downloader/README.md` for pinned versions and native limitations.
Start downloads while the app is visible. The Android foreground service then
owns the transfer when the screen is locked or the import page is closed, with a
progress notification and Cancel action. Android 13+ asks for notification
permission; denial does not prevent the service, but hides its notification from
the notification drawer. In-app cancellation remains available. No battery-policy
exemption is requested. OEM restrictions, force-stop and Android service time
limits can still interrupt work. Transfers are limited to one hour of audio,
120 MiB and an eight-minute service lifetime, one at a time.

The native journal and a separate saved import/sample intent recover completed
files after an app restart. Incomplete transfers are reported as interrupted,
not silently restarted. Manual retry uses a fresh operation; saving a recovered
completion never overwrites another recording or recreates a deleted target.
Failed library saves retain the completed download for retry. Optional server
alignment is not automatically resumed after process restart. See the verification
checklist below: these native lifecycle guarantees still require device testing.

Run `pnpm install --frozen-lockfile` from the repository root before EAS commands.

1. **Optional for Android downloads:** publish the project with **Public** access so its API Server is reachable
   from another person's phone if you want automatic verse alignment or the existing
   server-based upload/record processing. A private deployment will not work inside an APK. Verify
   `https://<published-host>/api/healthz`, and separately verify a sample audio
   download (the health endpoint does not test Python, yt-dlp or FFmpeg).
   Obtain the actual published URL from Replit's Publish view; **never** use
   `REPLIT_DEV_DOMAIN` or an Expo development URL in a distributed APK.
2. This app is linked to the existing `@malek20050109/mobile` Expo project.
   From `artifacts/mobile`, sign in to an account with access using
   `pnpm dlx eas-cli@latest login` if using the CLI. Reuse that project's
   existing Android signing key; do not initialize a different project.
   Keep the checked-in `preview` build profile in `eas.json`.
   For builds triggered through the Expo integration, connect the
   `maleksaadi0109/Diwan-mobile` repository in this Expo project's GitHub
   settings and set **Base directory** to `artifacts/mobile`. A successful
   CLI-uploaded build does not imply that this GitHub connection exists.
3. If using the optional API, set `EXPO_PUBLIC_DOMAIN` in the **preview** EAS environment to the published
   hostname only (e.g. `example.replit.app`, **without** `https://`):
   `pnpm dlx eas-cli@latest env:set --environment preview --name EXPO_PUBLIC_DOMAIN --value <published-host> --visibility plaintext`.
   This value is public and is embedded in the APK. The build deliberately fails
   if it is supplied but invalid or points at a temporary development URL.
4. Run `pnpm dlx eas-cli@latest build --platform android --profile preview`
   from `artifacts/mobile`. EAS provides a download link for the signed `.apk`.
   This `preview` build is standalone; it does not require Expo Go or Metro.
5. Install the APK on an Android phone using the EAS link, allowing installation
   from the phone's browser/files app if prompted. Open with internet access,
   wait for the three sample voices to download, play them, then try playback
   offline. Also test a catalog import with automatic alignment OFF while the Diwan
   API is unavailable: it must download/save/play without that API. Test progress,
   cancellation, login-restricted videos, lack of storage, and retaining existing
   recordings on a real Android phone/tablet before sharing. The optional alignment
   switch uploads the already-downloaded MP3 to the API; an alignment failure
   retains the saved local recording.

Keep the same Android package name and Expo signing key for future updates.
Publishing Replit again does **not** update an APK already on someone's phone;
rebuild and share a new APK after mobile code changes. A published, publicly
reachable API can receive requests from other internet users, so review its
access controls and usage before broad distribution.

## Foreground-download verification (required before release)

The workspace JS tests and typecheck pass, but this change has **not** been
exercised on an Android device in this environment. A cloud `preview` APK build
succeeded on 2026-10-01 with compileSdk/targetSdk 36 and Android versionCode 2.
Inspection of that APK confirmed the non-exported `dataSync` download service,
required permissions, and compiled downloader, coordinator and journal classes.
These are packaging checks, not evidence of screen-lock or recovery behavior.
The workspace has JDK 17 for standalone checks, but no Android SDK, Gradle/adb
or connected Android device. Engine-stage diagnostics also compiled in a later
cloud APK with Android versionCode 3. The pinned-engine installer also compiled
successfully in versionCode 4; APK inspection verified the engine's pinned SHA-256,
version, required components and foreground-service manifest. It has not yet been
validated successfully on a device: a fresh retry reported `E_ENGINE_PACKAGE_INVALID`.
The cause was Android's `ZipFile` rejecting the official engine's Python launcher
prefix. The versionCode 5 correction preserves the full engine digest and validates
its ZIP body with a bounded streaming parser. Run `pnpm run test:engine-zip` from
`artifacts/mobile` with JDK 17; these checks also run before Android EAS compilation.
They passed on the exact official asset locally and in the versionCode 5 cloud
build. That APK compiled successfully; inspection confirmed the corrected validator,
unchanged engine digest and foreground-service manifest. These checks do not
replace device/lifecycle tests, which remain pending for this correction.
An installed versionCode 5 attempt reached 99% and then reported a generic storage
failure despite available space. VersionCode 6 adds safe stage/errno diagnostics
and removes misleading low-space wording except when the OS reports space/quota
exhaustion. It does not change no-overwrite publication or promise that the
underlying device failure is fixed; its native build and device checks are pending.
The first diagnostic APK build failed at compilation due to a file-descriptor type
error; this is corrected. Its production storage code passes a partial Kotlin
typecheck against the official API 36 platform jar. With Kotlin and that jar
available, run `pnpm run test:android-storage-types /path/to/android.jar` from
`artifacts/mobile`. This check does not run Android or replace a full APK build.
The corrected versionCode 6 APK has now built successfully. Native storage
diagnostics are present in its DEX, the pinned engine hash is unchanged, and its
package/public signing certificate match versionCode 5. Install as an update;
do not uninstall or clear data. Make a fresh retry to obtain the new error code.
The original storage failure and physical-device lifecycle checks are still
unresolved, so this is a diagnostic build, not a verified download fix.
The device reported `PUBLICATION_LINK:EACCES` from that diagnostic build.
VersionCode 7 prepares new-only format-2 publication using an exclusive token
bundle, synced copies and journal-backed marker/identity/SHA-256 proof, without
hardlink or rename. Legacy paths/journals stay unchanged; backup restores remain
flat. All 185 mobile tests/typecheck pass and the production storage helper
compiles against official API 36 signatures. Its full APK build and physical
save/playback, background/restart and cancelled-transfer cleanup are pending.
Web preview/Expo Go cannot verify this native module. Do not treat the checklist
below as a record of successful device tests.

After linking EAS and building the `preview` APK, or using a local JDK/Android SDK
with `pnpm exec expo prebuild --platform android` and `./gradlew :app:assembleDebug`:

1. Verify autolinking includes `diwan-downloader`, and the merged manifest contains
   the non-exported `DownloadService`, `dataSync` type, foreground/data-sync,
   wake-lock and notification permissions. compileSdk must be at least 35.
2. Install on a physical Android device (include Android 13, 14 and 15+ coverage).
   Test granting and denying notifications, starting in the foreground, and
   rejecting new starts after backgrounding. With a public permitted video, lock
   the screen and leave the import page; confirm one transfer, notification
   progress and eventual offline playback after returning. Test all sample voices
   and a catalog/Mizan import without access to the Diwan API.
3. Cancel in the notification and in the recovered import/sample UI during engine
   preparation, transfer, conversion and completion. Confirm no partial staging
   files remain after worker termination, or that cleanup failures stay visible
   and can be retried. Confirm an already saved recording survives repeated cancel.
4. Kill the app process in a debuggable test build while a transfer is running,
   relaunch and confirm an interrupted operation with manual retry, not a
   duplicate worker. Separately force-stop/reboot: continuation is **not** promised.
   Kill after publication but before library save; confirm one completed file is
   adopted on relaunch. Kill after save but before acknowledgement; confirm the
   recording is retained and not attached twice or discarded.
5. While downloading, delete/edit the target poem or add another recording.
   Verify no resurrection/overwrite and cleanup of only the unowned new file.
   Simulate library/journal write failure and low storage: completed files remain
   recoverable and saved recordings are never deleted by cleanup.
6. Test battery-saver/OEM background restrictions and network loss. On Android 15+
   exercise `dataSync` timeout behavior (use the OS test controls or a short test
   timeout in a test build); confirm service/wake lock end, an actionable error,
   and no new background service starts.
7. In a local debuggable build run
   `./gradlew :diwan-downloader:connectedDebugAndroidTest` for the journal,
   publication-witness, cancellation-cleanup and no-overwrite instrumentation
   tests. These supplement, not replace, the real YouTube/lifecycle checks.
