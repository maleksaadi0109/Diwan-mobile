# Installable Android build

The Replit web/mobile preview is **not** an APK. This project uses a cloud API
for YouTube audio. Bundled poem text and thumbnails work offline, but a new
install needs the published API to fetch and cache sample recordings.

1. Publish the project with **Public** access so its API Server is reachable
   from another person's phone. A private deployment will not work inside an
   APK. Verify
   `https://<published-host>/api/healthz`, and separately verify a sample audio
   download (the health endpoint does not test Python, yt-dlp or FFmpeg).
   Obtain the actual published URL from Replit's Publish view; **never** use
   `REPLIT_DEV_DOMAIN` or an Expo development URL in a distributed APK.
2. From `artifacts/mobile`, sign in with your own Expo account using
   `pnpm dlx eas-cli@latest login`, then run
   `pnpm dlx eas-cli@latest build:configure` to link this app to an Expo project
   and let Expo manage its Android signing key. Keep the checked-in `preview`
   build profile in `eas.json`.
3. Set `EXPO_PUBLIC_DOMAIN` in the **preview** EAS environment to the published
   hostname only (e.g. `example.replit.app`, **without** `https://`):
   `pnpm dlx eas-cli@latest env:create --environment preview --name EXPO_PUBLIC_DOMAIN --value <published-host> --visibility plaintext`.
   This value is public and is embedded in the APK. The build deliberately fails
   if it is missing or points at a temporary development URL.
4. Run `pnpm dlx eas-cli@latest build --platform android --profile preview`
   from `artifacts/mobile`. EAS provides a download link for the signed `.apk`.
   This `preview` build is standalone; it does not require Expo Go or Metro.
5. Install the APK on an Android phone using the EAS link, allowing installation
   from the phone's browser/files app if prompted. Open with internet access,
   wait for the three sample voices to download, play them, then try playback
   offline. Test this on a different phone/network before sharing the link.

Keep the same Android package name and Expo signing key for future updates.
Publishing Replit again does **not** update an APK already on someone's phone;
rebuild and share a new APK after mobile code changes. A published, publicly
reachable API can receive requests from other internet users, so review its
access controls and usage before broad distribution.
