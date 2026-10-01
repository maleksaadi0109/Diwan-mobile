import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.env.EAS_BUILD_PLATFORM === 'ios') {
  console.log('Skipping Android engine ZIP checks for iOS.');
  process.exit(0);
}

const sources = '../modules/diwan-downloader/android/src/main/java/com/diwan/downloader/';
const validator = fileURLToPath(new URL(`${sources}EngineZipValidation.java`, import.meta.url));
const tests = fileURLToPath(new URL('./EngineZipValidationHostTest.java', import.meta.url));
const asset = fileURLToPath(new URL(
  '../modules/diwan-downloader/android/src/main/assets/diwan-engine/yt-dlp',
  import.meta.url,
));
const output = mkdtempSync(join(tmpdir(), 'diwan-engine-zip-'));

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit', shell: false });
  if (result.error) throw new Error(`${command} is required for engine ZIP checks: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${command} failed with exit status ${result.status}`);
}

try {
  run('javac', ['-encoding', 'UTF-8', '-d', output, validator, tests]);
  run('java', ['-cp', output, 'com.diwan.downloader.EngineZipValidationHostTest', asset]);
} finally {
  rmSync(output, { recursive: true, force: true });
}