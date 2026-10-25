# Diwan | ديوان

An Arabic poetry app for listening, learning, and creating personalized poetry videos.

Built with **React Native and Expo**, Diwan combines poetry recordings, synchronized verses, personal collections, and video creation tools in an Arabic-first interface.

## Download

[**Download Diwan for Android (APK)**](https://github.com/maleksaadi0109/Diwan-mobile/releases/download/diwan/diwan_mobile.apk)

The APK is approximately **257 MB**. Download it on your Android phone, open the file, and follow Android's installation prompts. If prompted, allow your browser or file manager to install this app; you can turn that permission off after installation.

The current release is for **Android**. Some features require a custom native build and are not available in Expo Go.

## Features

### Listen and follow along
- Listen to poetry recordings and follow synchronized, highlighted verses.
- Navigate between verses and return to passages you want to hear again.
- Listen offline to recordings saved on your device.

### Build your poetry library
- Save poems and their recordings in a personal library.
- Organize poems into playlists.
- Import poems and add recordings.
- Export and restore your library using the app's backup tools.

### Create poetry videos
- Create vertical videos suitable for Instagram Reels.
- Choose verses and an accompanying recording.
- Add multiple images and assign them to different sections of a poem.
- Customize Arabic fonts, text sizes, colors, alignment, and motion.
- Preview your design, generate a video, and share it manually through your phone.

### Learn and memorize
- Read verses while listening to their recitation.
- Revisit individual verses and work through a poem at your own pace.

## Technology

- **Expo and React Native** — Android application.
- **TypeScript** — application and API code.
- **Node.js API and Python worker** — audio processing and alignment.
- **FFmpeg** — media processing and video rendering.

## Project structure

| Directory | Purpose |
| --- | --- |
| `artifacts/mobile` | Expo mobile app and native Android modules |
| `artifacts/api-server` | Audio-processing and video-rendering API |
| `websites/diwan-website` | Standalone static download website, prepared for a separate repository |

## Development

This is a pnpm workspace. Install dependencies from the repository root:

```sh
pnpm install --frozen-lockfile
```

For native build requirements, signing, configuration, and Android build steps, see [the Android build guide](artifacts/mobile/BUILD-ANDROID.md).

The Replit workspace uses separate managed workflows for the mobile app and its API. See [the workspace notes](replit.md) for processing requirements and development details.

## Privacy and connectivity

Your library, playlists, and settings are stored on your device. Keep backups before uninstalling the app or clearing its data.

Downloaded recordings can be played offline. Audio alignment and server-rendered video creation need an internet connection. The video studio requests consent before uploading the media needed for server rendering.

## Feedback

[Open an issue](https://github.com/maleksaadi0109/Diwan-mobile/issues) to report a bug or suggest an improvement.

For bug reports, include your device model, Android version, app version, reproduction steps, and expected behavior. Remove personal information from screenshots, recordings, and logs.

## Content rights

Poems, recordings, images, and fonts remain subject to their respective owners' rights and applicable licenses. Make sure you have permission to use and share the content you add.

No software license is granted by this README. See individual dependency and asset licenses where applicable.

---

Made with a love for Arabic poetry.
