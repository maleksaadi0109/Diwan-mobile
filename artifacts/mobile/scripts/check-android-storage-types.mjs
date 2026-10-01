import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const suppliedJar = process.argv[2];
if (!suppliedJar || !existsSync(suppliedJar)) {
  throw new Error('Provide an official Android API 36 android.jar: pnpm run test:android-storage-types /path/to/android.jar');
}
const native = '../modules/diwan-downloader/android/src/main/java/com/diwan/downloader/';
const sources = ['DownloadStore.kt', 'StorageFailure.kt'].map((name) =>
  fileURLToPath(new URL(`${native}${name}`, import.meta.url)),
);
const support = fileURLToPath(new URL('./AndroidStorageTypecheckSupport.kt', import.meta.url));
const output = mkdtempSync(join(tmpdir(), 'diwan-android-storage-types-'));

try {
  const result = spawnSync('kotlinc', [
    '-classpath', resolve(suppliedJar), '-jvm-target', '17',
    '-d', output, support, ...sources,
  ], { stdio: 'inherit', shell: false });
  if (result.error) throw new Error(`Kotlin compiler required: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`Android storage typecheck failed: ${result.status}`);
  console.log('Production storage/errno code compiles against Android API 36 signatures.');
  console.log('This is a partial platform typecheck, not a full APK build or device test.');
} finally {
  rmSync(output, { recursive: true, force: true });
}