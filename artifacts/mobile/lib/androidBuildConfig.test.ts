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
      'E_ENGINE_INSTALL',
      'E_DOWNLOADER_INIT',
      'E_CONVERTER_INIT',
    ]) {
      expect(engine).toContain(`"${code}"`);
    }
    expect(engine).toMatch(
      /YoutubeDL\.getInstance\(\)\.init\(context\)\s*\}\s*catch \(e: Exception\) \{\s*transfer\.check\(\)\s*android\.util\.Log\.e\("DiwanDownloader", "yt-dlp initialization failed", e\)\s*throw DownloadError\("E_DOWNLOADER_INIT"/,
    );
    expect(engine).toMatch(
      /FFmpeg\.getInstance\(\)\.init\(context\)\s*\}\s*catch \(e: Exception\) \{\s*transfer\.check\(\)\s*android\.util\.Log\.e\("DiwanDownloader", "FFmpeg initialization failed", e\)\s*throw DownloadError\("E_CONVERTER_INIT"/,
    );
    expect(engine).toContain('PinnedEngine.recoverBeforeInit(context) { transfer.check() }');
    expect(engine).toContain('PinnedEngine.install(context) { transfer.check() }');
    expect(engine.indexOf('PinnedEngine.recoverBeforeInit(context)'))
      .toBeLessThan(engine.indexOf('YoutubeDL.getInstance().init(context)'));
    expect(engine.indexOf('YoutubeDL.getInstance().init(context)'))
      .toBeLessThan(engine.indexOf('FFmpeg.getInstance().init(context)'));
    expect(engine.indexOf('FFmpeg.getInstance().init(context)'))
      .toBeLessThan(engine.indexOf('ensureCurrentEngine(context, transfer)'));
    expect(engine).not.toMatch(/updateYoutubeDL|\.version\(context\)|getSharedPreferences/);
    expect(engine).not.toMatch(/UnknownHostException|SSLException|UpdateChannel/);
    expect(engine).not.toMatch(/catch\s*\([^)]*Throwable/);
  });

  it('pins and atomically verifies the APK zipapp without updater metadata or network access', () => {
    const installer = readFileSync(
      new URL('../modules/diwan-downloader/android/src/main/java/com/diwan/downloader/PinnedEngine.kt', import.meta.url),
      'utf8',
    );
    expect(installer).toContain('const val ASSET_PATH = "diwan-engine/yt-dlp"');
    expect(installer).toContain('const val VERSION = "2026.08.19"');
    expect(installer).toContain('const val EXPECTED_SIZE = 3_072_469L');
    expect(installer).toContain('const val MAX_SIZE = 8L * 1024 * 1024');
    expect(installer).toContain('const val SHA256 = "1fa6733c37ea6fb51c99ad8fe785e7b7e5f3246c9b980230329d4fb72ed8d4d6"');
    expect(installer).toContain('AtomicFile(engine).openRead()');
    expect(installer).toContain('atomic.startWrite()');
    expect(installer).toContain('atomic.finishWrite(output)');
    expect(installer).toContain('atomic.failWrite(output)');
    expect(installer).toContain('"__main__.py"');
    expect(installer).toContain('"yt_dlp/version.py"');
    expect(installer).toContain('"yt_dlp_ejs/yt/solver/core.min.js"');
    expect(installer).toContain('Regex("""__version__');
    expect(installer).not.toMatch(/updateYoutubeDL|UpdateChannel|https?:\/\/|browser_download_url/);
    expect(installer).not.toMatch(/catch\s*\([^)]*Throwable/);
  });
});