import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('local Android module build metadata', () => {
  it('declares the version metadata required by the Expo module publication plugin', () => {
    const gradle = readFileSync(
      new URL('../modules/diwan-downloader/android/build.gradle', import.meta.url),
      'utf8',
    );
    const moduleVersion = /\bversion\s*=\s*['"]([^'"]+)['"]/.exec(gradle)?.[1];
    const defaults = /\bdefaultConfig\s*\{([^}]+)\}/.exec(gradle)?.[1] ?? '';
    const androidVersion = /\bversionName\s+['"]([^'"]+)['"]/.exec(defaults)?.[1];
    expect(moduleVersion).toBeTruthy();
    expect(androidVersion).toBe(moduleVersion);
    expect(defaults).toMatch(/\bversionCode\s+[1-9]\d*\b/);
  });

  it('declares React Native explicitly for the adapter lifecycle imports', () => {
    const gradle = readFileSync(
      new URL('../modules/diwan-downloader/android/build.gradle', import.meta.url),
      'utf8',
    );
    expect(gradle).toMatch(/\bimplementation\s+['"]com\.facebook\.react:react-android['"]/);
  });

  it('uses public Android APIs to validate a directory before syncing it', () => {
    const store = readFileSync(
      new URL('../modules/diwan-downloader/android/src/main/java/com/diwan/downloader/DownloadStore.kt', import.meta.url),
      'utf8',
    );
    expect(store).not.toContain('OsConstants.O_DIRECTORY');
    expect(store).toContain('OsConstants.S_ISDIR(Os.fstat(fd).st_mode)');
  });

  it('keeps native engine failures stage-specific and checks cancellation before remapping initializer exceptions', () => {
    const engine = readFileSync(
      new URL('../modules/diwan-downloader/android/src/main/java/com/diwan/downloader/DownloadEngine.kt', import.meta.url),
      'utf8',
    );
    for (const code of [
      'E_ENGINE_UPDATE',
      'E_DOWNLOADER_INIT',
      'E_CONVERTER_INIT',
      'E_ENGINE_UPDATE_NETWORK',
      'E_ENGINE_PACKAGE_INVALID',
      'E_ENGINE_PREFERENCE_WRITE',
    ]) {
      expect(engine).toContain(`"${code}"`);
    }
    expect(engine).toMatch(
      /YoutubeDL\.getInstance\(\)\.init\(context\)\s*\}\s*catch \(e: Exception\) \{\s*transfer\.check\(\)\s*android\.util\.Log\.e\("DiwanDownloader", "yt-dlp initialization failed", e\)\s*throw DownloadError\("E_DOWNLOADER_INIT"/,
    );
    expect(engine).toMatch(
      /FFmpeg\.getInstance\(\)\.init\(context\)\s*\}\s*catch \(e: Exception\) \{\s*transfer\.check\(\)\s*android\.util\.Log\.e\("DiwanDownloader", "FFmpeg initialization failed", e\)\s*throw DownloadError\("E_CONVERTER_INIT"/,
    );
    expect(engine).toContain('android.util.Log.e("DiwanDownloader", "Stable yt-dlp update failed", e)');
    expect(engine).toContain('current is UnknownHostException');
    expect(engine).toContain('current is SSLException');
    expect(engine).not.toMatch(/catch\s*\([^)]*Throwable/);
  });
});